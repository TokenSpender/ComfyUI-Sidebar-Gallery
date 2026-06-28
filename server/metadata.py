from __future__ import annotations

import ast
import json
import math
import mimetypes
import os
import re
import shutil
import struct
import subprocess
import zlib
from dataclasses import dataclass
from typing import Any, Optional

from . import comfy_graph
from .schema import known_summary_keys


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Bump when the parser's output changes shape/coverage. Stored summaries are
# cached in the DB; on startup a mismatch triggers a background re-extraction
# so existing files pick up the new parser (see routes._check_parser_version).
# v3: graph-first source priority (A1111 text block merged after, per-field),
#     ConditioningZeroOut negative handling, sampler-detection tightening.
# v4: SaveVideo prompt/workflow tags read (LTX), runtime-output nodes
#     (GetImageSize…) stop scalar resolution, resize-node family normalized
#     into `upscaling`, generation_resolution derived from upscale factor.
# v5: generation resolution from PROMPT literals (links resolved through
#     slider/math chains); stale workflow widgets skipped for nodes whose
#     width/height are converted to links.
# v6: Forge/Forge-Neo detected from Version: stamp; slot-aware "WxH" combo
#     parsing for size links (SDXL Resolutions (JPS) etc.); dangling size
#     nodes ignored; SeedVR2-style upscalers get model + target resolution.
# v7: signature-driven redesign (server/comfy_graph.py): node roles classified
#     from ComfyUI's own registry (I/O types, categories) instead of name
#     patterns; linked values resolved only through PURE VALUE chains with
#     output slots matched by name (mxSlider2D X/Y, GetImageSize, JPS);
#     generation resolution from the pipeline model (latent source of the
#     first ACTIVE sampler; bypassed nodes and foreign-source switches yield
#     nothing); workflow widgets ignored for nodes that never executed.
# v8: ALL sampler params resolved from links (start/end_at_step etc.) — widget
#     value used only when there is no link; resolver learns rgthree Context
#     passthrough and Any-Switch first-connected-wins; disconnected leftover
#     nodes (no path to a save/output node, graphs without rgthree broadcasts)
#     dropped from the panel.
# v9: per-sampler shift — each sampler's model chain is traced to its
#     ModelSampling* node and its shift resolved (including slider/linked shift),
#     so MoE high/low passes show their own shift instead of one shared value.
# v10: a sampling pass that performs no denoising is dropped — an Advanced
#      KSampler whose start_at_step is at/after its last usable step (e.g. a
#      disabled refiner left at start_at_step == steps) returns its input latent
#      untouched, so a two-pass workflow with the 2nd pass disabled now shows a
#      single sampler instead of two.
# v11: workflow-node text fixes — the text resolver no longer follows non-text
#      links or descends into runtime LLM/VLM nodes (a SpeechBubble fed by an
#      LLaVA caption was resolving to the negative prompt); SimpleText.input_text
#      is recognized; display nodes (ShowText/…) are no longer pruned as dead, so
#      their shown text is captured.
# v12: the runtime LLM/VLM stop now runs BEFORE reading the node's own literal
#      prompt/system widgets (so a node fed by an LLM can't leak the instruction
#      text); a ShowText caption beginning with "[" (e.g. "[dog:cat:0.5]" or a tag
#      list) is no longer mistaken for a raw-metadata dump and dropped.
# v13: diffusion-model loaders (DiffusionModelLoaderKJ etc.) are recognized so the
#      base model is captured; duplicate LoRAs (same name+strength from parallel
#      loaders) are de-duplicated; LoRAs/models get a graph-topology HIGH/LOW role
#      (which sampler pass the loader feeds) so MoE pairing no longer guesses from
#      filenames/titles.
# v14: the same topology HIGH/LOW role is now also stamped on each sampler pass, so
#      the sampler cards pair high-noise vs low-noise too (not just LoRAs/models).
# v15: HIGH/LOW roles now require the high and low passes to use DIFFERENT base
#      models, so a single model split across two passes (split sampling / a
#      refiner on one model) is no longer mislabeled high/low; SamplerCustomAdvanced
#      reads steps/scheduler by walking through a sigma splitter (SplitSigmas, …)
#      instead of only the directly-wired sigmas node.
# v16: SamplerCustomAdvanced now resolves LINKED sub-node params (steps/cfg/seed
#      wired from a slider/math node, e.g. mxSlider) not just literals; and the
#      base model is resolved switch-aware — only the loader the samplers actually
#      use (the selected "Any Switch" branch) is reported, so an A/B model switch
#      no longer lists both pairs.
# v17: the model-chain walk follows switch/reroute nodes (rgthree Any Switch's
#      any_NN inputs), so a DiffusionModelLoader behind a switch is attributed to
#      its sampler pass — restoring the base model AND the topology HIGH/LOW split
#      for Wan2.2 SVI workflows. CLIP is resolved by following each active text
#      encoder's `clip` link to its real source instead of scanning every
#      CLIPLoader: a loader feeding a separate LLM/TextGenerate node is no longer
#      shown as the CLIP, a CLIP baked into the checkpoint shows nothing, and a
#      custom encoder leaf (an LLM used as the text encoder) is captured.
# v18: a generic node's `clip` link is resolved to its loader filename and kept as
#      a node param (workflow_nodes.<Node>.clip), so a node that USES a CLIP/text
#      encoder — e.g. a TextGenerate LLM fed by a CLIPLoader — exposes which model
#      it ran. Needed because v17 correctly scoped clip_models to the IMAGE's CLIP,
#      which removed the only source a TextGenerate/LLM panel section had.
PARSER_VERSION = 18

# Hard cap on any single captured node text/param string. "Show"/display nodes can
# be wired to dump enormous blobs (e.g. a 600KB+ JSON of another image's metadata);
# without this cap that blob is stored per-image and balloons the DB → slow search.
_NODE_TEXT_MAX = 4000


@dataclass(frozen=True)
class MetadataResult:
    prompt: Any | None
    workflow: Any | None
    parsed: dict[str, Any]
    raw_text: dict[str, str]
    summary: dict[str, Any]


# ── JSON / Serialization helpers ──────────────────────────────────────


def _json_best_effort(s: str) -> Any:
    try:
        return json.loads(s)
    except Exception:
        return s


def sanitize_for_json(obj: Any, _depth: int = 0) -> Any:
    """Recursively convert arbitrary Python objects into JSON-safe types."""
    if _depth > 40:
        return str(obj)
    if obj is None or isinstance(obj, bool):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            return str(obj)
        return obj
    if isinstance(obj, str):
        return obj
    if isinstance(obj, bytes):
        try:
            return obj.decode("utf-8", errors="replace")
        except Exception:
            return repr(obj)
    if isinstance(obj, dict):
        return {str(k): sanitize_for_json(v, _depth + 1) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_for_json(v, _depth + 1) for v in obj]
    # PIL IFDRational, numpy types, etc.
    try:
        f = float(obj)
        if math.isnan(f) or math.isinf(f):
            return str(obj)
        return f
    except Exception:
        pass
    try:
        return int(obj)
    except Exception:
        pass
    return str(obj)


# ── PNG chunk reader ──────────────────────────────────────────────────


def _decompress_limited(data: bytes, *, max_output_bytes: int) -> bytes:
    out = bytearray()
    d = zlib.decompressobj()
    chunk_size = 64 * 1024
    idx = 0
    while idx < len(data):
        piece = data[idx : idx + chunk_size]
        idx += chunk_size
        out_piece = d.decompress(piece, max_output_bytes - len(out))
        if out_piece:
            out.extend(out_piece)
        if len(out) >= max_output_bytes:
            break
        if d.eof:
            break
    return bytes(out)


def _decode_text_chunk_text(data: bytes) -> tuple[str | None, str | None]:
    try:
        keyword, text = data.split(b"\x00", 1)
    except ValueError:
        return None, None
    try:
        k = keyword.decode("latin-1", errors="replace")
    except Exception:
        k = None
    try:
        v = text.decode("utf-8", errors="replace")
    except Exception:
        v = text.decode("latin-1", errors="replace")
    return k, v


def _decode_ztxt(data: bytes, *, max_decompressed_bytes: int) -> tuple[str | None, str | None]:
    try:
        keyword, rest = data.split(b"\x00", 1)
        _compression_method = rest[0]
        compressed = rest[1:]
    except Exception:
        return None, None
    try:
        k = keyword.decode("latin-1", errors="replace")
    except Exception:
        k = None
    try:
        decompressed = _decompress_limited(compressed, max_output_bytes=max_decompressed_bytes)
        v = decompressed.decode("utf-8", errors="replace")
    except Exception:
        return k, None
    return k, v


def _decode_itxt(data: bytes, *, max_decompressed_bytes: int) -> tuple[str | None, str | None]:
    try:
        keyword, rest = data.split(b"\x00", 1)
        k = keyword.decode("latin-1", errors="replace")
        compression_flag = rest[0]
        _compression_method = rest[1]
        rest2 = rest[2:]
        _lang, rest3 = rest2.split(b"\x00", 1)
        _translated, text = rest3.split(b"\x00", 1)
    except Exception:
        return None, None

    try:
        if compression_flag == 1:
            decompressed = _decompress_limited(text, max_output_bytes=max_decompressed_bytes)
            v = decompressed.decode("utf-8", errors="replace")
        else:
            v = text.decode("utf-8", errors="replace")
    except Exception:
        v = None
    return k, v


def read_png_text_chunks(
    path: str,
    *,
    max_text_chunk_bytes: int,
    max_decompressed_text_bytes: int,
    stop_after_keys: set[str] | None = None,
) -> dict[str, str]:
    stop_after_keys = stop_after_keys or set()
    found: dict[str, str] = {}

    with open(path, "rb") as f:
        sig = f.read(8)
        if sig != PNG_SIGNATURE:
            return {}

        while True:
            header = f.read(8)
            if len(header) < 8:
                break
            length, ctype = struct.unpack(">I4s", header)
            ctype_s = ctype.decode("ascii", errors="replace")

            if ctype_s in {"tEXt", "zTXt", "iTXt"}:
                if length > max_text_chunk_bytes:
                    f.seek(length + 4, os.SEEK_CUR)
                    continue

                data = f.read(length)
                f.seek(4, os.SEEK_CUR)  # crc

                if ctype_s == "tEXt":
                    k, v = _decode_text_chunk_text(data)
                elif ctype_s == "zTXt":
                    k, v = _decode_ztxt(data, max_decompressed_bytes=max_decompressed_text_bytes)
                else:
                    k, v = _decode_itxt(data, max_decompressed_bytes=max_decompressed_text_bytes)

                if k and v is not None:
                    found.setdefault(k, v)

                if stop_after_keys and stop_after_keys.issubset(found.keys()):
                    break
            else:
                f.seek(length + 4, os.SEEK_CUR)

            if ctype_s == "IEND":
                break

    return found


# ── Source-app detection ──────────────────────────────────────────────


def _detect_source_app(parsed: dict, prompt: Any, workflow: Any) -> str:
    """Detect which WebUI generated the file.

    Returns one of: 'comfyui', 'a1111', 'forge', 'sdnext', 'fooocus', 'unknown'.
    """
    # ComfyUI: prompt dict with class_type keys
    if isinstance(prompt, dict):
        for v in prompt.values():
            if isinstance(v, dict) and "class_type" in v:
                return "comfyui"

    # A1111-family: check the 'parameters' text for App: field
    params_text = ""
    if isinstance(parsed, dict):
        pt = parsed.get("parameters")
        if isinstance(pt, str):
            params_text = pt

    if params_text:
        # SD.Next embeds "App: SD.Next"
        app_match = re.search(r"\bApp:\s*([^,\n]+)", params_text)
        if app_match:
            app_name = app_match.group(1).strip().lower()
            if "sd.next" in app_name or "sdnext" in app_name:
                return "sdnext"
            if "forge" in app_name:
                return "forge"
            if "fooocus" in app_name:
                return "fooocus"

        # Forge has no App: field but stamps its version: classic Forge writes
        # "Version: f2.0.1v1.10.1-…" (f-prefixed), Forge Neo "Version: neo-2.24".
        ver_match = re.search(r"\bVersion:\s*([^\s,]+)", params_text)
        if ver_match:
            ver = ver_match.group(1).strip().lower()
            if re.match(r"^f\d", ver) or ver.startswith("neo"):
                return "forge"

        # Standard A1111 has "Steps:" line
        if re.search(r"\bSteps:\s*\d+", params_text):
            return "a1111"

    # Fooocus: specific JSON structure with "Prompt" key at top level
    if isinstance(parsed, dict):
        if "Prompt" in parsed and "Negative Prompt" in parsed:
            return "fooocus"
        # Check for Fooocus-style comment JSON
        comment = parsed.get("comment")
        if isinstance(comment, dict) and "Prompt" in comment:
            return "fooocus"

    return "unknown"


# ── A1111 / Forge "parameters" text parser ────────────────────────────


def _parse_a1111_parameters(params_text: str) -> dict[str, Any]:
    """Parse A1111/Forge-style 'parameters' text into a structured dict.

    Handles multiple format variants:
    - Standard A1111: positive\\nNegative prompt: negative\\nSteps: ...
    - Separator variant: positive\\n---\\nnegative\\nSteps: ...
    - No negative prompt: positive\\nSteps: ...
    """
    result: dict[str, Any] = {}
    if not params_text or not isinstance(params_text, str):
        return result

    # Normalise line endings
    params_text = params_text.replace("\r\n", "\n").replace("\r", "\n")

    # ── Try standard "Negative prompt:" separator first ──
    neg_match = re.search(r"Negative prompt:\s*(.*)", params_text, re.DOTALL)
    if neg_match:
        positive = params_text[: neg_match.start()].strip()
        rest = neg_match.group(1)
        # Settings come after the last line that starts with known keys
        steps_match = re.search(r"\nSteps:\s*", rest)
        if steps_match:
            negative = rest[: steps_match.start()].strip()
            settings_str = rest[steps_match.start():].strip()
        else:
            # Try to find settings line: key: value, key: value
            lines = rest.strip().split("\n")
            if len(lines) > 1 and re.match(r"^[A-Z][^:]+:\s", lines[-1]):
                negative = "\n".join(lines[:-1]).strip()
                settings_str = lines[-1].strip()
            else:
                negative = rest.strip()
                settings_str = ""
    else:
        # ── Try "---" separator variant ──
        dash_match = re.search(r"\n\s*---+\s*", params_text)
        if dash_match:
            positive = params_text[: dash_match.start()].strip()
            rest = params_text[dash_match.end():].strip()
            steps_match = re.search(r"\nSteps:\s*", rest)
            if steps_match:
                negative = rest[: steps_match.start()].strip()
                settings_str = rest[steps_match.start():].strip()
            else:
                # Check if last line is a settings line
                lines = rest.split("\n")
                if len(lines) > 1 and re.match(r"^[A-Z][^:]+:\s", lines[-1]):
                    negative = "\n".join(lines[:-1]).strip()
                    settings_str = lines[-1].strip()
                else:
                    negative = rest.strip()
                    settings_str = ""
        else:
            # No negative prompt marker at all
            steps_match = re.search(r"\nSteps:\s*", params_text)
            if steps_match:
                positive = params_text[: steps_match.start()].strip()
                settings_str = params_text[steps_match.start():].strip()
            else:
                positive = params_text.strip()
                settings_str = ""
            negative = ""

    if positive:
        result["positive_prompt"] = positive
    if negative:
        result["negative_prompt"] = negative

    # Parse "Key: value, Key: value" settings
    if settings_str:
        # Pre-extract keys with quoted values (ControlNet, Lora hashes, TI, etc.)
        # These contain inner commas and key:value pairs that would confuse the main parser
        quoted_pattern = re.finditer(
            r'([A-Za-z][A-Za-z0-9 _/\-]*?):\s*"((?:[^"\\]|\\.)*)"',
            settings_str
        )
        quoted_keys = {}
        spans_to_remove = []
        for m in quoted_pattern:
            key = m.group(1).strip().lower().replace(" ", "_")
            quoted_keys[key] = m.group(2).strip()
            spans_to_remove.append((m.start(), m.end()))

        # Remove quoted sections from settings_str to prevent inner keys from leaking
        clean_str = settings_str
        for start, end in reversed(spans_to_remove):
            # Remove the matched section and any trailing comma
            trail = clean_str[end:].lstrip()
            if trail.startswith(","):
                end = end + (len(clean_str[end:]) - len(trail)) + 1
            clean_str = clean_str[:start] + clean_str[end:]

        # Store quoted keys first
        result.update(quoted_keys)

        # Now parse the remaining unquoted key-value pairs
        # Stop value capture at ", Key:" where Key can be any word characters (not just uppercase)
        kv_pattern = re.findall(r"([A-Za-z][A-Za-z0-9 _/\-]*?):\s*((?:[^,]|,(?!\s*[A-Za-z][A-Za-z0-9 _/\-]*?:\s))+)", clean_str)
        for k, v in kv_pattern:
            key = k.strip().lower().replace(" ", "_")
            val = v.strip().rstrip(",")
            result[key] = val

    return result


# ── Normalization: flat A1111/Forge/SD.Next → structured format ────────


def _safe_float(v: Any) -> float | None:
    """Try to convert a value to float, return None on failure."""
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None


def _safe_int(v: Any) -> int | None:
    """Try to convert a value to int, return None on failure."""
    if v is None:
        return None
    try:
        return int(float(v))  # handles "29.0" etc.
    except (ValueError, TypeError):
        return None


def _pop_first(d: dict[str, Any], *keys: str) -> Any:
    """Pop ALL of the given keys from d, returning the first non-None value.

    (A plain `d.pop(a) or d.pop(b)` short-circuits and leaves the alias key
    behind, where it would leak into 'extra'.)"""
    val = None
    for k in keys:
        v = d.pop(k, None)
        if val is None and v is not None:
            val = v
    return val


def _normalize_a1111_to_structured(summary: dict[str, Any]) -> None:
    """Convert flat A1111/Forge/SD.Next params into same structured format as ComfyUI.

    Mutates summary in-place. After this, summary will have:
    - samplers: list of structured sampler dicts
    - loras: list of structured lora dicts  
    - adetailer: list of structured adetailer dicts
    - resolution: from 'size' field
    - extra: dict of remaining WebUI-specific fields
    
    All raw flat keys are removed.
    """
    if summary.get("samplers"):
        return  # Already has structured samplers (ComfyUI path already ran)

    # ── Build structured sampler entry ────────────────────────
    sampler_name = _pop_first(summary, "sampler_name", "sampler")
    # Newer A1111 splits the scheduler into its own "Schedule type:" field.
    scheduler = _pop_first(summary, "scheduler", "schedule_type")
    steps = _safe_int(summary.pop("steps", None))
    cfg = _safe_float(_pop_first(summary, "cfg", "cfg_scale"))
    seed = summary.pop("seed", None)
    if seed is not None:
        seed = _safe_int(seed) if _safe_int(seed) is not None else seed
    denoise = _safe_float(_pop_first(summary, "denoise", "denoising_strength"))
    shift = _safe_float(summary.pop("shift", None))

    has_sampler_data = sampler_name or steps or cfg or seed
    if has_sampler_data:
        sampler_entry: dict[str, Any] = {}
        source_app = summary.get("source_app", "unknown")
        # Use source app display name as label (like ComfyUI uses "KSampler")
        _app_labels = {"a1111": "A1111", "forge": "Forge", "sdnext": "SD.Next", "fooocus": "Fooocus"}
        sampler_entry["label"] = _app_labels.get(source_app, "Sampler")
        if sampler_name:
            sampler_entry["sampler_name"] = str(sampler_name)
        if scheduler:
            sampler_entry["scheduler"] = str(scheduler)
        if steps is not None:
            sampler_entry["steps"] = steps
        if cfg is not None:
            sampler_entry["cfg"] = cfg
        if seed is not None:
            sampler_entry["seed"] = seed
        if denoise is not None:
            # Keep denoise even at 1.0 so it shows consistently on images, the same
            # way it already does for videos (which usually run denoise < 1.0).
            sampler_entry["denoise"] = denoise
        summary["samplers"] = [sampler_entry]

    # Move shift into sampler entry if present
    if shift is not None and summary.get("samplers"):
        summary["samplers"][0]["shift"] = shift

    # ── Normalize LoRAs to structured dicts ───────────────────
    loras = summary.get("loras")
    if loras and isinstance(loras, list):
        structured_loras = []
        for l in loras:
            if isinstance(l, dict) and "name" in l:
                structured_loras.append(l)  # Already structured
            elif isinstance(l, str):
                # Parse "Name (weight)" format from A1111 extraction
                m = re.match(r"^(.+?)\s*\(([^)]+)\)$", l)
                if m:
                    name = m.group(1).strip()
                    try:
                        strength = float(m.group(2))
                        structured_loras.append({"name": name, "strength_model": strength})
                    except ValueError:
                        structured_loras.append({"name": l})
                else:
                    structured_loras.append({"name": l})
        if structured_loras:
            summary["loras"] = structured_loras

    # ── Normalize ADetailer from flat fields ──────────────────
    # SD.Next format: detailer, detailer_steps, detailer_strength
    detailer_model = summary.pop("detailer", None)
    detailer_steps = _safe_int(summary.pop("detailer_steps", None))
    detailer_strength = _safe_float(summary.pop("detailer_strength", None))
    if detailer_model:
        ad_entry: dict[str, Any] = {"model": str(detailer_model)}
        if detailer_steps is not None:
            ad_entry["steps"] = detailer_steps
        if detailer_strength is not None:
            ad_entry["denoise"] = detailer_strength
        summary.setdefault("adetailer", []).append(ad_entry)

    # A1111 format: adetailer_model, adetailer_confidence, adetailer_model_2nd, etc.
    _ad_suffixes = ["", "_2nd", "_3rd", "_4th"]
    for suf in _ad_suffixes:
        ad_model_key = f"adetailer_model{suf}"
        ad_model = summary.pop(ad_model_key, None)
        if not ad_model:
            continue
        ad_entry = {"model": str(ad_model)}
        for fld, conv in [("adetailer_confidence", _safe_float),
                          ("adetailer_denoising_strength", _safe_float),
                          ("adetailer_mask_blur", _safe_int),
                          ("adetailer_dilate_erode", _safe_int),
                          ("adetailer_inpaint_padding", _safe_int),
                          ("adetailer_inpaint_only_masked", None)]:
            key = f"{fld}{suf}"
            val = summary.pop(key, None)
            if val is not None:
                short = fld.replace("adetailer_", "")
                ad_entry[short] = conv(val) if conv else val
        summary.setdefault("adetailer", []).append(ad_entry)
    # Clean up version/classes/prompt keys
    for k in list(summary.keys()):
        if k.startswith("adetailer_"):
            summary.pop(k, None)

    # ── Parse A1111-style ControlNet fields ────────────────────
    # A1111 stores ControlNet as: controlnet_0: "Module: X, Model: Y, Weight: Z, ..."
    # Also handles numbered variants: controlnet_1, controlnet_2, etc.
    for cn_idx in range(4):  # Up to 4 ControlNets
        cn_key = f"controlnet_{cn_idx}" if cn_idx > 0 else "controlnet_0"
        cn_raw = summary.pop(cn_key, None)
        if not cn_raw:
            if cn_idx == 0:
                # Also try just "controlnet_0" without checking further indices
                continue
            break
        cn_entry: dict[str, Any] = {}
        raw_str = str(cn_raw).strip().strip('"')
        # Parse "Key: Value, Key: Value" pairs within the ControlNet string
        # Use regex to find Key: Value pairs (Key may contain spaces)
        cn_pairs = re.findall(r'([A-Za-z][A-Za-z ]*?):\s*([^,]+?)(?:,\s*(?=[A-Z])|$)', raw_str)
        cn_map = {k.strip().lower().replace(' ', '_'): v.strip() for k, v in cn_pairs}
        if cn_map.get('model') and cn_map['model'].lower() != 'none':
            cn_entry['model'] = cn_map['model']
        if cn_map.get('module') and cn_map['module'].lower() != 'none':
            cn_entry['preprocessor'] = cn_map['module']
        for fld in ('weight', 'guidance_start', 'guidance_end', 'control_mode',
                    'resize_mode', 'processor_res', 'pixel_perfect', 'hr_option'):
            val = cn_map.get(fld)
            if val is not None:
                cn_entry[fld] = val
        if cn_entry:
            summary.setdefault('controlnet', []).append(cn_entry)
    # Also clean up any remaining controlnet-related flat keys from A1111
    for k in list(summary.keys()):
        if k.startswith('controlnet_') or k in ('control_mode', 'guidance_start', 'guidance_end',
                                                  'pixel_perfect', 'resize_mode', 'processor_res',
                                                  'threshold_a', 'threshold_b', 'weight', 'module_1',
                                                  'hr_option'):
            summary.pop(k, None)

    # ── Parse resolution from 'size' field ────────────────────
    size = summary.pop("size", None)
    if size and not summary.get("resolution"):
        if isinstance(size, str) and "x" in size.lower():
            summary["resolution"] = size.replace("x", "×").replace("X", "×")
            # Parse width/height for AR thumbnail support
            try:
                parts = size.lower().split("x")
                if len(parts) == 2:
                    summary.setdefault("width", int(parts[0].strip()))
                    summary.setdefault("height", int(parts[1].strip()))
            except (ValueError, TypeError):
                pass


# ── Enhanced summary extractor ────────────────────────────────────────


def _extract_summary(prompt: Any, workflow: Any, parsed: dict) -> dict[str, Any]:
    """Extract a comprehensive, human-readable summary from all available metadata sources.

    Uses a detect → normalize flow:
    1. Detect source app (comfyui, a1111, forge, sdnext, fooocus, unknown)
    2. Parse A1111-style parameters text (works for A1111/Forge/SD.Next)
    3. Normalize flat params into structured format (samplers, loras, adetailer)
    4. Overlay ComfyUI prompt graph data (more structured, fills in models/loras/etc.)
    5. Extract from workflow graph for any remaining fields
    """
    summary: dict[str, Any] = {}

    # Parse prompt/workflow JSON strings early so _detect_source_app can inspect them
    p = prompt
    if isinstance(p, str):
        try:
            p = json.loads(p)
        except Exception:
            p = None

    w = workflow
    if isinstance(w, str):
        try:
            w = json.loads(w)
        except Exception:
            w = None

    # Detect source application (using parsed prompt/workflow dicts)
    summary["source_app"] = _detect_source_app(parsed, p, w)

    # 1) Parse A1111/Forge-style "parameters" text into its OWN dict. It is
    #    merged AFTER graph extraction: many ComfyUI save nodes also embed an
    #    A1111-style text block, and that block is flatter (single sampler, no
    #    scheduler/denoise detail) and sometimes corrupted by saver mis-wiring.
    #    The graph is the primary structured source; the text block stays
    #    authoritative only for the final (wildcard-resolved) positive prompt.
    a1111: dict[str, Any] = {}
    if isinstance(parsed, dict):
        params_text = parsed.get("parameters")
        if isinstance(params_text, str) and params_text.strip():
            a1111 = _parse_a1111_parameters(params_text)
            if a1111:
                # Extract <lora:name:weight> from A1111 positive prompt
                pos = a1111.get("positive_prompt", "")
                if isinstance(pos, str):
                    lora_tags = re.findall(r"<lora:([^:>]+)(?::([^>]*))?>", pos)
                    if lora_tags:
                        loras = []
                        seen_tags: set[tuple[str, str]] = set()
                        for name, weight in lora_tags:
                            tag_key = (name.strip(), weight or "")
                            if tag_key in seen_tags:
                                continue  # same tag repeated in the prompt
                            seen_tags.add(tag_key)
                            entry: dict[str, Any] = {"name": name.strip()}
                            if weight:
                                try:
                                    entry["strength_model"] = float(weight)
                                except ValueError:
                                    pass
                            loras.append(entry)
                        a1111.setdefault("loras", loras)
                    # Strip LoRA tags from the A1111 prompt text —
                    # if the prompt is ONLY lora tags, remove it so the graph extractor sets the real prompt
                    cleaned_pos = re.sub(r'<lora:[^>]+>', '', pos).strip()
                    # Collapse multiple spaces/commas left behind by tag removal
                    cleaned_pos = re.sub(r',\s*,', ',', cleaned_pos).strip(' ,')
                    if not cleaned_pos:
                        a1111.pop("positive_prompt", None)
                    else:
                        a1111["positive_prompt"] = cleaned_pos

    # 2) Normalize flat A1111/Forge/SD.Next params to structured format
    if a1111:
        a1111["source_app"] = summary["source_app"]
        _normalize_a1111_to_structured(a1111)
        a1111.pop("source_app", None)

    # 3) ComfyUI prompt dict: walk all node inputs (PRIMARY source when present)
    if isinstance(p, dict):
        _extract_from_comfyui_prompt(p, summary)

    # 3b) Generation resolution from the pipeline model: the latent size
    #     entering the first ACTIVE sampler (dangling editing leftovers and
    #     runtime-measured sizes yield nothing instead of a wrong number).
    if isinstance(p, dict) and "resolution" not in summary:
        _gr = comfy_graph.find_generation_resolution(
            p, comfy_graph.get_registry(),
            legacy_dim_fn=lambda ref, axis: _resolve_dimension_ref(p, ref, axis))
        if _gr:
            summary["resolution"] = f"{_gr[0]}×{_gr[1]}"
            summary.setdefault("width", _gr[0])
            summary.setdefault("height", _gr[1])

    # 4) ComfyUI workflow graph: extract text prompts from CLIPTextEncode nodes.
    #    Nodes whose width/height are LINKED in the prompt keep a stale typed-in
    #    value in their workflow widgets — never trust those for resolution.
    linked_size_ids: set[str] = set()
    executed_ids: set[str] | None = None
    if isinstance(p, dict):
        executed_ids = {str(_nid) for _nid in p.keys()}
        for _nid, _nd in p.items():
            if isinstance(_nd, dict) and isinstance(_nd.get("inputs"), dict):
                _inp = _nd["inputs"]
                if isinstance(_inp.get("width"), list) or isinstance(_inp.get("height"), list):
                    linked_size_ids.add(str(_nid))
    if isinstance(w, dict) and "nodes" in w:
        _extract_from_comfyui_workflow(w, summary, linked_size_ids, executed_ids)

    # 5) Merge the parameters-text data into the graph-first summary
    _merge_a1111_summary(summary, a1111)

    # Set availability flags so summary_only responses can enable UI buttons
    if (isinstance(p, dict) and p) or (isinstance(prompt, str) and prompt.strip()):
        summary["has_prompt"] = True
    if (isinstance(w, dict) and w) or (isinstance(workflow, str) and workflow.strip()):
        summary["has_workflow"] = True

    # _node_id is kept on workflow_nodes entries: the layout editor uses it
    # (with title/_from) to address a specific node instance.

    # Final cleanup: sweep all unknown keys into 'extra'
    _final_summary_cleanup(summary)

    return summary


# Keys that are allowed to remain as top-level summary fields (everything else is
# swept into `extra`). This set is defined once in section_catalog.json and
# derived via server/schema.py.
_KNOWN_SUMMARY_KEYS = frozenset(known_summary_keys())


def _merge_a1111_summary(summary: dict[str, Any], a1111: dict[str, Any]) -> None:
    """Merge A1111-parameters-text fields into the (graph-first) summary.

    Per-field policy:
    - positive_prompt: the text block WINS — it stores the prompt after
      wildcard/dynamic-prompt resolution, which the graph often cannot give.
    - negative_prompt: graph wins; the text block only fills a gap, and is
      ignored when identical to the positive (a known saver mis-wiring that
      writes the positive text into the "Negative prompt:" line).
    - everything else (samplers, loras, model, hashes, …): graph wins, the
      text block fills gaps. For pure A1111/Forge/SD.Next files the graph
      contributes nothing, so the text block populates everything as before.
    """
    if not a1111:
        return
    pos_t = a1111.pop("positive_prompt", None)
    neg_t = a1111.pop("negative_prompt", None)
    if isinstance(pos_t, str) and pos_t.strip():
        summary["positive_prompt"] = pos_t.strip()
    if isinstance(neg_t, str) and neg_t.strip():
        if neg_t.strip() != (pos_t.strip() if isinstance(pos_t, str) else summary.get("positive_prompt")):
            summary.setdefault("negative_prompt", neg_t.strip())
    for k, v in a1111.items():
        if v is None:
            continue
        summary.setdefault(k, v)


def _final_summary_cleanup(summary: dict[str, Any]) -> None:
    """Sweep all unrecognized keys into the 'extra' dict.

    This runs AFTER both A1111 normalization and ComfyUI extraction,
    catching any stale flat keys from either path:
    - ComfyUI backward-compat: sampler_name, steps, cfg, scheduler, seed, denoise
    - A1111 LoRA hashes: lora_hashes, hashes, vae_hash, ti_hashes, ti
    - A1111 LoRA name hashes: pdxl_heijun_v1, illu_kunaboto_v1, etc.
    - schedule_type, sampler_sigma, etc.
    """
    # An "original" prompt identical to the final positive adds nothing.
    if summary.get("initial_prompt") and summary.get("initial_prompt") == summary.get("positive_prompt"):
        del summary["initial_prompt"]

    extra = summary.get("extra", {})
    if not isinstance(extra, dict):
        extra = {}

    for k in list(summary.keys()):
        if k not in _KNOWN_SUMMARY_KEYS:
            extra[k] = summary.pop(k)

    if extra:
        summary["extra"] = extra
    elif "extra" in summary:
        del summary["extra"]



def _resolve_ref(prompt: dict, ref: Any) -> dict | None:
    """Follow a ComfyUI node reference like ["7", 0] to the source node data."""
    if isinstance(ref, list) and len(ref) >= 1:
        node_id = str(ref[0])
        return prompt.get(node_id)
    return None


def _trace_model_shift(prompt: dict, model_ref: Any) -> float | None:
    """Walk a sampler's MODEL input chain to the nearest ModelSampling* node and
    return its `shift`, resolving a linked shift (e.g. a slider) to a scalar.

    MoE workflows (Wan2.2) run a high-noise and a low-noise pass with separate
    ModelSampling nodes, so resolving shift PER sampler lets the HIGH/LOW cards each
    show their own value instead of sharing one global shift. Returns None when no
    shift is found in the chain."""
    ref = model_ref
    seen: set[str] = set()
    for _ in range(16):  # bounded walk; real model chains are short
        if not (isinstance(ref, list) and len(ref) >= 1):
            return None
        nid = str(ref[0])
        if nid in seen:
            return None
        seen.add(nid)
        node = prompt.get(nid)
        if not isinstance(node, dict):
            return None
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return None
        ct = str(node.get("class_type", "")).lower()
        if "modelsampling" in ct and "shift" in inputs:
            shift = inputs.get("shift")
            if isinstance(shift, list):  # widget converted to a link (slider, math, …)
                shift = _resolve_scalar_smart(prompt, shift)
            return _safe_float(shift)
        # Follow the model input upstream (through LoRA loaders, patches, reroutes).
        nxt = inputs.get("model")
        if not isinstance(nxt, list):
            for _k in ("model1", "MODEL", "patched_model", "model_a"):
                if isinstance(inputs.get(_k), list):
                    nxt = inputs.get(_k)
                    break
        ref = nxt
    return None


def _collect_model_chain_nids(prompt: dict, model_ref: Any, max_depth: int = 24) -> list[str]:
    """Walk a sampler's MODEL input upstream (through LoRA loaders, patches,
    reroutes) and return every node id on the chain. Same traversal as
    _trace_model_shift, but it accumulates the loader/patcher nodes instead of a
    shift value — used to attribute each loader to the sampler pass it feeds."""
    nids: list[str] = []
    ref = model_ref
    seen: set[str] = set()
    for _ in range(max_depth):
        if not (isinstance(ref, list) and len(ref) >= 1):
            break
        nid = str(ref[0])
        if nid in seen:
            break
        seen.add(nid)
        nids.append(nid)
        node = prompt.get(nid)
        if not isinstance(node, dict):
            break
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            break
        nxt = inputs.get("model")
        if not isinstance(nxt, list):
            for _k in ("model1", "MODEL", "patched_model", "model_a"):
                if isinstance(inputs.get(_k), list):
                    nxt = inputs.get(_k)
                    break
        if not isinstance(nxt, list):
            # A model link routed through a switch/reroute carries no "model"-named
            # input (rgthree Any Switch uses any_01/any_02/…). Follow the selected
            # branch — the first connected input — so the walk reaches the loader
            # behind the switch (matches _walk_model_loaders / resolve_link). Without
            # this the chain dead-ends at the switch and a DiffusionModelLoader behind
            # it is never attributed to its sampler pass (the Wan2.2 "no model / no
            # HIGH-LOW" bug).
            ct = str(node.get("class_type", ""))
            ct_l = ct.lower()
            try:
                _role = comfy_graph.classify(ct, comfy_graph.get_registry().sig(ct))
            except Exception:
                _role = None
            if _role in ("switch", "reroute") or "switch" in ct_l or "reroute" in ct_l:
                for v in inputs.values():
                    if isinstance(v, list) and len(v) >= 1:
                        nxt = v
                        break
        ref = nxt
    return nids


def _compute_high_low_roles(prompt: dict, sampler_passes: list[dict],
                            model_loader_ids: dict[str, str]) -> dict[str, str]:
    """Tag the loader nodes feeding each sampler pass with a "high"/"low" role,
    derived purely from graph topology (no filename/title parsing).

    Genuine Wan2.2-style MoE runs a high-noise pass (start_at_step 0, adds noise,
    latent from an empty/created node) and a low-noise pass (starts later, no added
    noise, latent continued from the high pass) on TWO SEPARATE base models. We
    classify each pass, then REQUIRE the high and low passes to resolve to
    DIFFERENT base-model loaders — so a single model split across two passes
    (split-sampling, or a refiner on one model) is NOT mislabeled high/low — and
    only then attribute each pass's chain. Returns {loader_node_id: "high"|"low"},
    empty unless a real high/low split on separate base models is found; also
    stamps p["role"] on each pass (for the sampler cards). A loader feeding both
    sides is dropped as ambiguous."""
    if not sampler_passes:
        return {}
    sampler_nids = {p["nid"] for p in sampler_passes}

    def _role(p: dict) -> str:
        if str(p.get("add_noise")) == "disable":
            return "low"
        start = p.get("start")
        try:
            if start is not None and float(start) > 0:
                return "low"
        except (TypeError, ValueError):
            pass
        lat = p.get("latent_ref")
        if isinstance(lat, list) and lat and str(lat[0]) in sampler_nids:
            return "low"  # continues another sampler's latent
        return "high"

    roles = {p["nid"]: _role(p) for p in sampler_passes}
    if "high" not in roles.values() or "low" not in roles.values():
        return {}

    # Resolve each pass's MODEL chain once, and the base-model loader(s) on it.
    pass_chains = {p["nid"]: _collect_model_chain_nids(prompt, p.get("model_ref"))
                   for p in sampler_passes}
    hi_models: set[str] = set()
    lo_models: set[str] = set()
    for p in sampler_passes:
        models = {n for n in pass_chains[p["nid"]] if n in model_loader_ids}
        (hi_models if roles[p["nid"]] == "high" else lo_models).update(models)
    # Require a confirmed SEPARATE base model on each side. If a base model feeds
    # both sides, or a side has no resolvable base model (e.g. hidden behind a
    # switch), don't risk a false high/low label — fall back to name-based pairing.
    if not (hi_models and lo_models) or (hi_models & lo_models):
        return {}

    # Confirmed MoE: stamp each pass (for the sampler cards) and attribute the
    # loaders on each chain. The caller copies p["role"] onto samplers_found.
    for p in sampler_passes:
        p["role"] = roles[p["nid"]]
    role_map: dict[str, str] = {}
    conflicts: set[str] = set()
    for p in sampler_passes:
        r = roles[p["nid"]]
        for nid in pass_chains[p["nid"]]:
            if nid in role_map and role_map[nid] != r:
                conflicts.add(nid)
            else:
                role_map[nid] = r
    for nid in conflicts:
        role_map.pop(nid, None)
    return role_map


def _walk_model_loaders(prompt: dict, start_ref: Any, model_loader_ids: dict[str, str],
                        max_nodes: int = 96) -> set[str]:
    """BFS from a model link to the terminal model-loader node ids it actually
    feeds. At a SWITCH only the first connected input (the selected branch) is
    followed — matching comfy_graph.resolve_link's "first connected input wins" —
    so a switch's unselected branch is excluded. Reroutes pass through; every
    other node follows ALL its model-ish inputs (so model MERGES aren't lost)."""
    found: set[str] = set()
    queue: list = [start_ref]
    seen: set[str] = set()
    steps = 0
    while queue and steps < max_nodes:
        steps += 1
        ref = queue.pop(0)
        if not (isinstance(ref, list) and ref):
            continue
        nid = str(ref[0])
        if nid in seen:
            continue
        seen.add(nid)
        if nid in model_loader_ids:
            found.add(nid)
            continue
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        ct = str(node.get("class_type", ""))
        ct_l = ct.lower()
        try:
            role = comfy_graph.classify(ct, comfy_graph.get_registry().sig(ct))
        except Exception:
            role = None
        if role == "switch" or (role is None and "switch" in ct_l):
            for v in inputs.values():               # selected branch = first connected input
                if isinstance(v, list) and len(v) >= 1:
                    queue.append(v)
                    break
        elif role == "reroute" or "reroute" in ct_l:
            for v in inputs.values():
                if isinstance(v, list) and len(v) >= 1:
                    queue.append(v)
                    break
        else:
            for k in ("model", "model1", "model2", "model_a", "model_b",
                      "MODEL", "patched_model", "unet"):
                v = inputs.get(k)
                if isinstance(v, list) and len(v) >= 1:
                    queue.append(v)
    return found


def _resolve_active_model_loaders(prompt: dict, sampler_passes: list[dict],
                                  model_loader_ids: dict[str, str]) -> tuple[set[str], bool]:
    """Resolve the set of model-loader node ids the SAMPLERS actually use, walking
    switch-aware from each sampler's model source (its `model` input, or the
    `guider`'s model for custom samplers). Returns (active_ids, safe_to_filter):
    safe is True only when EVERY sampler resolved to at least one loader, so the
    caller never trims a model when a sampler's model path can't be followed."""
    active: set[str] = set()
    safe = True
    saw_any = False
    for p in sampler_passes:
        src = p.get("model_ref")
        if not isinstance(src, list):
            g = p.get("guider_ref")
            if isinstance(g, list):
                gn = _resolve_ref(prompt, g)
                if isinstance(gn, dict):
                    src = (gn.get("inputs") or {}).get("model")
        if not isinstance(src, list):
            safe = False           # a sampler whose model source we can't even find
            continue
        saw_any = True
        loaders = _walk_model_loaders(prompt, src, model_loader_ids)
        if loaders:
            active |= loaders
        else:
            safe = False           # couldn't reach a loader for this sampler
    return active, (safe and saw_any and bool(active))


# Model-file markers used to spot the filename param on a custom encoder/loader
# leaf node (e.g. a custom LLM-encoder node whose model param is a .gguf file).
_MODEL_FILE_EXTS = (".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".onnx")
# CLIP/encoder names that are taggers/captioners, not generation text-encoders.
_CLIP_TAGGER_PATTERNS = ("joytag", "joytagg", "florence", "blip", "tagger",
                         "captioner", "caption", "wd14", "recognize")
# Reference-input keys that carry a CLIP/text-encoder (resolved to the loader
# filename in generic node capture so a node shows which encoder it used).
_CLIP_INPUT_KEYS = {"clip", "clip_l", "clip_g", "clip1", "clip2"}


def _looks_like_model_file(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    return ("/" in v or "\\" in v) or v.lower().endswith(_MODEL_FILE_EXTS)


def _resolve_clip_source(prompt: dict, clip_ref: Any, max_nodes: int = 80) -> tuple[list[str], bool]:
    """Follow a text-encoder's `clip` link back to the loader(s) that supplied it.

    Returns (clip_names, baked_in). Walks passthroughs (clip/clip1/clip2, rgthree
    Context base_ctx/ctx, switch first-connected, reroute) to the terminal source:
      - a checkpoint loader            → CLIP is baked into the checkpoint, no
                                         separate file (baked_in=True, no name);
      - a CLIP loader                  → its clip_name / clip_name1..4;
      - a custom encoder leaf (no clip-ish ref input, e.g. a custom LLM encoder)
                                       → its first model-file-like string param.

    Reported instead of scanning every CLIPLoader, so a CLIPLoader feeding a
    separate LLM/TextGenerate node is NOT mistaken for the image's CLIP, and a
    custom-node CLIP (Z-Image's LLM text encoder) is found. Tagger/captioner
    names are filtered out."""
    names: list[str] = []
    baked = False
    queue: list = [clip_ref]
    seen: set[str] = set()
    steps = 0
    while queue and steps < max_nodes:
        steps += 1
        ref = queue.pop(0)
        if not (isinstance(ref, list) and ref):
            continue
        nid = str(ref[0])
        if nid in seen:
            continue
        seen.add(nid)
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        ct = str(node.get("class_type", ""))
        ct_l = ct.lower()
        # Terminal: CLIP baked into the checkpoint → no separate file.
        if "checkpointloader" in ct_l:
            baked = True
            continue
        # Terminal: explicit CLIP loaders.
        if ("cliploader" in ct_l or "dualcliploader" in ct_l
                or "tripleclip" in ct_l or "quadruplecliploader" in ct_l):
            for k in ("clip_name", "clip_name1", "clip_name2", "clip_name3", "clip_name4"):
                v = inputs.get(k)
                if isinstance(v, str) and v.strip():
                    names.append(v.strip())
            continue
        # Passthrough: follow clip-ish ref inputs first, then a Context bundle.
        followed = False
        for k in ("clip", "clip1", "clip2"):
            v = inputs.get(k)
            if isinstance(v, list) and len(v) >= 1:
                queue.append(v)
                followed = True
        if not followed:
            for k in ("base_ctx", "ctx", "context"):
                v = inputs.get(k)
                if isinstance(v, list) and len(v) >= 1:
                    queue.append(v)
                    followed = True
                    break
        if not followed:
            try:
                _role = comfy_graph.classify(ct, comfy_graph.get_registry().sig(ct))
            except Exception:
                _role = None
            if _role in ("switch", "reroute") or "switch" in ct_l or "reroute" in ct_l:
                for v in inputs.values():
                    if isinstance(v, list) and len(v) >= 1:
                        queue.append(v)
                        followed = True
                        break
        # Leaf custom encoder/loader: read a model-file-like string param.
        if not followed:
            for v in inputs.values():
                if _looks_like_model_file(v):
                    names.append(v.strip())
                    break
    out: list[str] = []
    for n in names:
        if any(t in n.lower() for t in _CLIP_TAGGER_PATTERNS):
            continue
        if n not in out:
            out.append(n)
    return out, baked


def _find_input_name_in_chain(prompt: dict, start_ref: Any, input_key: str, max_depth: int = 5) -> str | None:
    """Follow node references up to max_depth to find a string input value."""
    ref = start_ref
    for _ in range(max_depth):
        node = _resolve_ref(prompt, ref)
        if node is None:
            return None
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            return None
        val = inputs.get(input_key)
        if isinstance(val, str):
            return val
        # Check if this node has the value under a different common key
        for alt_key in ("control_net_name", "controlnet", "model_name", "ckpt_name", "lora_name"):
            val = inputs.get(alt_key)
            if isinstance(val, str):
                return val
        # Follow the chain: look for the same input type
        next_ref = inputs.get(input_key)
        if isinstance(next_ref, list):
            ref = next_ref
        else:
            break
    return None


def _find_preprocessor_in_chain(prompt: dict, start_ref: Any, max_depth: int = 8) -> str | None:
    """Follow the 'image' input chain to find a ControlNet preprocessor node.

    Handles AIO_Preprocessor (reads its 'preprocessor' string input),
    and follows through switch/reroute nodes by trying all reference inputs.
    """
    PREPROCESSOR_KEYWORDS = {
        "canny", "depth", "openpose", "lineart", "hed", "scribble", "tile",
        "shuffle", "pidinet", "midas", "zoe", "normalbae", "mlsd", "densepose",
        "dwpose", "mediapipe", "anyline", "teed", "segment", "binary", "color",
        "recolor", "metric3d", "dsine", "diffusion_edge", "preprocessor",
    }

    # BFS to handle switch nodes with multiple outputs
    queue: list[tuple[Any, int]] = [(start_ref, 0)]
    visited: set[str] = set()

    while queue:
        ref, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        node = _resolve_ref(prompt, ref)
        if node is None:
            continue

        # Track visited to avoid cycles
        ref_key = str(ref)
        if ref_key in visited:
            continue
        visited.add(ref_key)

        ct = node.get("class_type", "")
        ct_lower = ct.lower()
        inputs = node.get("inputs", {})

        # AIO_Preprocessor: read the 'preprocessor' string input for the real name
        if "aio_preprocessor" in ct_lower or "aux_preprocessor" in ct_lower:
            prep_name = inputs.get("preprocessor")
            if isinstance(prep_name, str) and prep_name.strip():
                return prep_name.strip()
            return ct  # fallback to class_type

        # Direct preprocessor node (e.g., CannyEdgePreprocessor, DWPreprocessor)
        for kw in PREPROCESSOR_KEYWORDS:
            if kw in ct_lower:
                return ct

        # Follow the chain: try 'image' first, then any reference inputs
        if isinstance(inputs, dict):
            # Priority: follow 'image' input
            img_ref = inputs.get("image")
            if isinstance(img_ref, list):
                queue.append((img_ref, depth + 1))
            # Also follow any other reference inputs (switch nodes: any_01, any_02, etc.)
            for key, val in inputs.items():
                if key == "image":
                    continue
                if isinstance(val, list) and len(val) >= 2:
                    queue.append((val, depth + 1))

    return None


# ── Common text input keys used across ComfyUI nodes ──────────────────
_TEXT_INPUT_KEYS = ("text", "string", "value", "text_positive", "text_negative",
                    "prompt", "text_input", "text_output", "text_0", "text_1",
                    "input_text")

# Link keys that carry NON-text data. The text resolver must not follow these:
# a node fed by both a text source and an image would otherwise wander up the
# image's chain into the sampler and return that generation's prompt (e.g. a
# SpeechBubble whose text comes from a runtime LLM was resolving to the negative
# prompt via the LLM's image input).
_NON_TEXT_LINK_KEYS = {
    "image", "images", "pixels", "model", "clip", "vae", "latent", "samples",
    "mask", "conditioning", "positive", "negative", "control_net", "controlnet",
    "control_image", "sigmas", "noise", "guider", "sampler", "audio",
    "clip_vision", "ipadapter", "style_model", "gligen", "upscale_model",
}

# Nodes whose text OUTPUT is generated at runtime (VLM/LLM captioners). Their
# output string is not in the saved file, so a text chain that reaches one stops
# there rather than descending into its inputs (which would surface its system/
# instruction prompt, or an unrelated upstream prompt). Recover the real output
# from the matching ShowText/display node's widgets_values instead.
_RUNTIME_TEXT_NODE_PATTERNS = ("llava", "vlm", "llamasampler", "joycaption",
                               "florence", "cogvlm", "minicpm", "internvl",
                               "qwenvl", "ollama", "promptenhancer",
                               "textgenerator", "llmsampler")


def _is_runtime_text_node(class_type: str) -> bool:
    ct = str(class_type).lower().replace(" ", "").replace("_", "")
    return any(p in ct for p in _RUNTIME_TEXT_NODE_PATTERNS)


def _resolve_text_recursive(prompt: dict, start_ref: Any, max_depth: int = 8) -> str | None:
    """Recursively follow node reference chains to find a text string value.

    Handles: Any Switch (rgthree), TextVersions, TextVersionsPro, ShowText,
    PrimitiveStringMultiline, String Literal, SimpleText, easy ifElse, Reroute,
    and any other node with common text keys.
    """
    queue: list[tuple[Any, int]] = [(start_ref, 0)]
    visited: set[str] = set()

    while queue:
        ref, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        node = _resolve_ref(prompt, ref)
        if node is None:
            continue

        ref_key = str(ref)
        if ref_key in visited:
            continue
        visited.add(ref_key)

        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue

        # A runtime text generator (LLaVA/LLM/captioner) produces its text when
        # the workflow runs — it is NOT in the file. Stop BEFORE reading its own
        # literal prompt/system widgets (a node fed by an LLM must not resolve to
        # the LLM's instruction prompt) and before descending into its inputs
        # (which would reach the generation's negative prompt). The real output
        # lives in a ShowText/display node's widgets_values, recovered separately.
        if _is_runtime_text_node(node.get("class_type", "")):
            continue

        # Check all common text keys for string values
        for txt_key in _TEXT_INPUT_KEYS:
            val = inputs.get(txt_key)
            if isinstance(val, str) and val.strip():
                return val

        # Follow only TEXT-ish reference inputs (switch/reroute/concat chains),
        # never image/model/conditioning links.
        for key, val in inputs.items():
            if str(key).lower() in _NON_TEXT_LINK_KEYS:
                continue
            if isinstance(val, list) and len(val) >= 2:
                queue.append((val, depth + 1))

    return None


# ── Scalar link resolution (numbers fed through slider/math/reroute chains) ──

_MATH_FUNCS: dict[str, Any] = {
    "min": min, "max": max, "abs": abs, "round": round,
    "floor": math.floor, "ceil": math.ceil,
}


def _safe_eval_expr(expr: str, variables: dict[str, int | float]) -> int | float | None:
    """Evaluate a simple arithmetic expression (MathExpression-style nodes)
    without eval()/compile(). Whitelisted AST only: numbers, the given
    variables, + - * / // % **, unary +/-, and min/max/abs/round/floor/ceil.
    Returns None on anything else, oversized input, or a non-finite result.
    """
    if not isinstance(expr, str) or not expr.strip() or len(expr) > 200:
        return None
    try:
        tree = ast.parse(expr, mode="eval")
    except (SyntaxError, ValueError, MemoryError, RecursionError):
        return None
    if sum(1 for _ in ast.walk(tree)) > 60:
        return None

    def ev(node: ast.AST) -> int | float:
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)) and not isinstance(node.value, bool):
                return node.value
            raise ValueError("non-numeric constant")
        if isinstance(node, ast.Name):
            if node.id in variables:
                return variables[node.id]
            raise ValueError("unknown name")
        if isinstance(node, ast.UnaryOp):
            v = ev(node.operand)
            if isinstance(node.op, ast.UAdd):
                return +v
            if isinstance(node.op, ast.USub):
                return -v
            raise ValueError("bad unary op")
        if isinstance(node, ast.BinOp):
            left, right = ev(node.left), ev(node.right)
            op = node.op
            if isinstance(op, ast.Add):
                return left + right
            if isinstance(op, ast.Sub):
                return left - right
            if isinstance(op, ast.Mult):
                return left * right
            if isinstance(op, ast.Div):
                return left / right
            if isinstance(op, ast.FloorDiv):
                return left // right
            if isinstance(op, ast.Mod):
                return left % right
            if isinstance(op, ast.Pow):
                # Bound to keep results sane and cheap
                if abs(right) > 16 or abs(left) > 1e6:
                    raise ValueError("pow out of bounds")
                return left ** right
            raise ValueError("bad binary op")
        if isinstance(node, ast.Call):
            if (not isinstance(node.func, ast.Name) or node.func.id not in _MATH_FUNCS
                    or node.keywords):
                raise ValueError("bad call")
            return _MATH_FUNCS[node.func.id](*[ev(a) for a in node.args])
        raise ValueError("disallowed syntax")

    try:
        result = ev(tree)
    except (ValueError, ZeroDivisionError, OverflowError, TypeError):
        return None
    if isinstance(result, bool) or not isinstance(result, (int, float)):
        return None
    if not math.isfinite(result) or abs(result) >= 1e12:
        return None
    return result


def _normalize_number(x: int | float) -> int | float:
    """16.0 → 16; long floats rounded to 4 decimals for display."""
    if isinstance(x, float):
        if x == int(x) and abs(x) < 1e12:
            return int(x)
        return round(x, 4)
    return x


# Math/evaluate nodes whose output we can compute from their expression input.
_MATH_NODE_PATTERNS = ("mathexpression", "simplemath", "mathformula",
                       "evaluateinteger", "evaluatefloat")
_MATH_EXPR_KEYS = ("expression", "expr", "formula", "python_expression")


def _is_math_node(class_type: str) -> bool:
    ct = str(class_type).lower().replace(" ", "").replace("_", "")
    return any(p in ct for p in _MATH_NODE_PATTERNS)


def _eval_math_node(prompt: dict, node: dict, max_depth: int = 8) -> int | float | None:
    """Compute a math-expression node's output: resolve its a/b/c variable
    inputs (following links), then safely evaluate the expression string."""
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        return None
    expr = None
    for k in _MATH_EXPR_KEYS:
        v = inputs.get(k)
        if isinstance(v, str) and v.strip():
            expr = v.strip()
            break
    if expr is None:
        return None
    # Variable inputs may be plain ("a") or prefixed ("values.a" in
    # ComfyMathExpression) — match on the last dot-segment.
    variables: dict[str, int | float] = {}
    for k, v in inputs.items():
        name = str(k).rsplit(".", 1)[-1].lower()
        if name not in ("a", "b", "c", "d") or name in variables:
            continue
        if isinstance(v, list) and len(v) >= 1 and max_depth > 0:
            v = _resolve_scalar_ref(prompt, v, max_depth=max_depth - 1)
        if isinstance(v, bool):
            v = int(v)
        if isinstance(v, (int, float)):
            variables[name] = v
    result = _safe_eval_expr(expr, variables)
    return None if result is None else _normalize_number(result)


# Value-ish input keys checked (in priority order) when resolving a link
# back to a concrete literal.
_SCALAR_VALUE_KEYS = ("value", "Value", "int", "float", "number", "num",
                      "seed", "noise_seed", "steps", "cfg", "fps",
                      "Xi", "Xf", "x", "text", "string")

# Preferred pass-through inputs when traversing reroute/switch/get-set nodes.
_PASSTHROUGH_PRIORITY_KEYS = ("value", "input", "any", "any_01", "source", "signal")

# Input names that carry tensors/objects (model, latent, conditioning, …) —
# never worth resolving to a scalar, skip the BFS entirely.
_NON_SCALAR_INPUT_KEYS = {
    "model", "clip", "vae", "latent", "latent_image", "samples", "image", "images",
    "conditioning", "mask", "audio", "sigmas", "noise", "guider", "sampler",
    "pipe", "basic_pipe", "detailer_pipe", "control_net", "controlnet",
    "model_high_noise", "model_low_noise", "clip_vision", "clip_vision_output",
    "start_image", "end_image", "reference_image", "upscale_model",
    "bbox_detector", "sam_model_opt", "segm_detector_opt", "hook_kf", "lora_stack",
    "positive", "negative",
}

# Nodes whose outputs are computed AT RUNTIME from their inputs (image/video
# measurements). Their value cannot be known from the stored workflow — a
# chain that reaches one must stop and report nothing, NOT walk past it to an
# unrelated upstream literal (e.g. WanImageToVideo.width linked to
# GetImageSize used to "resolve" to whatever number sat above the image).
_RUNTIME_OUTPUT_NODE_PATTERNS = (
    "getimagesize", "getresolution", "getvideoinfo", "getimagesizeandcount",
    "imagesizetonumber", "getlatentsize", "imagedimensions",
)


def _is_runtime_output_node(class_type: str) -> bool:
    ct = str(class_type).lower().replace(" ", "").replace("_", "")
    return any(p in ct for p in _RUNTIME_OUTPUT_NODE_PATTERNS)


def _resolve_scalar_smart(prompt: dict, ref: Any) -> int | float | str | bool | None:
    """Resolve a linked scalar with the signature-aware pure-value resolver;
    fall back to the legacy BFS only when the chain crosses node types the
    registry doesn't know (uninstalled packs in old files)."""
    r = comfy_graph.resolve_link(prompt, ref, comfy_graph.get_registry())
    if r is comfy_graph.UNKNOWN:
        return _resolve_scalar_ref(prompt, ref)
    if r is comfy_graph.UNRESOLVED:
        return None
    return r


def _resolve_scalar_ref(prompt: dict, start_ref: Any, max_depth: int = 8) -> int | float | str | bool | None:
    """Follow a node reference chain to a concrete scalar value.

    Math-expression nodes are evaluated to their computed output (so e.g.
    slider → MathExpression → WanImageToVideo.fps resolves to the FINAL fps).
    Reroute/switch/converter nodes are passed through (BFS, cycle-safe).
    If no value-ish key is found, falls back to the first literal seen
    anywhere along the chain, else None.
    """
    queue: list[tuple[Any, int]] = [(start_ref, 0)]
    visited: set[str] = set()
    fallback: int | float | str | bool | None = None

    while queue:
        ref, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        node = _resolve_ref(prompt, ref)
        if node is None:
            continue
        ref_key = str(ref)
        if ref_key in visited:
            continue
        visited.add(ref_key)

        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            continue

        # Runtime-measured nodes (GetImageSize etc.): the real value is not in
        # the file. Stop this branch — returning an upstream literal would be
        # a confidently wrong number.
        if _is_runtime_output_node(node.get("class_type", "")):
            continue

        # Math nodes: the chain's value IS the computed expression result.
        if _is_math_node(node.get("class_type", "")):
            result = _eval_math_node(prompt, node, max_depth=max_depth - depth)
            if result is not None:
                return result
            # eval failed → fall through to this node's inputs (nearest literal)

        # A literal under a value-ish key wins immediately.
        for k in _SCALAR_VALUE_KEYS:
            v = inputs.get(k)
            if isinstance(v, (bool, int, float)):
                return v
            if isinstance(v, str) and v.strip():
                return v if len(v) <= 500 else v[:500]

        # First literal under ANY key: weak fallback if the BFS exhausts.
        if fallback is None:
            for v in inputs.values():
                if isinstance(v, (bool, int, float)):
                    fallback = v
                    break
                if isinstance(v, str) and v.strip():
                    fallback = v if len(v) <= 500 else v[:500]
                    break

        # Pass through: preferred keys first, then any other reference inputs.
        for k in _PASSTHROUGH_PRIORITY_KEYS:
            v = inputs.get(k)
            if isinstance(v, list) and len(v) >= 1:
                queue.append((v, depth + 1))
        for k, v in inputs.items():
            if k in _PASSTHROUGH_PRIORITY_KEYS:
                continue
            if isinstance(v, list) and len(v) >= 1:
                queue.append((v, depth + 1))

    return fallback


# Shared with comfy_graph (identical WxH-combo pattern) so the legacy and
# signature-driven resolvers can't diverge on what counts as a dimension string.
_DIM_STRING_RE = comfy_graph._DIM_STRING_RE


def _resolve_dimension_ref(prompt: dict, ref: Any, axis: int) -> int | None:
    """Resolve a linked width/height input to a number.

    axis: 0 = width, 1 = height. Resolution-picker nodes (SDXL Resolutions
    (JPS), CR Aspect Ratio, …) hold one combo STRING like "portrait -
    832x1216 (2:3)" and output (width, height) on separate slots — parse the
    string and pick the side indicated by the link's output slot.
    """
    v = _resolve_scalar_ref(prompt, ref)
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return int(v)
    slot = ref[1] if (isinstance(ref, list) and len(ref) > 1 and isinstance(ref[1], int)) else axis
    if isinstance(v, str):
        m = _DIM_STRING_RE.search(v)
        if m:
            return int(m.group(1 if slot == 0 else 2))
    node = _resolve_ref(prompt, ref)
    if isinstance(node, dict) and isinstance(node.get("inputs"), dict):
        for sv in node["inputs"].values():
            if isinstance(sv, str):
                m = _DIM_STRING_RE.search(sv)
                if m:
                    return int(m.group(1 if slot == 0 else 2))
    return None


def _chain_reaches(prompt: dict, start_ref: Any, patterns: tuple[str, ...], max_depth: int = 12) -> bool:
    """BFS upstream through reference inputs: True if the chain contains a node
    whose class_type matches any pattern. Used to tell POST-generation resizes
    (image path comes out of a VAEDecode / model upscaler) from input-prep
    resizes (load image → resize → encode), which aren't upscaling output."""
    queue: list[tuple[Any, int]] = [(start_ref, 0)]
    visited: set[str] = set()
    while queue:
        ref, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        node = _resolve_ref(prompt, ref)
        if node is None:
            continue
        key = str(ref[0]) if isinstance(ref, list) else str(ref)
        if key in visited:
            continue
        visited.add(key)
        ct = str(node.get("class_type", "")).lower().replace(" ", "").replace("_", "")
        if any(p in ct for p in patterns):
            return True
        inputs = node.get("inputs", {})
        if isinstance(inputs, dict):
            for v in inputs.values():
                if isinstance(v, list) and len(v) >= 1:
                    queue.append((v, depth + 1))
    return False


_VLM_ENHANCER_PATTERNS = ("llava", "vlm", "prompt_enhancer", "promptenhancer",
                          "llamasampler", "llm", "florence", "joycaption",
                          "cogvlm", "minicpm", "internvl", "qwenvl",
                          "textgenerator", "ollamagenerate",
                          "promptexpand", "promptrefine",
                          "gemini", "chatgpt", "claude", "openai",
                          "llmsampler", "enhanceprompt", "improve_prompt",
                          "stylize_prompt", "rewrite_prompt")


def _find_enhancer_in_chain(prompt: dict, start_ref: Any, max_depth: int = 6) -> dict | None:
    """Recursively trace through node reference chains to find a VLM/LLM/PromptEnhancer node.

    Handles intermediate nodes like Any Switch, Reroute, If/Else nodes, etc.
    Returns the enhancer node dict if found, else None.
    """
    queue: list[tuple[Any, int]] = [(start_ref, 0)]
    visited: set[str] = set()

    while queue:
        ref, depth = queue.pop(0)
        if depth > max_depth:
            continue
        node = _resolve_ref(prompt, ref)
        if node is None or not isinstance(node, dict):
            continue
        node_id = str(ref[0]) if isinstance(ref, list) else ""
        if node_id in visited:
            continue
        visited.add(node_id)

        ct_lower = (node.get("class_type") or "").lower()

        # Check if this node IS a VLM/enhancer
        if any(p in ct_lower for p in _VLM_ENHANCER_PATTERNS):
            return node

        # Otherwise, follow all reference inputs to check deeper
        inputs = node.get("inputs", {})
        if isinstance(inputs, dict):
            for key, val in inputs.items():
                if isinstance(val, list) and len(val) >= 2:
                    queue.append((val, depth + 1))

    return None


def _find_enhancer_initial_prompt(prompt: dict, text_ref: Any) -> str | None:
    """Find the user's initial prompt if a prompt enhancer is in the reference chain.

    Recursively traces through intermediate nodes (Any Switch, Reroute, etc.) to find
    VLM/LLM/PromptEnhancer nodes. When found, extracts the user's original prompt text.

    Strategy:
    1. Check the enhancer node's own inputs for a prompt text.
    2. If that fails (e.g., subgraph workflows where text is passed externally),
       trace through intermediate switch/router nodes and check their OTHER inputs
       for the original user prompt.

    Returns the initial prompt string or None.
    """
    enhancer_node = _find_enhancer_in_chain(prompt, text_ref)
    if enhancer_node is None:
        return None

    # Strategy 1: Check the enhancer node's own inputs for user prompt text
    ref_inputs = enhancer_node.get("inputs", {})
    _PROMPT_KEYS = ("user_prompt", "prompt_text", "prompt", "text", "question",
                    "instruction", "system_message", "input_text", "content")
    for pk in _PROMPT_KEYS:
        pv = ref_inputs.get(pk)
        if isinstance(pv, str) and pv.strip() and len(pv.strip()) > 5:
            return pv.strip()
        elif isinstance(pv, list):
            # Follow reference for the initial prompt
            resolved_init = _resolve_text_recursive(prompt, pv)
            if resolved_init and len(resolved_init.strip()) > 5:
                return resolved_init.strip()

    # Strategy 2: The enhancer's prompt input was empty (common in subgraph workflows).
    # Trace the reference chain from text_ref and find switch/router nodes.
    # When a switch is found with an enhancer on one path, the OTHER path(s)
    # likely carry the original user prompt.
    _SWITCH_PATTERNS = ("switch", "reroute", "ifelse", "if_else", "selector",
                        "mux", "router", "choose")
    queue: list[tuple[Any, int]] = [(text_ref, 0)]
    visited: set[str] = set()

    while queue:
        ref, depth = queue.pop(0)
        if depth >= 6:
            continue
        node = _resolve_ref(prompt, ref)
        if node is None or not isinstance(node, dict):
            continue
        node_id_str = str(ref[0]) if isinstance(ref, list) else ""
        if node_id_str in visited:
            continue
        visited.add(node_id_str)

        ct_lower = (node.get("class_type") or "").lower()
        inputs_dict = node.get("inputs", {})
        if not isinstance(inputs_dict, dict):
            continue

        # Check if this is a switch/router node
        is_switch = any(p in ct_lower for p in _SWITCH_PATTERNS)
        if is_switch:
            # Collect all reference inputs from the switch
            ref_inputs_list: list[tuple[str, Any]] = []
            for key, val in inputs_dict.items():
                if isinstance(val, list) and len(val) >= 2:
                    ref_inputs_list.append((key, val))

            # Check which paths go to the enhancer and which don't
            for key, ref_val in ref_inputs_list:
                enhancer_on_path = _find_enhancer_in_chain(prompt, ref_val, max_depth=4)
                if enhancer_on_path is not None:
                    continue  # Skip the enhanced path
                # This is a non-enhanced path — try to resolve text from it
                resolved = _resolve_text_recursive(prompt, ref_val)
                if resolved and len(resolved.strip()) > 5:
                    return resolved.strip()

        # Follow all reference inputs deeper
        for key, val in inputs_dict.items():
            if isinstance(val, list) and len(val) >= 2:
                queue.append((val, depth + 1))

    return None


def _sampler_runs_no_steps(info: dict[str, Any]) -> bool:
    """True when an Advanced KSampler's step window is empty, so it performs no
    denoising and was not actually part of how the image was made.

    ComfyUI's KSamplerAdvanced builds a sigma schedule for ``steps``, truncates
    it at ``end_at_step``, then begins at ``start_at_step``; when
    ``start_at_step >= min(end_at_step, steps)`` the node just returns its input
    latent untouched. The common case is a disabled refiner pass left at
    ``start_at_step == steps`` (e.g. start_at_step=9 with a 9-step schedule).

    Conservative: fires only when start_at_step AND a real step bound are known,
    so a plain KSampler (no start_at_step) is never dropped.
    """
    def _num(x: Any) -> int | float | None:
        return x if isinstance(x, (int, float)) and not isinstance(x, bool) else None

    start = _num(info.get("start_at_step"))
    if start is None:
        return False
    last = _num(info.get("steps"))
    end = _num(info.get("end_at_step"))
    if end is not None:
        last = end if last is None else min(last, end)
    if last is None:
        return False
    return start >= last


def _extract_from_comfyui_prompt(prompt: dict, summary: dict):
    """Walk ComfyUI API-format prompt (dict of node_id -> {class_type, inputs}).

    Produces structured per-category collections for rich metadata display.
    """
    samplers_found: list[dict] = []
    models_found: list[str] = []
    # CLIP is resolved by following each active text-encoder's `clip` link to its
    # real source (see _resolve_clip_source), not by scanning every CLIPLoader.
    active_clip_refs: list = []
    loras_found: list[dict] = []
    controlnets_found: list[dict] = []
    adetailers_found: list[dict] = []
    positive_texts: list[tuple[str, str]] = []  # (node_id, text)
    negative_texts: list[tuple[str, str]] = []
    initial_prompts: list[str] = []  # For prompt enhancer detection (user's original prompt)
    upscaling_found: list[dict] = []
    interpolation_found: list[dict] = []
    mmaudio_info: dict | None = None
    # Side-data for topology-based HIGH/LOW role tagging (Wan2.2-style MoE): which
    # node id loaded each base model, and each sampler pass with the step range +
    # model/latent links needed to tell the high-noise pass from the low-noise one.
    model_loader_ids: dict[str, str] = {}     # node_id -> model name
    sampler_passes: list[dict] = []           # {nid, start, add_noise, model_ref, latent_ref}
    diffusion_model_candidates: list = []     # (node_id, name); promoted only if it feeds a sampler

    # Pre-scan: Identify negative text nodes by tracing backwards from any "negative" inputs
    # This traces recursively through conditioning chains (ConditioningCombine, etc.)
    # Positive chains are traced symmetrically — a text node reached from BOTH sides
    # (e.g. one encode wired to positive and negative) counts as positive.
    negative_node_ids: set[str] = set()
    positive_node_ids: set[str] = set()
    _NEG_INPUT_NAMES = {"negative", "cond_negative", "negative_conditioning", "neg_conditioning"}

    # Node types that produce text (should be marked negative if in negative chain)
    _TEXT_PRODUCER_TYPES = {"cliptextencode", "textencode", "cliptextencodeflux",
                           "cliptextencodesd3", "cliptextencodehunyuan",
                           "bnk_cliptextencodeadvanced", "cliptextencodeflux"}

    # Input names that are known to carry POSITIVE conditioning — never follow these
    # when tracing negative chains, or the positive CLIPTextEncode gets misclassified.
    _POSITIVE_INPUT_NAMES = {"positive", "cond_positive", "positive_conditioning",
                             "pos_conditioning", "cond"}

    def _trace_cond_chain(nid_str: str, mark: set[str], skip_names: set[str],
                          visited: set[str] | None = None) -> None:
        """Recursively trace node reference chains to find text-encode nodes feeding
        a conditioning input, marking them in `mark`."""
        if visited is None:
            visited = set()
        if nid_str in visited:
            return
        visited.add(nid_str)
        ndata = prompt.get(nid_str)
        if not isinstance(ndata, dict):
            return
        ct_raw = ndata.get("class_type") or ""
        ct = ct_raw.lower().replace(" ", "").replace("_", "")
        _role = comfy_graph.classify(ct_raw, comfy_graph.get_registry().sig(ct_raw))
        # ConditioningZeroOut erases the conditioning — the standard Flux/Qwen
        # CFG=1 pattern feeds the POSITIVE encode through it into the negative
        # input. Whatever text sits upstream is NOT a prompt for this side.
        if _role == "zero_conditioning" or "zeroout" in ct:
            return
        # Only mark text-producing nodes — NOT intermediate conditioning nodes
        if _role == "text_encode" or (_role is None and any(tp in ct for tp in _TEXT_PRODUCER_TYPES)):
            mark.add(nid_str)
            # Once we find a text producer, don't recurse further (it's a leaf in our search)
            return
        inp = ndata.get("inputs", {})
        if not isinstance(inp, dict):
            return
        # Follow reference-type inputs to trace upstream text nodes,
        # but SKIP the other side's inputs to avoid cross-contamination.
        for key, val in inp.items():
            if key.lower() in skip_names:
                continue
            if isinstance(val, list) and len(val) >= 1:
                _trace_cond_chain(str(val[0]), mark, skip_names, visited)

    for nid, ndata in prompt.items():
        if isinstance(ndata, dict) and "inputs" in ndata and isinstance(ndata["inputs"], dict):
            for neg_name in _NEG_INPUT_NAMES:
                neg_ref = ndata["inputs"].get(neg_name)
                if isinstance(neg_ref, list) and len(neg_ref) >= 1:
                    _trace_cond_chain(str(neg_ref[0]), negative_node_ids, _POSITIVE_INPUT_NAMES)
            for pos_name in _POSITIVE_INPUT_NAMES:
                pos_ref = ndata["inputs"].get(pos_name)
                if isinstance(pos_ref, list) and len(pos_ref) >= 1:
                    _trace_cond_chain(str(pos_ref[0]), positive_node_ids, _NEG_INPUT_NAMES)

    # Pre-scan: map ControlNet loader node_ids to model names (order-independent)
    cn_loader_map: dict[str, str] = {}
    for nid, ndata in prompt.items():
        if not isinstance(ndata, dict):
            continue
        ct = (ndata.get("class_type") or "").lower()
        inp = ndata.get("inputs", {})
        if not isinstance(inp, dict):
            continue
        if "controlnetloader" in ct or "diffcontrolnetloader" in ct or "modelpatchloader" in ct:
            for key in ("control_net_name", "controlnet", "name"):
                val = inp.get(key)
                if isinstance(val, str) and val.strip():
                    cn_loader_map[nid] = val
                    break

    # Pre-scan: reverse link map for connection context. upstream_src maps a
    # node to the source of its first reference input; feeds_map maps a node to
    # the "<TargetTitleOrType>.<input>" slots that consume its outputs. Used to
    # disambiguate node instances (e.g. a ShowAny displaying an LLM output vs
    # one displaying a scheduler name).
    upstream_src: dict[str, str] = {}
    feeds_map: dict[str, list[str]] = {}
    for nid, ndata in prompt.items():
        if not isinstance(ndata, dict):
            continue
        inp = ndata.get("inputs", {})
        if not isinstance(inp, dict):
            continue
        target_label = (str(ndata.get("_meta", {}).get("title", "")).strip()
                        or str(ndata.get("class_type", "")))
        for key, val in inp.items():
            if isinstance(val, list) and len(val) >= 1:
                src = str(val[0])
                upstream_src.setdefault(nid, src)
                feeds_map.setdefault(src, []).append(f"{target_label}.{key}")

    # Generic node collection — captures ALL node params not handled by specific extractors
    generic_nodes: list[dict[str, Any]] = []

    # Display/show nodes: their meaning comes from what feeds them, so they
    # always get upstream (_from) context.
    _DISPLAY_NODE_PATTERNS = ("showtext", "showany", "showanything", "displayany",
                              "showstring", "displaytext", "previewany")

    # Nodes to SKIP in generic capture (utility/infrastructure, no useful params,
    # OR already handled by dedicated extractors above)
    _SKIP_GENERIC_TYPES = {
        # Utility / infrastructure
        "vaedecode", "vaeencode", "previewimage", "saveimage", "loadimage",
        "emptylatentimage", "emptysd3latentimage",
        "reroute", "unloadmodel", "ramcleanup",
        "easycleangpuused", "easyclearcacheall", "easyconvertanything",
        "imagefrombatch", "localmediamanagernode",
        # Routing / passthrough — no generation-relevant params. (Display nodes
        # like ShowText/DisplayAny ARE captured: they carry the shown value and
        # upstream context. Math nodes are captured with their computed result.)
        "anyswitchrgthree", "anythingeverywhere", "anythingswitchrgthree",
        "note",
        "primitivestringmultiline", "primitivestringsimple", "primitiveboolean",
        "primitiveinteger", "primitivefloat",
        "df_text", "df_integer", "df_float",
        "textversionspro", "textversions", "stringliteral", "simpletext",
        "easyifelsestring", "easyifelse",
        # Sampler sub-nodes (data already captured by SamplerCustomAdvanced resolver)
        "ksamplerselect", "basicscheduler", "randomnoise", "disablenoise",
        "basicguider", "cfgguider", "dualcfgguider", "splitsigmas",
        # Already handled by dedicated extractors (set _is_handled=True)
        "cliptextencode", "cliptextencodesdxl", "cliptextencodesdxlrefiner",
        "controlnetloader", "diffcontrolnetloader", "setunioncontrolnettype",
        "modelpatchloader",
        "upscalemodelloader",
        "modelsamplingflux", "modelsamplingsd3", "modelsamplingdiscrete",
        "modelsamplingauraflow", "modelsampling",
        "clipsetlastlayer",
        # Resolution / resize nodes (actual resolution from media file, not workflow)
        "sdxlresolutionsjps", "getresolutioncrystools", "getimagesize",
        "jwimageresizelongerside", "jwimageresizebylongerside",
        "imagescaleby", "imagescale", "batchresizewithlanczos",
        "latentupscale", "latentupscaleby",
        # Seed/selector utility nodes
        "seedgeneratorimagesaver", "samplerselectorimagesaver",
        "schedulerselectorimagesaver",
        "selectoriginalimagenode", "seedvarianceenhancer",
        # Text manipulation (not generation params)
        "textfindandreplace", "removeduplicatetagslp",
        "tagremover", "textconcatenate",
    }

    # Disconnected editing leftovers (nodes that feed nothing on the way to a
    # save/output node) are skipped entirely — they are not part of how this
    # image was made. Only computed for graphs without implicit-link nodes
    # (rgthree broadcasts / Set-Get), where reachability is exact.
    _dead_ids = comfy_graph.dead_node_ids(prompt, comfy_graph.get_registry())

    for node_id, node_data in prompt.items():
        if not isinstance(node_data, dict):
            continue
        if str(node_id) in _dead_ids:
            continue
        class_type = node_data.get("class_type", "")
        inputs = node_data.get("inputs", {})
        if not isinstance(inputs, dict):
            continue

        ct_lower = class_type.lower()
        node_title = str(node_data.get("_meta", {}).get("title", "")).strip()

        _is_handled = False  # track if this node is specifically handled

        # ── Feature 4: LoadImage / LoadImageMask / custom loaders (initial image) ──────
        _LOAD_IMAGE_TYPES = ("loadimage", "loadimagemask", "loadimagefrommurl",
                             "loadimagebatch", "loadimagelistfrombatch",
                             "loadimagewithmetadatacrystools",
                             "load image with metadata [crystools]",
                             "loadimageoutput", "etn_loadimagebase64",
                             "betterimageloader")
        if ct_lower.replace(" ", "").replace("_", "") in {
            t.replace(" ", "").replace("_", "") for t in _LOAD_IMAGE_TYPES
        } or ct_lower in ("loadimage", "loadimagemask"):
            img_val = inputs.get("image", "")
            if isinstance(img_val, str) and img_val.strip():
                summary.setdefault("initial_image", img_val.strip())
            _is_handled = True

        # ── Feature 4b: Detect start_image inputs (WanImageToVideo, img2img, etc.) ──────
        for _si_key in ("start_image", "init_image", "pixels"):
            _si_val = inputs.get(_si_key)
            if isinstance(_si_val, list) and len(_si_val) >= 2 and "initial_image" not in summary:
                # Follow reference to find the actual image filename
                _si_ref_id = str(_si_val[0])
                _si_ref_node = prompt.get(_si_ref_id)
                if isinstance(_si_ref_node, dict):
                    _si_ref_ct = (_si_ref_node.get("class_type") or "").lower()
                    _si_ref_inputs = _si_ref_node.get("inputs", {})
                    if isinstance(_si_ref_inputs, dict):
                        _si_img = _si_ref_inputs.get("image", "")
                        if isinstance(_si_img, str) and _si_img.strip():
                            # Only set if the source is an image loader type
                            _si_ref_ct_clean = _si_ref_ct.replace(" ", "").replace("_", "")
                            if any(x in _si_ref_ct_clean for x in ("loadimage", "crystools", "imageloader")):
                                summary.setdefault("initial_image", _si_img.strip())

        # ── Samplers ──────────────────────────────────────────────
        # Structural: a sampler PRODUCES a latent and takes denoising params
        # (ComfyUI's own node signature, via the registry). Name matching is
        # only the fallback for node packs that aren't installed any more —
        # there the old exclusions (selectors/packers/VLM samplers) apply.
        _node_role = comfy_graph.classify(class_type, comfy_graph.get_registry().sig(class_type))
        # Shared with comfy_graph.find_generation_resolution so the "is this a
        # sampler by name" heuristic can't drift between the two.
        _name_says_sampler = comfy_graph.name_says_sampler(class_type)
        if _node_role == "sampler" or (_node_role is None and _name_says_sampler) or (
                # Custom latent types (e.g. video wrappers) aren't literal
                # "LATENT" — accept name+latent-ish output evidence.
                _node_role == "other" and _name_says_sampler and any(
                    "latent" in str(t).lower()
                    for t in (comfy_graph.get_registry().sig(class_type) or {}).get("output_types", []))):
            info: dict[str, Any] = {}
            info["label"] = node_title or class_type
            _SAMPLER_KEYS = ("seed", "noise_seed", "steps", "cfg", "sampler_name",
                             "scheduler", "denoise", "start_at_step", "end_at_step",
                             "add_noise", "return_with_leftover_noise")
            for key in _SAMPLER_KEYS:
                val = inputs.get(key)
                if val is not None and not isinstance(val, (list, dict)):
                    # Normalize noise_seed -> seed
                    out_key = "seed" if key == "noise_seed" else key
                    info[out_key] = val

            # A widget converted to a LINK keeps a stale literal in the workflow
            # but carries its real value through the link — always prefer the
            # link. Resolve EVERY sampler param that is a link via the pure-value
            # resolver (sliders, math, switches, rgthree Context passthrough…).
            for key in _SAMPLER_KEYS:
                val = inputs.get(key)
                if not isinstance(val, list):
                    continue
                out_key = "seed" if key == "noise_seed" else key
                rv = _resolve_scalar_smart(prompt, val)
                if rv is not None and not isinstance(rv, (list, dict)):
                    info[out_key] = rv

            # Resolve node references for standard sampler params
            # (e.g., when steps/cfg/seed come from separate Number/Selector nodes)
            # Follows chains up to 5 hops (handles Packer → Unpacker patterns)
            _SAMPLER_ALT_KEYS = {
                "sampler_name": ["sampler_name", "sampler"],  # SamplerParameterPacker uses "sampler"
                "scheduler": ["scheduler"],
                "seed": ["seed", "noise_seed"],
                "noise_seed": ["seed", "noise_seed"],
                "steps": ["steps", "value", "Value", "Xi", "Xf", "int", "float", "number"],
                "cfg": ["cfg", "value", "Value", "Xi", "Xf", "int", "float", "number"],
                "denoise": ["denoise", "value", "Value", "Xi", "Xf", "float", "number"],
            }
            for key in ("seed", "noise_seed", "steps", "cfg", "sampler_name",
                        "scheduler", "denoise"):
                out_key = "seed" if key == "noise_seed" else key
                if out_key in info:
                    continue  # already have a direct value
                val = inputs.get(key)
                if not isinstance(val, list):
                    continue
                
                # Follow reference chain up to 5 hops
                alt_keys = _SAMPLER_ALT_KEYS.get(key, [key])
                resolved = None
                ref = val
                for _ in range(5):
                    ref_node = _resolve_ref(prompt, ref)
                    if not ref_node or not isinstance(ref_node, dict):
                        break
                    ref_inputs = ref_node.get("inputs", {})
                    if not isinstance(ref_inputs, dict):
                        break
                    # Math node in the chain: its computed output IS the value —
                    # don't walk past it to the (pre-math) upstream literal.
                    if _is_math_node(ref_node.get("class_type", "")):
                        mres = _eval_math_node(prompt, ref_node)
                        if mres is not None:
                            resolved = mres
                            break
                    # Try each alternative key name
                    for ak in alt_keys:
                        rv = ref_inputs.get(ak)
                        if rv is not None and not isinstance(rv, (list, dict)):
                            resolved = rv
                            break
                    if resolved is not None:
                        break
                    # Follow the first reference input to go deeper
                    next_ref = None
                    for ak in alt_keys:
                        rv = ref_inputs.get(ak)
                        if isinstance(rv, list):
                            next_ref = rv
                            break
                    # Also try generic input names (sampler_params, etc.)
                    if next_ref is None:
                        for rk, rv in ref_inputs.items():
                            if isinstance(rv, list):
                                next_ref = rv
                                break
                    if next_ref is None:
                        break
                    ref = next_ref
                
                if resolved is not None:
                    info[out_key] = resolved

            # SamplerCustomAdvanced: resolve sub-node references for noise/guider/sampler/sigmas
            if "samplercustom" in ct_lower:
                # Sub-node params (seed/cfg/steps/denoise) are often LINKS to a
                # slider / math / primitive (e.g. an mxSlider feeding steps & cfg),
                # not literals. _scalar() returns a literal as-is and resolves a
                # [node, slot] link via the pure-value resolver (which honors e.g.
                # mxSlider's isfloatX), so linked values are no longer dropped.
                def _scalar(val):
                    if isinstance(val, list):
                        return _resolve_scalar_smart(prompt, val)
                    if isinstance(val, dict):
                        return None
                    return val

                # noise -> RandomNoise/DisableNoise -> seed
                noise_ref = inputs.get("noise")
                if isinstance(noise_ref, list):
                    noise_node = _resolve_ref(prompt, noise_ref)
                    if noise_node and isinstance(noise_node, dict):
                        n_inputs = noise_node.get("inputs", {})
                        for sk in ("noise_seed", "seed"):
                            sv = _scalar(n_inputs.get(sk))
                            if sv is not None:
                                info.setdefault("seed", sv)
                                break

                # guider -> BasicGuider/CFGGuider/ScheduledCFGGuidance -> cfg
                guider_ref = inputs.get("guider")
                if isinstance(guider_ref, list):
                    guider_node = _resolve_ref(prompt, guider_ref)
                    if guider_node and isinstance(guider_node, dict):
                        g_inputs = guider_node.get("inputs", {})
                        cfg_val = _scalar(g_inputs.get("cfg"))
                        if cfg_val is not None:
                            info.setdefault("cfg", cfg_val)

                # sampler -> KSamplerSelect -> sampler_name
                sampler_ref = inputs.get("sampler")
                if isinstance(sampler_ref, list):
                    sampler_node = _resolve_ref(prompt, sampler_ref)
                    if sampler_node and isinstance(sampler_node, dict):
                        s_inputs = sampler_node.get("inputs", {})
                        sname = s_inputs.get("sampler_name")
                        if isinstance(sname, str):
                            info.setdefault("sampler_name", sname)

                # sigmas -> (SplitSigmas / FlipSigmas / multiply / … ->)
                # BasicScheduler -> steps, scheduler, denoise. Multi-part and
                # high/low workflows feed the sampler from a sigma-splitter, so the
                # scheduler isn't the DIRECT sigmas node — walk the "sigmas" link
                # upstream (bounded, cycle-safe) until the node carrying steps is hit.
                # steps/denoise may themselves be LINKED (slider) — resolve them.
                sigmas_ref = inputs.get("sigmas")
                _sig_seen: set[str] = set()
                for _ in range(8):
                    if not isinstance(sigmas_ref, list) or len(sigmas_ref) < 1:
                        break
                    _sid = str(sigmas_ref[0])
                    if _sid in _sig_seen:
                        break
                    _sig_seen.add(_sid)
                    sigmas_node = _resolve_ref(prompt, sigmas_ref)
                    if not (sigmas_node and isinstance(sigmas_node, dict)):
                        break
                    sig_inputs = sigmas_node.get("inputs", {})
                    _got_steps = False
                    for sk in ("steps", "scheduler", "denoise"):
                        raw = sig_inputs.get(sk)
                        # scheduler is a combo STRING; steps/denoise may be links.
                        sv = (raw if isinstance(raw, str) else None) if sk == "scheduler" else _scalar(raw)
                        if sv is not None:
                            info.setdefault(sk, sv)
                            if sk == "steps":
                                _got_steps = True
                    if _got_steps:
                        break
                    sigmas_ref = sig_inputs.get("sigmas")  # follow the splitter upstream

            # ── Per-sampler shift (MoE high/low) ──────────────────────
            # Trace THIS sampler's model chain to its ModelSampling* node and read
            # shift (resolving a linked shift, e.g. a slider). So the HIGH and LOW
            # cards each show their own shift instead of one shared global value.
            if "shift" not in info:
                _model_ref = inputs.get("model")
                if not isinstance(_model_ref, list) and "samplercustom" in ct_lower:
                    _g = _resolve_ref(prompt, inputs.get("guider"))
                    if isinstance(_g, dict) and isinstance(_g.get("inputs"), dict):
                        _gm = _g["inputs"].get("model")
                        if isinstance(_gm, list):
                            _model_ref = _gm
                if isinstance(_model_ref, list):
                    _sv = _trace_model_shift(prompt, _model_ref)
                    if _sv is not None:
                        info["shift"] = _sv

            # Require real sampler evidence — an entry with only a label (or only
            # a scheduler string) is a helper node, not a sampling pass.
            if any(k in info for k in ("seed", "steps", "cfg", "denoise", "sampler_name")):
                samplers_found.append(info)
                _is_handled = True
                # Record the pass for HIGH/LOW topology tagging — the raw model /
                # latent links plus the resolved step range tell the high-noise
                # pass (start 0, adds noise) from the low-noise one (starts later).
                sampler_passes.append({
                    "nid": str(node_id),
                    "start": info.get("start_at_step"),
                    "add_noise": info.get("add_noise"),
                    "model_ref": inputs.get("model"),
                    "latent_ref": inputs.get("latent_image"),
                    "guider_ref": inputs.get("guider"),  # custom samplers carry the model via the guider
                    "info": info,  # the samplers_found entry, tagged with its role below
                })

        # ── Models / Checkpoints ──────────────────────────────────
        if "checkpointloader" in ct_lower:
            name = inputs.get("ckpt_name")
            if name and isinstance(name, str):
                models_found.append(name)
                model_loader_ids[str(node_id)] = name
                _is_handled = True

        # ── GGUF / Unet loaders ──────────────────────────────────
        if "unetloader" in ct_lower:
            name = inputs.get("unet_name")
            if name and isinstance(name, str):
                models_found.append(name)
                model_loader_ids[str(node_id)] = name
                _is_handled = True

        # ── Diffusion-model loaders (DiffusionModelLoaderKJ, …) ────
        # Load the base diffusion model from a `model_name` widget but match
        # neither "checkpointloader" nor "unetloader". Recorded as a CANDIDATE and
        # promoted to summary.model only if it actually feeds a sampler (below) — a
        # Florence2/captioner "…ModelLoader" wired elsewhere must NOT be taken for
        # the base model. NOT marked _is_handled: users bind
        # workflow_nodes.<loader>.model_name (e.g. HIGH/LOW model cards), which
        # needs this node's full params kept in workflow_nodes.
        if "diffusionmodelloader" in ct_lower or (
                "modelloader" in ct_lower and not any(
                    x in ct_lower for x in ("clip", "vae", "lora", "controlnet",
                                            "control_net", "upscale", "style",
                                            "ipadapter", "instantid", "checkpoint",
                                            "unet"))):
            name = inputs.get("model_name") or inputs.get("unet_name") or inputs.get("model")
            if name and isinstance(name, str):
                diffusion_model_candidates.append((str(node_id), name))

        # ── CLIP loaders ─────────────────────────────────────────
        # The CLIP shown in the panel is resolved by following each active text
        # encoder's `clip` link to its real source (_resolve_clip_source, below),
        # NOT by scanning every CLIPLoader: a CLIPLoader feeding a separate
        # LLM/TextGenerate node is not this image's CLIP. Just mark handled so the
        # node isn't also captured generically (its name still reaches the layout
        # via workflow_nodes for user-built LLM sections).
        if "cliploader" in ct_lower or "dualcliploader" in ct_lower:
            _is_handled = True

        # ── LoRA loaders ─────────────────────────────────────────
        # Role first (signature-identified LoRA loader), name as the fallback for
        # uninstalled packs the registry can't classify.
        if _node_role == "lora" or ("lora" in ct_lower and "loader" in ct_lower):
            # Standard LoraLoader: has lora_name string input
            name = inputs.get("lora_name")
            strength_m = inputs.get("strength_model")
            strength_c = inputs.get("strength_clip")
            if name and isinstance(name, str):
                entry: dict[str, Any] = {"name": name}
                if strength_m is not None and not isinstance(strength_m, (list, dict)):
                    entry["strength_model"] = strength_m
                if strength_c is not None and not isinstance(strength_c, (list, dict)):
                    entry["strength_clip"] = strength_c
                # Record which loader node this LoRA came from. For Wan2.2-style
                # MoE workflows that use two separate LoRA loaders (high-noise /
                # low-noise), this lets the UI pair them by loader even when the
                # filenames don't share a high/low token.
                entry["loader"] = str(node_id)
                loras_found.append(entry)

            # Power Lora Loader (rgthree): has lora_N dict inputs
            # e.g. "lora_1": {"on": True, "lora": "name.safetensors", "strength": 1.0}
            for inp_key, inp_val in inputs.items():
                if inp_key.startswith("lora_") and isinstance(inp_val, dict):
                    if inp_val.get("on") and inp_val.get("lora"):
                        lora_name = inp_val["lora"]
                        lora_strength = inp_val.get("strength", 1.0)
                        loras_found.append({
                            "name": lora_name,
                            "strength_model": lora_strength,
                            "loader": str(node_id),
                        })
            _is_handled = True

        # ── ControlNet ───────────────────────────────────────────
        # Apply nodes: extract params and resolve model name from pre-scanned loaders
        _CN_APPLY_CLASSES = ("controlnetapply", "controlnetapplyadvanced",
                              "controlnetapplysd3", "acn_advancedcontrolnetapply",
                              "setunioncontrolnettype", "qwenimagediffsynthcontrolnet")
        if any(ac in ct_lower for ac in _CN_APPLY_CLASSES):
            cn_params: dict[str, Any] = {}
            for pk in ("strength", "start_percent", "end_percent"):
                pv = inputs.get(pk)
                if pv is not None and not isinstance(pv, (list, dict)):
                    cn_params[pk] = pv

            # Resolve model name from control_net reference
            cn_name = None
            for key in ("control_net", "controlnet", "model_patch"):
                ref = inputs.get(key)
                if isinstance(ref, list) and len(ref) >= 1:
                    loader_id = str(ref[0])
                    # Use the pre-scanned loader map
                    if loader_id in cn_loader_map:
                        cn_name = cn_loader_map[loader_id]
                    else:
                        # Fallback: walk the chain
                        cn_name = _find_input_name_in_chain(prompt, ref, "control_net_name")
                    if cn_name:
                        break

            # Find preprocessor from image input chain
            preprocessor = None
            image_ref = inputs.get("image")
            if isinstance(image_ref, list):
                preprocessor = _find_preprocessor_in_chain(prompt, image_ref)

            if cn_name and isinstance(cn_name, str):
                cn_entry: dict[str, Any] = {"model": cn_name}
                cn_entry.update(cn_params)
                if preprocessor:
                    cn_entry["preprocessor"] = preprocessor
                controlnets_found.append(cn_entry)
            _is_handled = True

        # ── ADetailer / FaceDetailer / DetailerForEach ────────────
        if ("facedetailer" in ct_lower or
            ("detailer" in ct_lower and "hook" not in ct_lower
             and "pipe" not in ct_lower and "schedule" not in ct_lower
             and "noise" not in ct_lower and "cfg" not in ct_lower
             and "custom" not in ct_lower and "coreml" not in ct_lower)):
            det_model = None

            # Direct string inputs for detection model
            for key in ("model_name", "bbox_detector", "detector", "sam_model_name", "segm_detector"):
                val = inputs.get(key)
                if isinstance(val, str) and val.strip():
                    det_model = val
                    break

            # Follow reference for bbox_detector etc.
            if det_model is None:
                for key in ("bbox_detector", "sam_model", "segm_detector", "detector"):
                    val = inputs.get(key)
                    if isinstance(val, list):
                        resolved = _resolve_ref(prompt, val)
                        if resolved and isinstance(resolved, dict):
                            r_inputs = resolved.get("inputs", {})
                            for rk in ("model_name", "bbox_detector", "detector"):
                                rv = r_inputs.get(rk)
                                if isinstance(rv, str) and rv.strip():
                                    det_model = rv
                                    break
                    if det_model:
                        break

            if det_model:
                det_entry: dict[str, Any] = {"model": det_model}
                # Key sampler params from FaceDetailer
                for pk in ("steps", "cfg", "sampler_name", "scheduler", "denoise",
                           "guide_size", "max_size"):
                    pv = inputs.get(pk)
                    if pv is not None and not isinstance(pv, (list, dict)):
                        det_entry[pk] = pv
                adetailers_found.append(det_entry)
            _is_handled = True

        # ── MMAudio ──────────────────────────────────────────────
        if "mmaudiosampler" in ct_lower:
            mma: dict[str, Any] = {}
            for key in ("steps", "cfg", "seed", "prompt", "negative_prompt",
                        "duration", "mask_away_clip"):
                val = inputs.get(key)
                if val is not None and not isinstance(val, (list, dict)):
                    mma[key] = val
                elif isinstance(val, list) and key in ("prompt", "negative_prompt"):
                    # Prompt fed by a linked text node — resolve it.
                    resolved = _resolve_text_recursive(prompt, val)
                    if resolved and resolved.strip():
                        mma[key] = resolved
            if mma:
                mmaudio_info = mma
            _is_handled = True

        # ── Upscaling ────────────────────────────────────────────
        if "upscale" in ct_lower and "model" in ct_lower and "loader" not in ct_lower:
            # ImageUpscaleWithModel — resolve model name from loader
            up_entry: dict[str, Any] = {}
            model_ref = inputs.get("upscale_model")
            if isinstance(model_ref, list):
                resolved = _resolve_ref(prompt, model_ref)
                if resolved and isinstance(resolved, dict):
                    r_inputs = resolved.get("inputs", {})
                    mn = r_inputs.get("model_name")
                    if isinstance(mn, str):
                        up_entry["model"] = mn
            if up_entry:
                upscaling_found.append(up_entry)
            _is_handled = True
        elif _node_role == "latent_resize" or ("upscale" in ct_lower and "loader" not in ct_lower):
            # LatentUpscale, LatentUpscaleBy, UltimateSDUpscale, SeedVR2VideoUpscaler, …
            # (role-driven so a latent-upscale node from a pack without "upscale"
            # in its class name is still recognized, not just name-matched.)
            up_entry = {}
            for pk in ("upscale_method", "width", "height", "scale_by", "scale_factor",
                       "resolution"):
                pv = inputs.get(pk)
                if isinstance(pv, list):
                    # Linked value (slider/math chain) — resolve to the final scalar.
                    rv = _resolve_scalar_smart(prompt, pv)
                    if isinstance(rv, (int, float)) or (pk == "upscale_method" and isinstance(rv, str)):
                        pv = rv
                    else:
                        pv = None
                if pv is not None and not isinstance(pv, (list, dict)):
                    if isinstance(pv, (int, float)) and not isinstance(pv, bool):
                        pv = _normalize_number(pv)
                    up_entry[pk] = pv
            # Model-based upscalers fed by a separate loader (SeedVR2 etc.):
            # resolve the loader's model name so the Upscaling card has one.
            if "model" not in up_entry:
                for _mk in ("upscale_model", "dit_model", "dit", "model"):
                    _mref = inputs.get(_mk)
                    if not isinstance(_mref, list):
                        continue
                    _mnode = _resolve_ref(prompt, _mref)
                    if isinstance(_mnode, dict) and isinstance(_mnode.get("inputs"), dict):
                        for _mn in ("model_name", "model", "ckpt_name"):
                            _mv = _mnode["inputs"].get(_mn)
                            if isinstance(_mv, str) and _mv.strip():
                                up_entry["model"] = _mv
                                break
                    if up_entry.get("model"):
                        break
            if up_entry:
                up_entry["type"] = class_type
                upscaling_found.append(up_entry)
            _is_handled = True
        elif _node_role == "image_resize" or (_node_role is None and
              ("resize" in ct_lower or "scale" in ct_lower) and "image" in ct_lower
              and "latent" not in ct_lower):
            # Image-space resize family (ImageResizeKJv2, ImageScaleToTotalPixels,
            # ResizeImageMaskNode, WanVideoImageResizeToClosest, ResizeImagesBy
            # LongerEdge, ImageScale/By, …): MANY node packs, one meaning. Only
            # POST-generation resizes (the image came out of a VAE decode or a
            # model upscaler) count as upscaling output — a resize that prepares
            # an input image is not. Normalized into the same `upscaling` entries
            # so layouts can read upscaling.* instead of per-node-type paths.
            # (These nodes still ALSO appear under workflow_nodes as before.)
            _img_ref = None
            for _ik in ("image", "images", "pixels"):
                _iv = inputs.get(_ik)
                if isinstance(_iv, list) and len(_iv) >= 1:
                    _img_ref = _iv
                    break
            if _img_ref is not None and _chain_reaches(
                    prompt, _img_ref, ("vaedecode", "upscalewithmodel", "imageupscale")):
                up_entry = {}
                _RESIZE_KEY_MAP = (
                    (("upscale_method", "scale_method", "method", "interpolation", "resize_method"), "upscale_method"),
                    (("scale_by", "scale", "scale_factor", "factor", "upscale_factor", "multiplier"), "scale_by"),
                    (("width",), "width"),
                    (("height",), "height"),
                    (("longer_edge", "longer_side", "side_length"), "longer_edge"),
                    (("megapixels", "total_pixels"), "megapixels"),
                )
                for src_keys, out_key in _RESIZE_KEY_MAP:
                    for pk in src_keys:
                        pv = inputs.get(pk)
                        if isinstance(pv, list):
                            pv = _resolve_scalar_smart(prompt, pv)
                        if isinstance(pv, str) and out_key == "upscale_method" and pv.strip():
                            up_entry[out_key] = pv
                            break
                        if isinstance(pv, (int, float)) and not isinstance(pv, bool) and pv:
                            up_entry[out_key] = _normalize_number(pv)
                            break
                if up_entry:
                    up_entry["type"] = class_type
                    upscaling_found.append(up_entry)
            # NOT marked handled: keep the full generic workflow_nodes entry so
            # existing layouts that reference these nodes by name keep working.

        # ── Frame Interpolation ──────────────────────────────────
        if _node_role == "interpolation" or (_node_role != "image_resize" and (
                "interpolation" in ct_lower or "vfi" in ct_lower or "rife" in ct_lower)):
            interp: dict[str, Any] = {}
            for key in ("source_fps", "target_fps", "scale", "model_name",
                        "multiplier", "ckpt_name"):
                val = inputs.get(key)
                if val is not None and not isinstance(val, (list, dict)):
                    interp[key] = val
                elif isinstance(val, list):
                    # Linked value (slider/math chain) — resolve to the final scalar.
                    rv = _resolve_scalar_smart(prompt, val)
                    if isinstance(rv, (int, float)) or (key in ("model_name", "ckpt_name") and isinstance(rv, str)):
                        interp[key] = rv
            if interp:
                interp["type"] = class_type
                interpolation_found.append(interp)
            _is_handled = True

        # ── CLIP Text Encode — prompts ───────────────────────────
        if _node_role == "text_encode" or (_node_role is None and (
                "cliptextencode" in ct_lower or "textencode" in ct_lower)):
            # Record this (non-dead) encoder's clip source so clip_models can be
            # resolved by following the real link, not a global CLIPLoader scan.
            _clip_ref = inputs.get("clip")
            if isinstance(_clip_ref, list) and _clip_ref:
                active_clip_refs.append(_clip_ref)
            # Check both "text" and "prompt" keys — some nodes (e.g., TextEncodeQwen*)
            # use "prompt" instead of "text" for the text input
            text = inputs.get("text")
            if text is None:
                text = inputs.get("prompt")
            initial_text = None  # User's original prompt before enhancement
            enhanced_text = None  # Enhanced prompt from VLM/LLM output
            enhancer_node = None  # The enhancer node dict if found

            # Recursively follow reference chains to resolve text
            if isinstance(text, list) and len(text) >= 1:
                # Step 1: Check if an enhancer exists anywhere in the chain
                enhancer_node = _find_enhancer_in_chain(prompt, text)

                if enhancer_node is not None:
                    # An enhancer IS in the chain — find both initial and enhanced text
                    # Step 2a: Find the user's initial prompt
                    initial_text = _find_enhancer_initial_prompt(prompt, text)

                    # Step 2b: Find the enhanced text output
                    # Keys where runtime-captured text may appear
                    _CAPTURED_TEXT_KEYS = ("text_0", "text_1", "text_output", "text_out",
                                          "generated_text", "value", "string", "STRING",
                                          "result", "output_text")
                    # Patterns for ShowText/Display nodes
                    _SHOW_TEXT_PATTERNS = ("showtext", "showanything", "display", "textoutput",
                                          "stringoutput", "debugtext", "showstring", "show_text",
                                          "display_text", "text_display", "previewtext",
                                          "was_text", "easy_showanything")

                    # Pass A: Find any node that directly references the enhancer's output
                    # and has captured text (e.g., ShowText nodes)
                    enhancer_id = None
                    for _eid, _edata in prompt.items():
                        if _edata is enhancer_node:
                            enhancer_id = str(_eid)
                            break

                    if enhancer_id:
                        for _nid, _ndata in prompt.items():
                            if not isinstance(_ndata, dict):
                                continue
                            _inputs = _ndata.get("inputs", {})
                            if not isinstance(_inputs, dict):
                                continue
                            # Check if any input references the enhancer node
                            for _ik, _iv in _inputs.items():
                                if isinstance(_iv, list) and len(_iv) >= 2 and str(_iv[0]) == enhancer_id:
                                    # This node takes input from the enhancer
                                    # Check for captured text in this node
                                    for _tk in ("text",) + _CAPTURED_TEXT_KEYS:
                                        _tv = _inputs.get(_tk)
                                        # Only take string values (not references), min length check
                                        if isinstance(_tv, str) and _tv.strip() and len(_tv.strip()) > 10:
                                            enhanced_text = _tv.strip()
                                            break
                                if enhanced_text:
                                    break
                            if enhanced_text:
                                break

                    # Pass B: Check the enhancer node's own inputs for captured output
                    if not enhanced_text:
                        for _tk in _CAPTURED_TEXT_KEYS:
                            _tv = (enhancer_node.get("inputs") or {}).get(_tk)
                            if isinstance(_tv, str) and _tv.strip() and len(_tv.strip()) > 10:
                                enhanced_text = _tv.strip()
                                break

                    # Pass C: Broader search — any ShowText-like node connected to any
                    # enhancer in the prompt
                    if not enhanced_text:
                        for _nid, _ndata in prompt.items():
                            if not isinstance(_ndata, dict):
                                continue
                            _ct_lower = (_ndata.get("class_type") or "").lower().replace(" ", "").replace("_", "")
                            if not any(p in _ct_lower for p in _SHOW_TEXT_PATTERNS):
                                continue
                            _inputs = _ndata.get("inputs", {})
                            if not isinstance(_inputs, dict):
                                continue
                            for _ik, _iv in _inputs.items():
                                if isinstance(_iv, list) and len(_iv) >= 2:
                                    if _find_enhancer_in_chain(prompt, _iv, max_depth=4):
                                        for _tk in ("text",) + _CAPTURED_TEXT_KEYS:
                                            _tv = _inputs.get(_tk)
                                            if isinstance(_tv, str) and _tv.strip() and len(_tv.strip()) > 10:
                                                enhanced_text = _tv.strip()
                                                break
                                if enhanced_text:
                                    break
                            if enhanced_text:
                                break

                # Step 3: Resolve text normally via BFS as fallback
                resolved = _resolve_text_recursive(prompt, text)
                if resolved:
                    text = resolved

            # Determine the final positive prompt text
            # If enhanced text was found, USE IT as the positive prompt.
            # The resolved text (from _resolve_text_recursive) may be either the
            # enhanced or original — enhanced_text from ShowText is more reliable.
            if enhanced_text:
                text = enhanced_text

            if isinstance(text, str) and text.strip():
                title_lower = (node_title or "").lower()
                _is_neg_by_title = bool(re.search(r'\bneg(?:ative)?\b', title_lower))
                # A node reached from BOTH positive and negative inputs (one encode
                # reused for both sides) is a positive prompt, not a negative.
                _in_neg_chain = (str(node_id) in negative_node_ids
                                 and str(node_id) not in positive_node_ids)
                is_negative = _in_neg_chain or _is_neg_by_title
                if is_negative:
                    negative_texts.append((str(node_id), text.strip()))
                else:
                    positive_texts.append((str(node_id), text.strip()))
                    # Track initial prompt from enhancer (only for positive)
                    if initial_text and initial_text != text.strip():
                        initial_prompts.append(initial_text)
                    elif enhancer_node is not None and not enhanced_text:
                        # Enhancer was used but enhanced text couldn't be captured
                        summary["prompt_enhanced"] = True
            _is_handled = True

        # ── VAE ──────────────────────────────────────────────────
        if "vaeloader" in ct_lower:
            vae = inputs.get("vae_name")
            if vae and isinstance(vae, str):
                summary.setdefault("vae", vae)
            _is_handled = True

        # ── Clip Skip ────────────────────────────────────────────
        if "clipsetlastlayer" in ct_lower:
            skip = inputs.get("stop_at_clip_layer")
            if skip is not None:
                summary.setdefault("clip_skip", abs(int(skip)) if isinstance(skip, (int, float)) else skip)
            _is_handled = True

        # ── Flux Shift / ModelSampling ───────────────────────────
        if "modelsamplingflux" in ct_lower or "modelsamplingsd3" in ct_lower:
            shift = inputs.get("shift")
            if shift is not None and not isinstance(shift, (list, dict)):
                summary.setdefault("shift", shift)
            _is_handled = True
        if "modelsamplingdiscrete" in ct_lower or "modelsampling" in ct_lower:
            sampling = inputs.get("sampling")
            if sampling and isinstance(sampling, str):
                summary.setdefault("sampling_type", sampling)
            _is_handled = True

        # ── Generic node capture ─────────────────────────────────
        # Capture ALL non-utility node names for searchability in "Workflow Nodes" section.
        # Handled nodes get a lightweight entry (class_type + title only, no duplicate params).
        # Unhandled nodes get full scalar params.
        ct_clean = ct_lower.replace(" ", "").replace("_", "").replace("(", "").replace(")", "").replace("|", "")
        if ct_clean not in _SKIP_GENERIC_TYPES:
            # Upstream context label: title (preferred) or class_type of the
            # node feeding this one's first reference input.
            from_label = None
            src_id = upstream_src.get(str(node_id))
            if src_id:
                src_node = prompt.get(src_id)
                if isinstance(src_node, dict):
                    from_label = (str(src_node.get("_meta", {}).get("title", "")).strip()
                                  or str(src_node.get("class_type", "")).strip() or None)
            is_display_node = any(p in ct_clean for p in _DISPLAY_NODE_PATTERNS)

            if _is_handled:
                # Handled nodes: add lightweight entry for search (name only, no params)
                generic_entry: dict[str, Any] = {
                    "class_type": class_type,
                    "params": {},
                    "_handled": True,  # flag so frontend can skip duplicate display if needed
                }
                if node_title and node_title != class_type:
                    generic_entry["title"] = node_title
                if from_label and is_display_node:
                    generic_entry["_from"] = from_label
                generic_entry["_node_id"] = str(node_id)  # correlate with workflow node
                generic_nodes.append(generic_entry)
            else:
                # Unhandled nodes: full param capture
                # VLM / PromptEnhancer / LLM nodes: special handling to capture long prompts
                _VLM_PATTERNS = ("llava", "vlm", "prompt_enhancer", "promptenhancer",
                                 "llamasampler", "llm", "florence", "joycaption",
                                 "cogvlm", "minicpm", "internvl", "qwenvl",
                                 "textgenerator", "ollamagenerate",
                                 "enhanceprompt", "improve_prompt")
                is_vlm = any(p in ct_lower for p in _VLM_PATTERNS)
                _PROMPT_KEYS = ("user_prompt", "system_prompt", "prompt", "text",
                                "question", "instruction", "system_message")

                # Keys whose reference inputs are worth resolving to text (node
                # prompts fed by a linked text/primitive node).
                # NOTE: bare "positive"/"negative" are conditioning links on
                # sampler-type nodes — resolving them would copy the whole
                # prompt text into the node's params. "positive_prompt" style
                # keys still match via "prompt".
                _PROMPT_REF_HINTS = ("prompt", "msg", "message", "text", "caption",
                                     "system", "instruction", "question")

                node_params: dict[str, Any] = {}
                for k, v in inputs.items():
                    # Only capture scalar values (strings, numbers, bools) — skip references
                    if isinstance(v, (str, int, float, bool)):
                        if isinstance(v, str):
                            if not v.strip():
                                continue
                            # For VLM nodes, allow long text for prompt keys
                            if len(v) > 500 and not (is_vlm and k in _PROMPT_KEYS):
                                continue
                            # Cap even the allowed long values so a node wired to a
                            # huge blob can't bloat the stored row.
                            if len(v) > _NODE_TEXT_MAX:
                                v = v[:_NODE_TEXT_MAX] + "…"
                        node_params[k] = v
                    elif isinstance(v, dict):
                        # Include simple dicts (e.g., Power Lora Loader sub-entries)
                        node_params[k] = v
                    elif isinstance(v, list) and len(v) >= 1:
                        # Reference input. For prompt-ish fields, follow the link to
                        # the source text/primitive node and capture its string, so
                        # node prompts (JoyCaption custom_prompt, LLava system_msg,
                        # MMAudio positive/negative, etc.) become visible in the panel,
                        # searchable, and selectable in the layout editor.
                        kl = k.lower()
                        if k in _PROMPT_KEYS or any(t in kl for t in _PROMPT_REF_HINTS):
                            resolved = _resolve_text_recursive(prompt, v)
                            if resolved and resolved.strip():
                                # These keys are explicitly prompts — keep the full
                                # text (capped) rather than dropping long ones, so
                                # e.g. JoyCaption custom_prompt (a long instruction
                                # fed from a text node) is captured, not discarded.
                                node_params[k] = resolved if len(resolved) <= 4000 else (resolved[:4000] + "…")
                        elif kl in _CLIP_INPUT_KEYS:
                            # Resolve a clip link to the loader filename so a node that
                            # USES a CLIP/text-encoder (e.g. a TextGenerate LLM) shows
                            # which model it ran. The image's own CLIP lives in
                            # clip_models; an LLM-via-CLIPLoader has no other home, so
                            # this gives the LLM panel section a node-scoped source
                            # (workflow_nodes.<Node>.clip). Baked-checkpoint clips
                            # resolve to nothing (no separate file).
                            _cn, _baked = _resolve_clip_source(prompt, v)
                            if _cn:
                                node_params[k] = _cn[0]
                        elif kl not in _NON_SCALAR_INPUT_KEYS:
                            # Scalar link (e.g. slider → MathExpression → fps):
                            # resolve through the chain to the FINAL value, so the
                            # consumer node shows what was actually used.
                            rv = _resolve_scalar_smart(prompt, v)
                            if isinstance(rv, (bool, int, float)):
                                node_params[k] = rv
                            elif isinstance(rv, str) and rv.strip() and len(rv) <= 500:
                                node_params[k] = rv
                # Math nodes: also expose the computed output as "result"
                # (inputs a/b/c are captured above, resolved when linked).
                if _is_math_node(class_type):
                    mres = _eval_math_node(prompt, node_data)
                    if mres is not None:
                        node_params["result"] = mres
                # Always include nodes — even those with only reference inputs
                # should appear in Workflow Nodes section with their class_type
                generic_entry = {
                    "class_type": class_type,
                    "params": node_params,
                }
                if node_title and node_title != class_type:
                    generic_entry["title"] = node_title
                # Flag VLM nodes so frontend can render prompts specially
                if is_vlm:
                    generic_entry["is_vlm"] = True
                if from_label and (is_display_node or not node_params):
                    generic_entry["_from"] = from_label
                generic_entry["_node_id"] = str(node_id)  # correlate with workflow node
                generic_nodes.append(generic_entry)


    # ── Merge results into summary ────────────────────────────────

    # Samplers: structured array
    if samplers_found:
        # Drop passes that perform no denoising (an Advanced KSampler whose
        # start_at_step is at/after its last step — e.g. a disabled refiner left
        # at start_at_step == steps), so the panel shows only the passes that
        # actually ran. Keep them all if that would empty the list (defensive —
        # every sampler reporting "no steps" means the heuristic is wrong here).
        active = [s for s in samplers_found if not _sampler_runs_no_steps(s)]
        summary.setdefault("samplers", active or samplers_found)
        # NOTE: No backward-compat flat keys (steps, cfg, etc.) are set here.
        # All sampler data lives exclusively in the samplers array.
        # _final_summary_cleanup() will sweep any stale flat keys to 'extra'.

    # Promote diffusion-model-loader candidates that actually feed a sampler — a
    # captioner/vision "…ModelLoader" (Florence2, etc.) wired to a non-sampler node
    # must NOT be mistaken for the base model.
    if diffusion_model_candidates:
        _chain_nids: set = set()
        for _p in sampler_passes:
            _chain_nids.update(_collect_model_chain_nids(prompt, _p.get("model_ref")))
        for _nid, _nm in diffusion_model_candidates:
            if _nid in _chain_nids and _nm not in models_found:
                models_found.append(_nm)
                model_loader_ids[_nid] = _nm

    # HIGH/LOW roles from graph topology (Wan2.2 MoE), shared by models + loras.
    role_map = _compute_high_low_roles(prompt, sampler_passes, model_loader_ids)

    # Carry each pass's role onto its sampler entry (HIGH/LOW pairing for the
    # sampler cards). p["info"] is the samplers_found dict by reference.
    for _p in sampler_passes:
        _r = _p.get("role")
        if _r and isinstance(_p.get("info"), dict):
            _p["info"]["role"] = _r

    # Models
    if models_found:
        # Deduplicate
        seen: list[str] = []
        for m in models_found:
            if m not in seen:
                seen.append(m)
        # When topology identified a high/low pass, order the model list
        # high-then-low so the HIGH/LOW model cards line up even when the
        # filenames carry no high/low token.
        if role_map and model_loader_ids and len(seen) > 1:
            name_role: dict[str, str] = {}
            for nid, nm in model_loader_ids.items():
                r = role_map.get(nid)
                if r and nm not in name_role:
                    name_role[nm] = r
            if name_role:
                _ord = {"high": 0, "low": 1}
                seen.sort(key=lambda nm: _ord.get(name_role.get(nm, ""), 2))
        # Switch-aware: keep only the models the SAMPLERS actually use, dropping a
        # switch's unselected branch (e.g. a GGUF/safetensors A-or-B "Any Switch").
        # Applied ONLY when every sampler's model resolved to a loader, so a model
        # hidden behind an unhandled node is never silently dropped.
        _active_ids, _safe = _resolve_active_model_loaders(prompt, sampler_passes, model_loader_ids)
        if _safe:
            _active_names = {model_loader_ids[a] for a in _active_ids if a in model_loader_ids}
            if _active_names and _active_names < set(seen):
                seen = [m for m in seen if m in _active_names]
        summary.setdefault("model", seen[0] if len(seen) == 1 else seen)

    # CLIP models — follow each active text encoder's clip link to its real source.
    # Excludes a CLIPLoader feeding a separate LLM/TextGenerate node; yields nothing
    # when the CLIP is baked into the checkpoint; reads a custom encoder leaf's model
    # file (e.g. an LLM used as a text encoder).
    clip_names: list[str] = []
    for _cref in active_clip_refs:
        _names, _baked = _resolve_clip_source(prompt, _cref)
        for _n in _names:
            if _n not in clip_names:
                clip_names.append(_n)
    if clip_names:
        summary.setdefault("clip_models", clip_names)

    # LoRAs (structured) — dedup identical entries (the same LoRA loaded by two
    # parallel high/low loaders) and tag each with its topology role so the UI
    # pairs HIGH vs LOW reliably instead of guessing from the filename.
    if loras_found:
        seen_lora: set = set()
        deduped_loras: list[dict] = []
        for lo in loras_found:
            key = (lo.get("name"), lo.get("strength_model"), lo.get("strength_clip"))
            if key in seen_lora:
                continue
            seen_lora.add(key)
            r = role_map.get(str(lo.get("loader")))
            if r:
                lo["role"] = r
            deduped_loras.append(lo)
        summary.setdefault("loras", deduped_loras)

    # ControlNet (structured with preprocessor) — MERGE duplicates
    if controlnets_found:
        merged_cn: dict[str, dict] = {}
        for c in controlnets_found:
            key = c.get("model", "")
            if not key:
                continue
            if key in merged_cn:
                # Merge: fill in missing fields from the new entry
                for k, v in c.items():
                    if v is not None and (k not in merged_cn[key] or merged_cn[key][k] is None):
                        merged_cn[key][k] = v
            else:
                merged_cn[key] = dict(c)
        summary.setdefault("controlnet", list(merged_cn.values()))

    # ADetailer (structured with sampler params)
    if adetailers_found:
        seen_ad: set[str] = set()
        unique_ad: list[dict] = []
        for a in adetailers_found:
            key = a.get("model", "")
            if key not in seen_ad:
                seen_ad.add(key)
                unique_ad.append(a)
        summary.setdefault("adetailer", unique_ad)

    # MMAudio
    if mmaudio_info:
        summary.setdefault("mmaudio", mmaudio_info)

    # Upscaling — deduplicate by model name or type
    if upscaling_found:
        seen_ups: list[str] = []
        unique_ups: list[dict] = []
        for u in upscaling_found:
            key = u.get("model", u.get("type", ""))
            if key and key not in seen_ups:
                seen_ups.append(key)
                unique_ups.append(u)
            elif not key:
                unique_ups.append(u)
        summary.setdefault("upscaling", unique_ups)

    # Interpolation — deduplicate by type
    if interpolation_found:
        seen_interp: list[str] = []
        unique_interp: list[dict] = []
        for ip in interpolation_found:
            key = ip.get("type", "")
            if key and key not in seen_interp:
                seen_interp.append(key)
                unique_interp.append(ip)
            elif not key:
                unique_interp.append(ip)
        summary.setdefault("interpolation", unique_interp)

    # Prompts. Multiple distinct texts (multi-part video workflows, base+refiner)
    # are joined with "---"; sort by node id first so the order is deterministic
    # and usually matches the order the parts were authored in.
    def _nid_sort_key(nid: str):
        return [(0, int(seg)) if seg.isdigit() else (1, seg) for seg in nid.split(":")]

    if positive_texts:
        seen_p: set[str] = set()
        unique_p: list[str] = []
        for _nid, t in sorted(positive_texts, key=lambda it: _nid_sort_key(it[0])):
            # Strip inline LoRA tags like <lora:ModelName:1.0> from prompt text
            t_clean = re.sub(r'<lora:[^>]+>', '', t).strip()
            if not t_clean:
                continue
            if t_clean not in seen_p:
                seen_p.add(t_clean)
                unique_p.append(t_clean)
        if unique_p:
            summary.setdefault("positive_prompt", "\n---\n".join(unique_p) if len(unique_p) > 1 else unique_p[0])

    # Initial prompt from prompt enhancer (user's original text before VLM/LLM enhancement)
    if initial_prompts:
        seen_ip: set[str] = set()
        unique_ip: list[str] = []
        for t in initial_prompts:
            if t not in seen_ip:
                seen_ip.add(t)
                unique_ip.append(t)
        summary.setdefault("initial_prompt", "\n---\n".join(unique_ip) if len(unique_ip) > 1 else unique_ip[0])

    if negative_texts:
        seen_n: set[str] = set()
        unique_n: list[str] = []
        for _nid, t in sorted(negative_texts, key=lambda it: _nid_sort_key(it[0])):
            if t not in seen_n:
                seen_n.add(t)
                unique_n.append(t)
        summary.setdefault("negative_prompt", "\n---\n".join(unique_n) if len(unique_n) > 1 else unique_n[0])

    # Generic workflow nodes
    if generic_nodes:
        # Keep ALL instances of each node type (a workflow can legitimately use
        # the same node 4x for different purposes), capped to avoid DB bloat:
        # at most 8 per class_type (prefer the ones with the most params) and
        # ~120 overall (param-less _handled stubs dropped first).
        _MAX_PER_TYPE = 8
        _MAX_TOTAL = 120
        by_type: dict[str, list[dict]] = {}
        for gn in generic_nodes:
            by_type.setdefault(gn["class_type"], []).append(gn)
        kept: set[int] = set()
        for entries in by_type.values():
            if len(entries) > _MAX_PER_TYPE:
                richest = sorted(entries, key=lambda g: len(g.get("params", {})), reverse=True)[:_MAX_PER_TYPE]
                entries = [g for g in entries if any(g is r for r in richest)]
            for g in entries:
                kept.add(id(g))
            # Duplicated types: attach downstream context (up to 2 consumer
            # slots) so instances can be told apart in the layout editor.
            if len(entries) > 1:
                for g in entries:
                    feeds = feeds_map.get(g.get("_node_id", ""), [])
                    if feeds:
                        g["_feeds"] = feeds[:2]
        capped = [g for g in generic_nodes if id(g) in kept]
        if len(capped) > _MAX_TOTAL:
            stubs = [g for g in capped if g.get("_handled") and not g.get("params")]
            drop = len(capped) - _MAX_TOTAL
            drop_ids = {id(g) for g in stubs[:drop]}
            capped = [g for g in capped if id(g) not in drop_ids][:_MAX_TOTAL]
        summary.setdefault("workflow_nodes", capped)


def _looks_like_raw_metadata(t: str) -> bool:
    """A display node wired to a loader's "metadata raw" output shows the whole
    prompt/workflow JSON (or an embedded-metadata blob), not a caption. Only a
    leading "{" (JSON object) is a reliable signal — NOT "[", which also starts
    legit captions like prompt-editing "[dog:cat:0.5]" or a tag list
    ["1girl","solo"]; array-of-object dumps are still caught by the markers."""
    s = t.lstrip()
    if s.startswith("{"):
        return True
    return ('"class_type"' in s or '"last_node_id"' in s
            or '"extra_pnginfo"' in s or '"nodes":' in s)


def _extract_from_comfyui_workflow(workflow: dict, summary: dict,
                                   linked_size_ids: set[str] | frozenset = frozenset(),
                                   executed_ids: set[str] | None = None):
    """Extract width/height from ComfyUI workflow graph format.

    linked_size_ids: prompt node ids whose width/height inputs are LINKS — the
    workflow widgets for those nodes hold a stale typed-in value from before
    the conversion (e.g. WanImageToVideo showing 480×720 while the real size
    came from a GetImageSize at runtime), so they must be skipped.
    """
    nodes = workflow.get("nodes", [])
    if not isinstance(nodes, list):
        return

    # NOTE: Do NOT set workflow_nodes here — the prompt-based extractor
    # (_extract_from_comfyui_prompt) already populates it with detailed
    # node dicts for search. Setting it to an integer count would break search.

    # Try to find resolution from EmptyLatentImage or similar nodes
    _RESOLUTION_NODES = {
        "emptylatentimage", "emptysd3latent",
        "wanimagetovideo", "wanvideotovideo", "wanfuncontrolinpaint",
    }
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if str(node.get("id")) in linked_size_ids:
            continue
        # Muted/bypassed nodes exist in the workflow but never ran (they are
        # absent from the prompt) — their widget sizes are not this image's.
        if executed_ids is not None and str(node.get("id")) not in executed_ids:
            continue
        ntype = node.get("type", "")
        if ntype.lower().replace(" ", "") in {n.replace(" ", "") for n in _RESOLUTION_NODES}:
            widgets = node.get("widgets_values", [])
            if isinstance(widgets, list) and len(widgets) >= 2:
                try:
                    w, h = int(widgets[0]), int(widgets[1])
                    if 64 <= w <= 8192 and 64 <= h <= 8192:
                        summary.setdefault("resolution", f"{w}×{h}")
                        summary.setdefault("width", w)
                        summary.setdefault("height", h)
                except (ValueError, TypeError):
                    pass

    # ── Correct display-node text from widgets_values ──────────────────────
    # "Show" nodes (easy showAnything, ShowText, …) store the REAL displayed
    # output in the workflow's widgets_values, whereas the prompt's text input can
    # hold a STALE value baked in from a previous run. Override the captured text
    # with the workflow value, matched by node id.
    _SHOW_NODE_PATTERNS = ("showanything", "showtext", "displayany", "showstring",
                           "displaytext", "previewany")

    def _first_str(x: Any) -> str | None:
        if isinstance(x, str):
            return x
        if isinstance(x, (list, tuple)):
            for it in x:
                s = _first_str(it)
                if s is not None:
                    return s
        return None

    wf_show_text: dict[str, str] = {}
    raw_meta_ids: set[str] = set()
    for node in nodes:
        if not isinstance(node, dict):
            continue
        ntype = str(node.get("type", "")).lower().replace(" ", "").replace("_", "")
        if any(pat in ntype for pat in _SHOW_NODE_PATTERNS):
            txt = _first_str(node.get("widgets_values"))
            if isinstance(txt, str) and txt.strip():
                t = txt.strip()
                # A "metadata raw" dump isn't a caption — don't store it (it would
                # bloat the row) and drop the node from the panel entirely.
                if _looks_like_raw_metadata(t):
                    raw_meta_ids.add(str(node.get("id")))
                    continue
                # Cap: a show node can display a huge blob. Store at most
                # _NODE_TEXT_MAX chars so it can't bloat the row.
                wf_show_text[str(node.get("id"))] = t if len(t) <= _NODE_TEXT_MAX else (t[:_NODE_TEXT_MAX] + "…")

    if wf_show_text:
        for entry in summary.get("workflow_nodes", []) or []:
            if not isinstance(entry, dict):
                continue
            nid = entry.get("_node_id")
            params = entry.get("params")
            if nid in wf_show_text and isinstance(params, dict):
                params["text"] = wf_show_text[nid]

    # Drop display nodes that just dump raw metadata — not generation params, and
    # they bloat the stored row.
    if raw_meta_ids:
        summary["workflow_nodes"] = [
            e for e in (summary.get("workflow_nodes") or [])
            if not (isinstance(e, dict) and str(e.get("_node_id")) in raw_meta_ids)
        ]


def _derive_generation_resolution(summary: dict[str, Any], w: int, h: int) -> None:
    """When the workflow didn't reveal the pre-upscale size (e.g. it came from a
    runtime GetImageSize), derive it from the file's final size and the single
    known upscale factor: gen = final / scale."""
    if summary.get("generation_resolution"):
        return
    ups = summary.get("upscaling")
    if not isinstance(ups, list):
        return
    scales = [u.get("scale_by") for u in ups if isinstance(u, dict)]
    scales = [s for s in scales if isinstance(s, (int, float)) and not isinstance(s, bool) and s > 1]
    if len(scales) != 1:
        return  # none, or ambiguous (multiple upscale passes)
    gw, gh = round(w / scales[0]), round(h / scales[0])
    if gw >= 16 and gh >= 16:
        summary["generation_resolution"] = f"{gw}×{gh}"


# ── Image metadata readers ────────────────────────────────────────────


def read_image_metadata_best_effort(path: str) -> dict[str, Any]:
    try:
        from PIL import Image
    except Exception:
        return {}

    try:
        with Image.open(path) as img:
            info = dict(img.info or {})
            exif = None
            try:
                exif = img.getexif()
            except Exception:
                exif = None
            if exif:
                info["exif"] = dict(exif)

                # ── Extract EXIF text fields for JPG/JPEG metadata ────
                # A1111/Forge/WebUI store generation params in EXIF tags,
                # NOT in PIL's img.info dict (which works for PNG tEXt chunks).
                # Tag 270 = ImageDescription, Tag 37510 = UserComment
                _EXIF_TEXT_TAGS = {270: "parameters", 37510: "parameters"}

                for tag_id, target_key in _EXIF_TEXT_TAGS.items():
                    if target_key in info:
                        break  # Already have parameters from img.info
                    val = exif.get(tag_id)
                    if val is None:
                        continue
                    if isinstance(val, bytes):
                        # Strip common charset markers BEFORE decoding. Longest first!
                        for prefix in (b'ASCII\x00\x00\x00', b'UNICODE\x00\x00', b'UNICODE\xFF\xFE', b'UNICODE\xFE\xFF', b'UNICODE\x00', b'UNICODE'):
                            if val.startswith(prefix):
                                val = val[len(prefix):]
                                break
                        # Try decoding
                        decoded_str = None
                        for enc in ("utf-8", "utf-16-le", "utf-16-be", "latin-1"):
                            try:
                                decoded_str = val.decode(enc, errors="strict")
                                break
                            except Exception:
                                pass
                        if decoded_str is None:
                            decoded_str = val.decode("utf-8", errors="replace")
                        
                        if decoded_str is not None:
                            decoded_str = decoded_str.replace("\x00", "").strip()
                        val = decoded_str
                    if isinstance(val, str) and val.strip():
                        info[target_key] = val.strip()

                # Also check EXIF IFD sub-block (0x8769) for UserComment
                if "parameters" not in info:
                    try:
                        ifd = exif.get_ifd(0x8769)
                        if ifd:
                            uc = ifd.get(37510)  # UserComment in EXIF IFD
                            if uc is not None:
                                if isinstance(uc, bytes):
                                    for prefix in (b'ASCII\x00\x00\x00', b'UNICODE\x00\x00', b'UNICODE\xFF\xFE', b'UNICODE\xFE\xFF', b'UNICODE\x00', b'UNICODE'):
                                        if uc.startswith(prefix):
                                            uc = uc[len(prefix):]
                                            break
                                    decoded_uc = None
                                    for enc in ("utf-8", "utf-16-le", "utf-16-be", "latin-1"):
                                        try:
                                            decoded_uc = uc.decode(enc, errors="strict")
                                            break
                                        except Exception:
                                            pass
                                    if decoded_uc is None:
                                        decoded_uc = uc.decode("utf-8", errors="replace")
                                        
                                    if decoded_uc is not None:
                                        decoded_uc = decoded_uc.replace("\x00", "").strip()
                                    uc = decoded_uc
                                if isinstance(uc, str) and uc.strip():
                                    info["parameters"] = uc.strip()
                    except Exception:
                        pass

            # Try parsing common fields that might contain JSON.
            for key in ("comment", "parameters", "prompt", "workflow"):
                if key in info:
                    v = info.get(key)
                    if isinstance(v, bytes):
                        try:
                            v = v.decode("utf-8", errors="replace")
                        except Exception:
                            v = v.decode("latin-1", errors="replace")
                    if isinstance(v, str):
                        info[key] = _json_best_effort(v)
            return info
    except Exception:
        return {}


def read_video_sidecar(path: str) -> dict[str, Any] | None:
    base = path
    candidates = [
        base + ".json",
        os.path.splitext(base)[0] + ".json",
        base + ".workflow.json",
        os.path.splitext(base)[0] + ".workflow.json",
    ]
    for c in candidates:
        if not os.path.isfile(c):
            continue
        try:
            with open(c, "r", encoding="utf-8") as f:
                return json.loads(f.read())
        except Exception:
            continue
    return None


_FFPROBE_CACHE: list = []  # memoized resolved path (or [None])


def _find_ffprobe() -> str | None:
    """Locate ffprobe even when it isn't on ComfyUI's process PATH.

    ComfyUI is often launched from a venv/launcher whose PATH omits per-user dirs
    (e.g. WinGet Links), so shutil.which() can return None even though ffprobe is
    installed. Fall back to common install locations and the FFPROBE env var.
    """
    if _FFPROBE_CACHE:
        return _FFPROBE_CACHE[0]
    found = shutil.which("ffprobe") or os.environ.get("FFPROBE")
    if not found:
        exe = "ffprobe.exe" if os.name == "nt" else "ffprobe"
        candidates = []
        home = os.path.expanduser("~")
        if os.name == "nt":
            candidates += [
                os.path.join(home, "AppData", "Local", "Microsoft", "WinGet", "Links", exe),
                r"C:\ffmpeg\bin\ffprobe.exe",
                r"C:\Program Files\ffmpeg\bin\ffprobe.exe",
            ]
        else:
            candidates += ["/usr/bin/ffprobe", "/usr/local/bin/ffprobe", "/opt/homebrew/bin/ffprobe"]
        for c in candidates:
            if c and os.path.isfile(c):
                found = c
                break
    _FFPROBE_CACHE.append(found)
    return found


def _read_video_ffprobe(path: str) -> dict[str, Any]:
    """Extract video info (duration, resolution, codec, fps) and embedded metadata via ffprobe."""
    ffprobe = _find_ffprobe()
    if ffprobe is None:
        return {}
    try:
        cmd = [
            ffprobe, "-v", "quiet",
            "-print_format", "json",
            "-show_format", "-show_streams",
            path,
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
        if result.returncode != 0:
            return {}
        data = json.loads(result.stdout)
    except Exception:
        return {}

    info: dict[str, Any] = {}

    # Duration from format
    fmt = data.get("format", {})
    dur = fmt.get("duration")
    if dur:
        try:
            secs = float(dur)
            mins, s = divmod(int(secs), 60)
            hrs, mins = divmod(mins, 60)
            if hrs:
                info["duration"] = f"{hrs}:{mins:02d}:{s:02d}"
            else:
                info["duration"] = f"{mins}:{s:02d}"
            info["duration_seconds"] = round(secs, 2)
        except (ValueError, TypeError):
            pass

    # Extract embedded metadata from container comment tag
    # VHS_VideoCombine embeds {"prompt": ..., "workflow": ...} as JSON in format.tags.comment
    # Note: mp4 uses lowercase "comment", webm/matroska uses uppercase "COMMENT"
    tags = fmt.get("tags", {})
    comment = tags.get("comment", "") or tags.get("COMMENT", "") or tags.get("Comment", "")
    if not comment:
        # Some savers write the metadata into per-stream tags instead of the
        # container's format tags — check those too (also try "description").
        for stream in data.get("streams", []):
            stags = stream.get("tags") or {}
            comment = (stags.get("comment", "") or stags.get("COMMENT", "")
                       or stags.get("description", "") or stags.get("DESCRIPTION", ""))
            if comment:
                break
        if not comment:
            comment = tags.get("description", "") or tags.get("DESCRIPTION", "")
    if comment:
        try:
            comment_data = json.loads(comment)
            if isinstance(comment_data, dict):
                if "prompt" in comment_data:
                    info["prompt"] = comment_data["prompt"]
                if "workflow" in comment_data:
                    info["workflow"] = comment_data["workflow"]
        except (json.JSONDecodeError, ValueError):
            pass

    # ComfyUI's core SaveVideo node writes "prompt" and "workflow" as their own
    # metadata keys (mp4 mdta atoms) instead of a combined "comment" JSON —
    # ffprobe surfaces them as format tags under those exact names.
    for key in ("prompt", "workflow"):
        if key in info:
            continue
        v = tags.get(key) or tags.get(key.upper())
        if isinstance(v, str) and v.strip():
            parsed_v = _json_best_effort(v)
            if isinstance(parsed_v, dict):
                info[key] = parsed_v

    # Find video stream
    for stream in data.get("streams", []):
        if stream.get("codec_type") != "video":
            continue
        w = stream.get("width")
        h = stream.get("height")
        if w and h:
            info["resolution"] = f"{w}×{h}"
        codec = stream.get("codec_name")
        if codec:
            info["codec"] = codec
        # FPS from r_frame_rate or avg_frame_rate
        for fps_key in ("r_frame_rate", "avg_frame_rate"):
            fps_str = stream.get(fps_key)
            if fps_str and "/" in fps_str:
                try:
                    num, den = fps_str.split("/")
                    fps = float(num) / float(den)
                    if 0 < fps < 1000:
                        info["fps"] = round(fps, 2)
                        break
                except (ValueError, ZeroDivisionError):
                    pass
        # Total frames
        nb = stream.get("nb_frames")
        if nb:
            try:
                info["total_frames"] = int(nb)
            except (ValueError, TypeError):
                pass
        break  # Only first video stream

    return info


# ── Main entry point ──────────────────────────────────────────────────


def read_metadata_for_file(
    path: str,
    *,
    max_text_chunk_bytes: int,
    max_decompressed_text_bytes: int,
) -> MetadataResult:
    ext = os.path.splitext(path)[1].lower()

    raw_text: dict[str, str] = {}
    parsed: dict[str, Any] = {}
    prompt: Any | None = None
    workflow: Any | None = None

    if ext == ".png":
        raw_text = read_png_text_chunks(
            path,
            max_text_chunk_bytes=max_text_chunk_bytes,
            max_decompressed_text_bytes=max_decompressed_text_bytes,
        )
        for k, v in raw_text.items():
            parsed[k] = _json_best_effort(v)
        if "prompt" in parsed:
            prompt = parsed.get("prompt")
        if "workflow" in parsed:
            workflow = parsed.get("workflow")
        # Some nodes store workflow under "extra_pnginfo" keys.
        if workflow is None:
            for k in ("extra_pnginfo", "EXTRA_PNGINFO"):
                v = parsed.get(k)
                if isinstance(v, dict) and "workflow" in v:
                    workflow = v.get("workflow")
                    break
    elif ext in {".jpg", ".jpeg", ".webp"}:
        parsed = read_image_metadata_best_effort(path)
        prompt = parsed.get("prompt") if isinstance(parsed, dict) else None
        workflow = parsed.get("workflow") if isinstance(parsed, dict) else None
    else:
        # Video files: use ffprobe to extract both technical info and embedded metadata
        video_info = _read_video_ffprobe(path)
        if video_info:
            parsed["video_info"] = video_info
            # Extract prompt/workflow from embedded comment tag
            if "prompt" in video_info:
                prompt = video_info.pop("prompt")
            if "workflow" in video_info:
                workflow = video_info.pop("workflow")

        # Fall back to sidecar JSON if no embedded metadata
        if prompt is None and workflow is None:
            sidecar = read_video_sidecar(path)
            if sidecar is not None:
                parsed["sidecar"] = sidecar
                if isinstance(sidecar, dict):
                    # Standard format: sidecar has "prompt" and/or "workflow" keys
                    prompt = sidecar.get("prompt")
                    workflow = sidecar.get("workflow")
                    # Check for extra_pnginfo wrapper
                    if workflow is None:
                        for k in ("extra_pnginfo", "EXTRA_PNGINFO"):
                            v = sidecar.get(k)
                            if isinstance(v, dict) and "workflow" in v:
                                workflow = v["workflow"]
                                break
                    # If sidecar looks like a prompt dict itself (node_id -> {class_type, inputs})
                    if prompt is None and workflow is None:
                        is_prompt_dict = False
                        for k, v in sidecar.items():
                            if isinstance(v, dict) and "class_type" in v:
                                is_prompt_dict = True
                                break
                        if is_prompt_dict:
                            prompt = sidecar
                    # If sidecar looks like a workflow (has "nodes" key)
                    if prompt is None and workflow is None:
                        if "nodes" in sidecar and isinstance(sidecar.get("nodes"), list):
                            workflow = sidecar

    summary = _extract_summary(prompt, workflow, parsed)

    video_info = parsed.get("video_info") if isinstance(parsed.get("video_info"), dict) else None

    file_w = file_h = None
    if ext in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tiff", ".tif"}:
        try:
            from PIL import Image
            with Image.open(path) as img:
                file_w, file_h = img.size
        except Exception:
            pass

    finalize_summary(summary, video_info=video_info, file_width=file_w, file_height=file_h)

    return MetadataResult(prompt=prompt, workflow=workflow, parsed=parsed, raw_text=raw_text, summary=summary)


def finalize_summary(summary: dict[str, Any], *, video_info: dict | None = None,
                     file_width: int | None = None, file_height: int | None = None) -> None:
    """Apply the file-authoritative post-extraction steps to a summary.

    Pure function (no file I/O) so the ground-truth evaluation can replay it
    with recorded file dimensions: merges video technical info, overrides
    resolution with the file's real size (keeping a differing workflow size as
    generation_resolution), and derives generation size / source fps.
    """
    # Merge video technical info into summary (duration, resolution, codec, fps)
    if video_info:
        for k in ("duration", "duration_seconds", "codec", "fps", "total_frames"):
            if k in video_info:
                summary.setdefault(k, video_info[k])
        # Always use actual video dimensions as authoritative resolution
        # (workflow-inferred resolution from EmptyLatentImage may be wrong).
        # When the workflow-derived resolution DIFFERS from the file's, it is
        # the pre-upscale generation size — keep it as generation_resolution.
        if "resolution" in video_info:
            _gen_res = summary.get("resolution")
            summary["resolution"] = video_info["resolution"]
            if _gen_res and _gen_res != summary["resolution"]:
                summary.setdefault("generation_resolution", _gen_res)
            # Parse width/height from resolution string (e.g. "1920×1080")
            try:
                res_parts = video_info["resolution"].replace("×", "x").split("x")
                if len(res_parts) == 2:
                    summary["width"] = int(res_parts[0])
                    summary["height"] = int(res_parts[1])
                    _derive_generation_resolution(summary, summary["width"], summary["height"])
            except (ValueError, TypeError):
                pass

        # Derive the pre-interpolation source fps: the file's fps is the FINAL
        # (post-interpolation) rate, so source = fps / multiplier when the
        # interpolation node recorded a multiplier but no explicit source_fps.
        _interp = summary.get("interpolation")
        _fps = summary.get("fps")
        if isinstance(_interp, list) and isinstance(_fps, (int, float)) and _fps:
            for _e in _interp:
                if isinstance(_e, dict) and "source_fps" not in _e:
                    try:
                        _mult = float(_e.get("multiplier"))
                    except (TypeError, ValueError):
                        _mult = 0.0
                    if _mult > 1:
                        _src = _fps / _mult
                        _e["source_fps"] = int(_src) if float(_src).is_integer() else round(_src, 2)

    # Always use actual file dimensions as authoritative resolution.
    # Workflow-inferred resolution (e.g., from EmptyLatentImage) shows generation
    # size which may differ from final output (after upscaling, img2img, etc.)
    if file_width and file_height and file_width > 0 and file_height > 0:
        # Keep the workflow/A1111-derived size as the pre-upscale
        # generation resolution when it differs from the file's.
        _gen_res = summary.get("resolution")
        summary["resolution"] = f"{file_width}×{file_height}"
        summary["width"] = file_width
        summary["height"] = file_height
        if _gen_res and _gen_res != summary["resolution"]:
            summary.setdefault("generation_resolution", _gen_res)
        _derive_generation_resolution(summary, file_width, file_height)


def guess_mime(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"
