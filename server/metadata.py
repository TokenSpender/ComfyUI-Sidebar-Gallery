from __future__ import annotations

import ast
import json
import math
import mimetypes
import os
import re
import struct
import zlib
from dataclasses import dataclass
from typing import Any, Optional

from . import comfy_graph
from . import media_av
from . import media_types
from .schema import known_summary_keys

PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Bump whenever the shape or the coverage of a summary changes. Startup compares
# it against the stored one and re-extracts every cached summary on a mismatch.
PARSER_VERSION = 58

_NODE_TEXT_MAX = media_types.NODE_TEXT_MAX

_CN_FIELD_MAX = 4000

@dataclass(frozen=True)
class MetadataResult:
    prompt: Any | None
    workflow: Any | None
    parsed: dict[str, Any]
    raw_text: dict[str, str]
    summary: dict[str, Any]

def _json_best_effort(s: str) -> Any:
    try:
        return json.loads(s)
    except Exception:
        return s

def sanitize_for_json(obj: Any, _depth: int = 0) -> Any:
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
    """A PNG tEXt chunk: a latin-1 keyword, a zero byte, then the text."""
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
    """A PNG zTXt chunk: keyword, a zero byte, a compression method byte, zlib."""
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
    """A PNG iTXt chunk: keyword, zero, compression flag, compression method,
    language tag, zero, translated keyword, zero, then UTF-8 text that is zlib
    compressed when the flag is 1.
    """
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

_PNG_MAX_TEXT_CHUNKS = 64

def read_png_text_chunks(
    path: str,
    *,
    max_text_chunk_bytes: int,
    max_decompressed_text_bytes: int,
    stop_after_keys: set[str] | None = None,
) -> dict[str, str]:
    """Every chunk is a four byte length, a four byte type, the data, and a four
    byte checksum, which is what the seeks step over. Where a keyword appears
    twice the first chunk is the one kept.
    """
    stop_after_keys = stop_after_keys or set()
    found: dict[str, str] = {}
    # The cap on decompressed text also bounds the total kept across chunks
    # on purpose, so the largest honest single chunk still fits while copies
    # of it do not. Each decoder is handed one byte more than what is left,
    # since a chunk has to be inflated before it can be refused and one byte
    # over is the proof it does not fit, and the chunk count bounds that work
    # for a file holding many small ones.
    kept_bytes = 0
    text_chunks = 0

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
                remaining = max_decompressed_text_bytes - kept_bytes
                if length > max_text_chunk_bytes or remaining <= 0:
                    f.seek(length + 4, os.SEEK_CUR)
                    continue
                text_chunks += 1
                if text_chunks > _PNG_MAX_TEXT_CHUNKS:
                    f.seek(length + 4, os.SEEK_CUR)
                    continue

                data = f.read(length)
                f.seek(4, os.SEEK_CUR)

                if ctype_s == "tEXt":
                    k, v = _decode_text_chunk_text(data) if length <= remaining else (None, None)
                elif ctype_s == "zTXt":
                    k, v = _decode_ztxt(data, max_decompressed_bytes=remaining + 1)
                else:
                    k, v = _decode_itxt(data, max_decompressed_bytes=remaining + 1)

                if k and v is not None and k not in found and len(v) <= remaining:
                    found[k] = v
                    kept_bytes += len(v)

                if stop_after_keys and stop_after_keys.issubset(found.keys()):
                    break
            else:
                f.seek(length + 4, os.SEEK_CUR)

            if ctype_s == "IEND":
                break

    return found

def _detect_source_app(parsed: dict, prompt: Any, workflow: Any) -> str:
    """The parameters text is checked from the most specific marker to the least,
    since the apps that write an `App:` or a `Civitai resources` field write the
    plainer fields as well.
    """
    if isinstance(prompt, dict):
        for v in prompt.values():
            if isinstance(v, dict) and "class_type" in v:
                return "comfyui"

    params_text = ""
    if isinstance(parsed, dict):
        pt = parsed.get("parameters")
        if isinstance(pt, str):
            params_text = pt

    if params_text:
        app_match = re.search(r"\bApp:\s*([^,\n]+)", params_text)
        if app_match:
            app_name = app_match.group(1).strip().lower()
            if "sd.next" in app_name or "sdnext" in app_name:
                return "sdnext"
            if "forge" in app_name:
                return "forge"
            if "fooocus" in app_name:
                return "fooocus"

        ver_match = re.search(r"\bVersion:\s*([^\s,]+)", params_text)
        if ver_match:
            ver = ver_match.group(1).strip().lower()
            # Forge stamps its own version, which starts with an f and a digit,
            # or with neo for the Neo line.
            if re.match(r"^f\d", ver) or ver.startswith("neo"):
                return "forge"

        if "Civitai resources" in params_text:
            return "civitai"

        if re.search(r"\bSteps:\s*\d+", params_text):
            return "a1111"

    if isinstance(parsed, dict):
        # Fooocus writes its own keys instead of a parameters line, either at
        # the top level or inside a comment object.
        if "Prompt" in parsed and "Negative Prompt" in parsed:
            return "fooocus"
        comment = parsed.get("comment")
        if isinstance(comment, dict) and "Prompt" in comment:
            return "fooocus"

    return "unknown"

# A key is bounded so a run of ordinary text with no colon costs the scan a
# fixed amount per position instead of the rest of the line.
_A1111_KEY = r"[A-Za-z][A-Za-z0-9 _/\-]{0,79}?"
_A1111_QUOTED_RE = re.compile(r'(' + _A1111_KEY + r'):\s*"((?:[^"\\]|\\.)*)"')
_A1111_KV_RE = re.compile(
    r"(" + _A1111_KEY + r"):\s*((?:[^,]|,(?!\s*" + _A1111_KEY + r":\s))+)")

def _take_quoted_settings(settings_str: str) -> tuple[dict[str, str], str]:
    quoted_keys: dict[str, str] = {}
    parts: list[str] = []
    pos = 0
    for m in _A1111_QUOTED_RE.finditer(settings_str):
        key = m.group(1).strip().lower().replace(" ", "_")
        quoted_keys[key] = m.group(2).strip()
        parts.append(settings_str[pos:m.start()])
        end = m.end()
        trail = settings_str[end:].lstrip()
        if trail.startswith(","):
            end = len(settings_str) - len(trail) + 1
        pos = end
    parts.append(settings_str[pos:])
    return quoted_keys, "".join(parts)

def _parse_a1111_parameters(params_text: str) -> dict[str, Any]:
    """The text runs positive prompt, then a `Negative prompt:` line, then one
    settings line of `Key: value` pairs separated by commas, which starts at
    `Steps:`. Every part after the first is optional.
    """
    result: dict[str, Any] = {}
    if not params_text or not isinstance(params_text, str):
        return result

    params_text = params_text.replace("\r\n", "\n").replace("\r", "\n")

    neg_match = re.search(r"Negative prompt:\s*(.*)", params_text, re.DOTALL)
    if neg_match:
        positive = params_text[: neg_match.start()].strip()
        rest = neg_match.group(1)
        steps_match = re.search(r"\nSteps:\s*", rest)
        if steps_match:
            negative = rest[: steps_match.start()].strip()
            settings_str = rest[steps_match.start():].strip()
        else:
            lines = rest.strip().split("\n")
            if len(lines) > 1 and re.match(r"^[A-Z][^:]+:\s", lines[-1]):
                negative = "\n".join(lines[:-1]).strip()
                settings_str = lines[-1].strip()
            else:
                negative = rest.strip()
                settings_str = ""
    else:
        # Some writers rule off the negative prompt with a dashed line instead
        # of naming it.
        dash_match = re.search(r"\n\s*---+\s*", params_text)
        if dash_match:
            positive = params_text[: dash_match.start()].strip()
            rest = params_text[dash_match.end():].strip()
            steps_match = re.search(r"\nSteps:\s*", rest)
            if steps_match:
                negative = rest[: steps_match.start()].strip()
                settings_str = rest[steps_match.start():].strip()
            else:
                lines = rest.split("\n")
                if len(lines) > 1 and re.match(r"^[A-Z][^:]+:\s", lines[-1]):
                    negative = "\n".join(lines[:-1]).strip()
                    settings_str = lines[-1].strip()
                else:
                    negative = rest.strip()
                    settings_str = ""
        else:
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

    if settings_str:
        quoted_keys = {}
        clean_str = settings_str
        # A quoted value holds commas of its own, so those pairs are taken out
        # whole, along with the comma that followed them.
        if '"' in settings_str:
            quoted_keys, clean_str = _take_quoted_settings(settings_str)

        result.update(quoted_keys)

        kv_pattern = _A1111_KV_RE.findall(clean_str)
        for k, v in kv_pattern:
            key = k.strip().lower().replace(" ", "_")
            val = v.strip().rstrip(",")
            result[key] = val

    return result

def _safe_float(v: Any) -> float | None:
    if v is None:
        return None
    try:
        return float(v)
    except (ValueError, TypeError):
        return None

def _safe_int(v: Any) -> int | None:
    if v is None:
        return None
    try:
        return int(float(v))
    except (ValueError, TypeError):
        return None

def _pop_first(d: dict[str, Any], *keys: str) -> Any:
    """Take the first of these keys that has a value, and remove all of them."""
    val = None
    for k in keys:
        v = d.pop(k, None)
        if val is None and v is not None:
            val = v
    return val

def _append_structured(summary: dict[str, Any], key: str, entry: dict[str, Any]) -> None:
    cur = summary.get(key)
    if not isinstance(cur, list):
        cur = summary[key] = []
    cur.append(entry)

def _normalize_a1111_to_structured(summary: dict[str, Any]) -> None:
    if summary.get("samplers"):
        return

    sampler_name = _pop_first(summary, "sampler_name", "sampler")
    # Newer writers put the scheduler in a `Schedule type` field of its own.
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
            sampler_entry["denoise"] = denoise
        summary["samplers"] = [sampler_entry]

    if shift is not None and summary.get("samplers"):
        summary["samplers"][0]["shift"] = shift

    loras = summary.get("loras")
    # A quoted `Loras` field holds the whole list as one string of comma
    # separated `name: weight` pairs.
    if isinstance(loras, str):
        entries: list[Any] = []
        for seg in loras.split(","):
            seg = seg.strip()
            if not seg:
                continue
            name, sep, weight = seg.rpartition(":")
            strength = _safe_float(weight) if sep else None
            if sep and name.strip() and strength is not None:
                entries.append({"name": name.strip(), "strength_model": strength})
            else:
                entries.append(seg)
        loras = summary["loras"] = entries
    if loras and isinstance(loras, list):
        structured_loras = []
        for l in loras:
            if isinstance(l, dict) and "name" in l:
                structured_loras.append(l)
            elif isinstance(l, str):
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

    detailer_model = summary.pop("detailer", None)
    detailer_steps = _safe_int(summary.pop("detailer_steps", None))
    detailer_strength = _safe_float(summary.pop("detailer_strength", None))
    if detailer_model:
        ad_entry: dict[str, Any] = {"model": str(detailer_model)}
        if detailer_steps is not None:
            ad_entry["steps"] = detailer_steps
        if detailer_strength is not None:
            ad_entry["denoise"] = detailer_strength
        _append_structured(summary, "adetailer", ad_entry)

    # A detailer pass past the first repeats its keys under these suffixes.
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
        _append_structured(summary, "adetailer", ad_entry)
    for k in list(summary.keys()):
        if k.startswith("adetailer_"):
            summary.pop(k, None)
    if isinstance(summary.get("adetailer"), str):
        summary.pop("adetailer", None)

    # The numbered `module_N` keys list the extra models loaded beside the
    # checkpoint, and only the name says whether one is the VAE or an encoder.
    _module_keys = sorted((k for k in summary if re.fullmatch(r"module_\d+", k)),
                          key=lambda k: int(k.split("_")[1]))
    for _mk in _module_keys:
        _mv = summary.pop(_mk)
        if not (isinstance(_mv, str) and _mv.strip()) or _mv.strip().lower() == "none":
            continue
        _mv = _mv.strip()
        _low = _mv.lower()
        if _low == "ae" or "vae" in _low:
            summary.setdefault("vae", _mv)
        else:
            _cl = summary.get("clip_models")
            if isinstance(_cl, str):
                _cl = [p.strip() for p in _cl.split(",") if p.strip()]
                summary["clip_models"] = _cl
            elif not isinstance(_cl, list):
                _cl = summary["clip_models"] = []
            if _mv not in _cl:
                _cl.append(_mv)

    # Each ControlNet unit arrives as one quoted string of `Key: value` pairs
    # under a numbered key.
    for cn_idx in range(4):
        cn_key = f"controlnet_{cn_idx}" if cn_idx > 0 else "controlnet_0"
        cn_raw = summary.pop(cn_key, None)
        if not cn_raw:
            if cn_idx == 0:
                continue
            break
        cn_entry: dict[str, Any] = {}
        raw_str = str(cn_raw).strip().strip('"')
        if len(raw_str) > _CN_FIELD_MAX:
            raw_str = raw_str[:_CN_FIELD_MAX]
        cn_map: dict[str, str] = {}
        # A value can hold commas, so the string only breaks at a comma that a
        # capitalised key name follows.
        for seg in re.split(r',\s*(?=[A-Z][A-Za-z ]*:)', raw_str):
            key, sep, val = seg.partition(':')
            if not sep:
                continue
            key = key.strip()
            if key and all(c.isalpha() or c == ' ' for c in key):
                cn_map[key.lower().replace(' ', '_')] = val.strip()
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
            _append_structured(summary, 'controlnet', cn_entry)
    for k in list(summary.keys()):
        if k.startswith('controlnet_') or k in ('control_mode', 'guidance_start', 'guidance_end',
                                                  'pixel_perfect', 'resize_mode', 'processor_res',
                                                  'threshold_a', 'threshold_b', 'weight',
                                                  'hr_option'):
            summary.pop(k, None)
    if isinstance(summary.get('controlnet'), str):
        summary.pop('controlnet', None)

    size = summary.pop("size", None)
    if size and not summary.get("resolution"):
        if isinstance(size, str) and "x" in size.lower():
            summary["resolution"] = size.replace("x", "×").replace("X", "×")
            try:
                parts = size.lower().split("x")
                if len(parts) == 2:
                    summary.setdefault("width", int(parts[0].strip()))
                    summary.setdefault("height", int(parts[1].strip()))
            except (ValueError, TypeError):
                pass

def _extract_summary(prompt: Any, workflow: Any, parsed: dict) -> dict[str, Any]:
    """The graph is read first and the parameters text fills what it left empty,
    apart from the positive prompt, which the text takes.
    """
    summary: dict[str, Any] = {}

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

    summary["source_app"] = _detect_source_app(parsed, p, w)

    a1111: dict[str, Any] = {}
    if isinstance(parsed, dict):
        params_text = parsed.get("parameters")
        if isinstance(params_text, str) and params_text.strip():
            a1111 = _parse_a1111_parameters(params_text)
            if a1111:
                pos = a1111.get("positive_prompt", "")
                if isinstance(pos, str):
                    lora_tags = re.findall(r"<lora:([^:>]+)(?::([^>]*))?>", pos)
                    if lora_tags:
                        loras = []
                        seen_tags: set[tuple[str, str]] = set()
                        for name, weight in lora_tags:
                            tag_key = (name.strip(), weight or "")
                            if tag_key in seen_tags:
                                continue
                            seen_tags.add(tag_key)
                            entry: dict[str, Any] = {"name": name.strip()}
                            if weight:
                                try:
                                    entry["strength_model"] = float(weight)
                                except ValueError:
                                    pass
                            loras.append(entry)
                        a1111.setdefault("loras", loras)
                    # The line with its lora tags still in place, which the
                    # merge compares against the negative word for word.
                    a1111["_positive_raw"] = pos
                    cleaned_pos = re.sub(r'<lora:[^>]+>', '', pos).strip()
                    cleaned_pos = re.sub(r',\s*,', ',', cleaned_pos).strip(' ,')
                    if not cleaned_pos:
                        a1111.pop("positive_prompt", None)
                    else:
                        a1111["positive_prompt"] = cleaned_pos

    if a1111:
        a1111["source_app"] = summary["source_app"]
        _normalize_a1111_to_structured(a1111)
        a1111.pop("source_app", None)

    if isinstance(p, dict):
        _extract_from_comfyui_prompt(p, summary)

    if p is None and isinstance(w, dict) and "nodes" in w and not summary.get("positive_prompt"):
        _recon = _workflow_to_prompt(w, comfy_graph.get_registry())
        if _recon:
            _extract_from_comfyui_prompt(_recon, summary)
            if summary.get("source_app") in (None, "unknown"):
                summary["source_app"] = "comfyui"
            p = _recon

    # The generated size is the latent size going into the first sampler that
    # ran.
    if isinstance(p, dict) and "resolution" not in summary:
        _gr = comfy_graph.find_generation_resolution(
            p, comfy_graph.get_registry(),
            legacy_dim_fn=lambda ref, axis: _resolve_dimension_ref(p, ref, axis))
        if _gr:
            summary["resolution"] = f"{_gr[0]}×{_gr[1]}"
            summary.setdefault("width", _gr[0])
            summary.setdefault("height", _gr[1])

    # The workflow pass reads widget values, which are whatever was last typed
    # into the editor. A node whose width or height came down a link ran with
    # another number, and a node absent from the prompt did not run at all.
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

    _merge_a1111_summary(summary, a1111)

    if summary.get("source_app") == "civitai":
        _apply_civitai_resources(summary)

    # A response carrying the summary alone still has to say whether the file
    # holds a prompt and a workflow, and the lightbox turns its workflow
    # buttons on from `has_workflow`.
    if (isinstance(p, dict) and p) or (isinstance(prompt, str) and prompt.strip()):
        summary["has_prompt"] = True
    if (isinstance(w, dict) and w) or (isinstance(workflow, str) and workflow.strip()):
        summary["has_workflow"] = True

    _final_summary_cleanup(summary)

    return summary

# Read from the catalog on first use, so importing this module reads no file.
_known_summary_keys_cache: frozenset | None = None

def _known_summary_keys() -> frozenset:
    global _known_summary_keys_cache
    if _known_summary_keys_cache is None:
        _known_summary_keys_cache = frozenset(known_summary_keys())
    return _known_summary_keys_cache

def _merge_a1111_summary(summary: dict[str, Any], a1111: dict[str, Any]) -> None:
    """The positive prompt is the exception and replaces the graph's, while the
    negative prompt and every other key only fill a gap.
    """
    if not a1111:
        return
    pos_t = a1111.pop("positive_prompt", None)
    pos_raw = a1111.pop("_positive_raw", None)
    neg_t = a1111.pop("negative_prompt", None)
    if isinstance(pos_t, str) and pos_t.strip():
        def _core(s):
            return re.sub(r'<lora:[^>]+>', '', s or '').strip()
        # Where the text gives one prompt as both positive and negative and the
        # graph holds it as the negative, the graph's positive stands.
        _repeated = bool(_core(pos_t)) and _core(pos_t) == _core(neg_t if isinstance(neg_t, str) else "")
        _is_graph_negative = (_repeated and summary.get("negative_prompt")
                              and _core(summary["negative_prompt"]) == _core(pos_t))
        if not (_is_graph_negative and summary.get("positive_prompt")):
            summary["positive_prompt"] = pos_t.strip()
    if isinstance(neg_t, str) and neg_t.strip():
        _pos_cmp = pos_raw if isinstance(pos_raw, str) else pos_t
        if neg_t.strip() != (_pos_cmp.strip() if isinstance(_pos_cmp, str) else summary.get("positive_prompt")):
            summary.setdefault("negative_prompt", neg_t.strip())
    for k, v in a1111.items():
        if v is None:
            continue
        summary.setdefault(k, v)

_CIVITAI_LORA_TYPES = frozenset({"lora", "locon", "lycoris", "dora"})

def _apply_civitai_resources(summary: dict[str, Any]) -> None:
    """Read the `Civitai resources` field, a JSON list of the models used."""
    raw = summary.get("civitai_resources")
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except (ValueError, TypeError):
            return
    if not isinstance(raw, list):
        return

    checkpoint: Optional[str] = None
    loras: list[dict[str, Any]] = []
    for r in raw:
        if not isinstance(r, dict):
            continue
        name = r.get("modelName") or r.get("name")
        if not name:
            continue
        name = str(name)
        rtype = str(r.get("type", "")).lower()
        if rtype == "checkpoint":
            if checkpoint is None:
                checkpoint = name
        elif rtype in _CIVITAI_LORA_TYPES:
            entry: dict[str, Any] = {"name": name}
            weight = r.get("weight")
            if isinstance(weight, (int, float)) and not isinstance(weight, bool):
                entry["strength_model"] = float(weight)
            loras.append(entry)

    if checkpoint and not summary.get("model"):
        summary["model"] = checkpoint
    if loras and not summary.get("loras"):
        summary["loras"] = loras

def _final_summary_cleanup(summary: dict[str, Any]) -> None:
    if summary.get("initial_prompt") and summary.get("initial_prompt") == summary.get("positive_prompt"):
        del summary["initial_prompt"]

    # A VAE that only an upscale pass loaded is that pass's, so it is dropped
    # from the top of the summary unless the graph named one for the generation.
    _graph_vae = summary.pop("_vae_graph", None)
    _ups = summary.get("upscaling")
    if summary.get("vae") and summary["vae"] != _graph_vae and isinstance(_ups, list) and any(
            isinstance(u, dict) and u.get("vae") == summary["vae"] for u in _ups):
        if _graph_vae:
            summary["vae"] = _graph_vae
        else:
            del summary["vae"]

    extra = summary.get("extra", {})
    if not isinstance(extra, dict):
        extra = {}

    for k in list(summary.keys()):
        if k not in _known_summary_keys():
            extra[k] = summary.pop(k)

    if extra:
        summary["extra"] = extra
    elif "extra" in summary:
        del summary["extra"]

def _resolve_ref(prompt: dict, ref: Any) -> dict | None:
    """An input in the prompt is either a literal or a link, and a link is the two
    element list of the source node's id and its output slot.
    """
    if isinstance(ref, list) and len(ref) >= 1:
        node_id = str(ref[0])
        return prompt.get(node_id)
    return None

# A pipe node bundles several values into one link and another unpacks them.
# The graph module owns that demux.
_PIPE_FROM_PATTERN = comfy_graph.PIPE_FROM_PATTERN
_PIPE_TO_PATTERN = comfy_graph.PIPE_TO_PATTERN
_demux_pipe_ref = comfy_graph.demux_pipe_ref

def _guider_model_src(prompt: dict, g: Any) -> Any:
    """The model a guider was built from, for a sampler that takes no model."""
    for _ in range(8):
        g = _demux_pipe_ref(prompt, g)
        if not isinstance(g, list):
            return None
        gn = _resolve_ref(prompt, g)
        if not isinstance(gn, dict):
            return None
        ct = str(gn.get("class_type", ""))
        try:
            role = comfy_graph.classify(ct, comfy_graph.get_registry().sig(ct))
        except Exception:
            role = None
        if role == "switch" or "switch" in ct.lower():
            g = comfy_graph.live_switch_branch(prompt, gn, comfy_graph.get_registry())
            continue
        return (gn.get("inputs") or {}).get("model")
    return None

def _trace_model_shift(prompt: dict, model_ref: Any) -> float | None:
    ref = model_ref
    seen: set[str] = set()
    for _ in range(16):
        ref = _demux_pipe_ref(prompt, ref)
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
            if isinstance(shift, list):
                shift = _resolve_scalar_smart(prompt, shift)
            return _safe_float(shift)
        nxt = inputs.get("model")
        if not isinstance(nxt, list):
            for _k in ("model1", "MODEL", "patched_model", "model_a"):
                if isinstance(inputs.get(_k), list):
                    nxt = inputs.get(_k)
                    break
        ref = nxt
    return None

def _collect_model_chain_nids(prompt: dict, model_ref: Any, max_depth: int = 24) -> list[str]:
    """Every node a model passed through, from the sampler back to its loader."""
    nids: list[str] = []
    ref = model_ref
    seen: set[str] = set()
    for _ in range(max_depth):
        ref = _demux_pipe_ref(prompt, ref)
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
            ct = str(node.get("class_type", ""))
            ct_l = ct.lower()
            try:
                _role = comfy_graph.classify(ct, comfy_graph.get_registry().sig(ct))
            except Exception:
                _role = None
            if _role == "switch" or "switch" in ct_l:
                nxt = comfy_graph.live_switch_branch(
                    prompt, node, comfy_graph.get_registry())
            elif _role == "reroute" or "reroute" in ct_l:
                for v in inputs.values():
                    if isinstance(v, list) and len(v) >= 1:
                        nxt = v
                        break
            elif "context" in ct_l:
                for _k in ("base_ctx", "ctx", "context"):
                    if isinstance(inputs.get(_k), list):
                        nxt = inputs.get(_k)
                        break
        ref = nxt
    return nids

def _compute_high_low_roles(prompt: dict, sampler_passes: list[dict],
                            model_loader_ids: dict[str, str]) -> dict[str, str]:
    """Label the passes of a two model run as the high and the low noise half.

    A pass that adds no noise, starts partway through the schedule, or takes its
    latent from another pass, is the low noise one. The labels are only returned
    when both halves are present, every pass reaches a model loader, and the two
    halves share none.
    """
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
            return "low"
        return "high"

    roles = {p["nid"]: _role(p) for p in sampler_passes}
    if "high" not in roles.values() or "low" not in roles.values():
        return {}

    def _model_src(p: dict):
        src = p.get("model_ref")
        if not isinstance(src, list):
            src = _guider_model_src(prompt, p.get("guider_ref"))
        return src

    pass_chains = {p["nid"]: _collect_model_chain_nids(prompt, _model_src(p))
                   for p in sampler_passes}
    hi_models: set[str] = set()
    lo_models: set[str] = set()
    for p in sampler_passes:
        models = {n for n in pass_chains[p["nid"]] if n in model_loader_ids}
        if not models:
            return {}
        (hi_models if roles[p["nid"]] == "high" else lo_models).update(models)
    if not (hi_models and lo_models) or (hi_models & lo_models):
        return {}

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
    found: set[str] = set()
    queue: list = [start_ref]
    seen: set[str] = set()
    steps = 0
    while queue and steps < max_nodes:
        steps += 1
        ref = _demux_pipe_ref(prompt, queue.pop(0))
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
        if role == "switch" or "switch" in ct_l:
            sel = comfy_graph.live_switch_branch(
                prompt, node, comfy_graph.get_registry())
            if sel is not None:
                queue.append(sel)
        elif role == "reroute" or "reroute" in ct_l:
            for v in inputs.values():
                if isinstance(v, list) and len(v) >= 1:
                    queue.append(v)
                    break
        else:
            followed = False
            for k in ("model", "model1", "model2", "model_a", "model_b",
                      "MODEL", "patched_model", "unet"):
                v = inputs.get(k)
                if isinstance(v, list) and len(v) >= 1:
                    queue.append(v)
                    followed = True
            if not followed and "context" in ct_l:
                for k in ("base_ctx", "ctx", "context"):
                    v = inputs.get(k)
                    if isinstance(v, list) and len(v) >= 1:
                        queue.append(v)
                        break
    return found

def _resolve_active_model_loaders(prompt: dict, sampler_passes: list[dict],
                                  model_loader_ids: dict[str, str]) -> tuple[set[str], bool]:
    """A graph may load models it never samples with. Narrowing the list to the
    ones reached is only safe once every pass resolved to at least one loader.
    """
    active: set[str] = set()
    safe = True
    saw_any = False
    for p in sampler_passes:
        src = p.get("model_ref")
        if not isinstance(src, list):
            src = _guider_model_src(prompt, p.get("guider_ref"))
        if not isinstance(src, list):
            safe = False
            continue
        saw_any = True
        loaders = _walk_model_loaders(prompt, src, model_loader_ids)
        if loaders:
            active |= loaders
        else:
            safe = False
    return active, (safe and saw_any and bool(active))

def _trace_pass_lineage(prompt: dict, start_nid: str, pass_nids: set[str],
                        max_nodes: int = 400) -> set[str]:
    """Another pass is recorded and not walked through, so what comes back is the
    work this pass added plus the passes it was handed.
    """
    start = prompt.get(start_nid)
    ins = start.get("inputs") if isinstance(start, dict) else None
    queue = [v for v in ins.values() if isinstance(v, list) and v] if isinstance(ins, dict) else []
    visited: set[str] = set()
    while queue and len(visited) < max_nodes:
        ref = _demux_pipe_ref(prompt, queue.pop(0))
        if not (isinstance(ref, list) and ref):
            continue
        nid = str(ref[0])
        if nid in visited:
            continue
        visited.add(nid)
        if nid in pass_nids:
            continue
        node = prompt.get(nid)
        nins = node.get("inputs") if isinstance(node, dict) else None
        if isinstance(nins, dict):
            for v in nins.values():
                if isinstance(v, list) and v:
                    queue.append(v)
    return visited

_INTERP_CLASS_PATTERNS = ("interpolat", "vfi", "rife")

def _stage_from_lineage(prompt: dict, lineage: set[str]) -> str | None:
    stage = None
    for nid in lineage:
        node = prompt.get(nid)
        if not isinstance(node, dict):
            continue
        ct = str(node.get("class_type", "")).lower()
        if any(p in ct for p in _INTERP_CLASS_PATTERNS):
            return "interpolation"
        if ("upsampl" in ct or "upscale" in ct) and "loader" not in ct:
            um = (node.get("inputs") or {}).get("upscale_model")
            if isinstance(um, list):
                un = _resolve_ref(prompt, um)
                if (isinstance(un, dict)
                        and "temporal" in str((un.get("inputs") or {}).get("model_name", "")).lower()):
                    return "interpolation"
            stage = "upscale"
    return stage

_MODEL_FILE_EXTS = (".safetensors", ".gguf", ".ckpt", ".pt", ".pth", ".bin", ".sft", ".onnx")
# Encoder names belonging to taggers and captioners, excluded from the text encoders.
_CLIP_TAGGER_PATTERNS = ("joytag", "joytagg", "florence", "blip", "tagger",
                         "captioner", "caption", "wd14", "recognize")
_CLIP_INPUT_KEYS = {"clip", "clip_l", "clip_g", "clip1", "clip2"}

def _looks_like_model_file(v: Any) -> bool:
    if not isinstance(v, str):
        return False
    return ("/" in v or "\\" in v) or v.lower().endswith(_MODEL_FILE_EXTS)

def _resolve_clip_source(prompt: dict, clip_ref: Any, max_nodes: int = 80) -> tuple[list[str], bool, list[str]]:
    """Returns the encoder names, whether the walk ended at a checkpoint that has
    its encoder baked in and so names no file, and any text projection files.
    """
    names: list[str] = []
    projections: list[str] = []
    baked = False
    queue: list = [clip_ref]
    seen: set[str] = set()
    steps = 0
    while queue and steps < max_nodes:
        steps += 1
        ref = _demux_pipe_ref(prompt, queue.pop(0))
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
        if "checkpointloader" in ct_l:
            baked = True
            continue
        if ("cliploader" in ct_l or "dualcliploader" in ct_l
                or "tripleclip" in ct_l or "quadruplecliploader" in ct_l):
            # A dual loader set to ltxv takes a text encoder in its first slot
            # and a text projection in its second.
            _ltxv_dual = ("dualcliploader" in ct_l
                          and str(inputs.get("type", "")).lower() == "ltxv")
            for k in ("clip_name", "clip_name1", "clip_name2", "clip_name3", "clip_name4"):
                v = inputs.get(k)
                if isinstance(v, str) and v.strip():
                    if _ltxv_dual and k == "clip_name2":
                        projections.append(v.strip())
                    else:
                        names.append(v.strip())
            continue
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
            # A switch counts as followed even where no branch can be chosen,
            # since the leaf scan below would take its own widgets for encoder
            # file names.
            if _role == "switch" or "switch" in ct_l:
                followed = True
                sel = comfy_graph.live_switch_branch(
                    prompt, node, comfy_graph.get_registry())
                if sel is not None:
                    queue.append(sel)
            elif _role == "reroute" or "reroute" in ct_l:
                for v in inputs.values():
                    if isinstance(v, list) and len(v) >= 1:
                        queue.append(v)
                        followed = True
                        break
        # A loader from a node pack names its file in a widget of its own, so
        # the value that looks like a model path is the encoder.
        if not followed:
            _proj = inputs.get("text_projection")
            if _looks_like_model_file(_proj):
                projections.append(_proj.strip())
            for k, v in inputs.items():
                if k == "text_projection":
                    continue
                if _looks_like_model_file(v):
                    names.append(v.strip())
                    break
    out: list[str] = []
    for n in names:
        if any(t in n.lower() for t in _CLIP_TAGGER_PATTERNS):
            continue
        if n not in out:
            out.append(n)
    proj_out: list[str] = []
    for n in projections:
        if n not in proj_out:
            proj_out.append(n)
    return out, baked, proj_out

def _resolve_vae_source(prompt: dict, vae_ref: Any, max_nodes: int = 40) -> str | None:
    queue: list = [vae_ref]
    seen: set[str] = set()
    steps = 0
    while queue and steps < max_nodes:
        steps += 1
        ref = _demux_pipe_ref(prompt, queue.pop(0))
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
        if "vaeloader" in ct_l:
            v = inputs.get("vae_name")
            if isinstance(v, str) and v.strip():
                return v.strip()
            continue
        # A checkpoint's VAE is inside the checkpoint and has no name of its own.
        if "checkpointloader" in ct_l:
            continue
        followed = False
        for k in ("vae", "audio_vae", "vae_model"):
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
            if _role == "switch" or "switch" in ct_l:
                sel = comfy_graph.live_switch_branch(
                    prompt, node, comfy_graph.get_registry())
                if sel is not None:
                    queue.append(sel)
            elif _role == "reroute" or "reroute" in ct_l:
                for v in inputs.values():
                    if isinstance(v, list) and len(v) >= 1:
                        queue.append(v)
                        break
    return None

def _find_input_name_in_chain(prompt: dict, start_ref: Any, input_key: str, max_depth: int = 5) -> str | None:
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
        for alt_key in ("control_net_name", "controlnet", "model_name", "ckpt_name", "lora_name"):
            val = inputs.get(alt_key)
            if isinstance(val, str):
                return val
        next_ref = inputs.get(input_key)
        if isinstance(next_ref, list):
            ref = next_ref
        else:
            break
    return None

def _find_preprocessor_in_chain(prompt: dict, start_ref: Any, max_depth: int = 8) -> str | None:
    """The all-in-one preprocessor names its choice in a widget. Every other one is
    a node per method, so the class name is the answer.
    """
    PREPROCESSOR_KEYWORDS = {
        "canny", "depth", "openpose", "lineart", "hed", "scribble", "tile",
        "shuffle", "pidinet", "midas", "zoe", "normalbae", "mlsd", "densepose",
        "dwpose", "mediapipe", "anyline", "teed", "segment", "binary", "color",
        "recolor", "metric3d", "dsine", "diffusion_edge", "preprocessor",
    }

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

        ct = node.get("class_type", "")
        ct_lower = ct.lower()
        inputs = node.get("inputs", {})

        if "aio_preprocessor" in ct_lower or "aux_preprocessor" in ct_lower:
            prep_name = inputs.get("preprocessor")
            if isinstance(prep_name, str) and prep_name.strip():
                return prep_name.strip()
            return ct

        for kw in PREPROCESSOR_KEYWORDS:
            if kw in ct_lower:
                return ct

        if isinstance(inputs, dict):
            img_ref = inputs.get("image")
            if isinstance(img_ref, list):
                queue.append((img_ref, depth + 1))
            for key, val in inputs.items():
                if key == "image":
                    continue
                if isinstance(val, list) and len(val) >= 2:
                    queue.append((val, depth + 1))

    return None

_TEXT_INPUT_KEYS = ("text", "string", "value", "text_positive", "text_negative",
                    "prompt", "text_input", "text_output", "text_0", "text_1",
                    "input_text", "prompt_text")

# A node fed by both a text source and an image would otherwise be walked up
# the image side, which arrives at the prompt that made that image.
_NON_TEXT_LINK_KEYS = {
    "image", "images", "pixels", "model", "clip", "vae", "latent", "samples",
    "mask", "conditioning", "positive", "negative", "control_net", "controlnet",
    "control_image", "sigmas", "noise", "guider", "sampler", "audio",
    "clip_vision", "ipadapter", "style_model", "gligen", "upscale_model",
}

# These write their text while the graph runs, so the file holds their settings
# and never the words they produced.
_RUNTIME_TEXT_NODE_PATTERNS = ("llava", "vlm", "llamasampler", "joycaption",
                               "florence", "cogvlm", "minicpm", "internvl",
                               "qwenvl", "ollama", "promptenhancer",
                               "textgenerate", "llmsampler")

def _is_runtime_text_node(class_type: str) -> bool:
    ct = str(class_type).lower().replace(" ", "").replace("_", "")
    return any(p in ct for p in _RUNTIME_TEXT_NODE_PATTERNS)

# A display node keeps the text it last showed in its own widget, which is the
# only place a run time value is written down.
_SHOW_TEXT_NODE_PATTERNS = ("showtext", "showanything", "display", "textoutput",
                            "stringoutput", "debugtext", "showstring", "show_text",
                            "display_text", "text_display", "previewtext",
                            "was_text", "easy_showanything")

def _is_show_text_node(class_type: str) -> bool:
    ct = str(class_type).lower().replace(" ", "").replace("_", "")
    return any(p in ct for p in _SHOW_TEXT_NODE_PATTERNS)

def _resolve_text_recursive(prompt: dict, start_ref: Any, max_depth: int = 8) -> str | None:
    """A display node's own text is held back as a fallback. Once the walk reaches
    a node that generates its text at run time, even that fallback is given up,
    since it would then be the text of some earlier run.
    """
    queue: list[tuple[Any, int]] = [(start_ref, 0)]
    visited: set[str] = set()
    snapshot_fallback: str | None = None
    reached_runtime = False

    while queue:
        ref, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        ref = _demux_pipe_ref(prompt, ref)
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

        if _is_runtime_text_node(node.get("class_type", "")):
            reached_runtime = True
            continue

        _has_link = any(isinstance(v, list) and len(v) >= 2 for v in inputs.values())
        if _has_link and _is_show_text_node(node.get("class_type", "")):
            if snapshot_fallback is None:
                for txt_key in _TEXT_INPUT_KEYS:
                    val = inputs.get(txt_key)
                    if isinstance(val, str) and val.strip():
                        snapshot_fallback = val
                        break
            for key, val in inputs.items():
                if str(key).lower() in _NON_TEXT_LINK_KEYS:
                    continue
                if isinstance(val, list) and len(val) >= 2:
                    queue.append((val, depth + 1))
            continue

        for txt_key in _TEXT_INPUT_KEYS:
            val = inputs.get(txt_key)
            if isinstance(val, str) and val.strip():
                return val

        for key, val in inputs.items():
            if str(key).lower() in _NON_TEXT_LINK_KEYS:
                continue
            if isinstance(val, list) and len(val) >= 2:
                queue.append((val, depth + 1))

    return None if reached_runtime else snapshot_fallback

_MATH_FUNCS: dict[str, Any] = {
    "min": min, "max": max, "abs": abs, "round": round,
    "floor": math.floor, "ceil": math.ceil,
}

def _safe_eval_expr(expr: str, variables: dict[str, int | float]) -> int | float | None:
    """Evaluate an arithmetic expression that came out of the file."""
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

# A whole float reads as a count in the panel, so it goes in as an integer.
def _normalize_number(x: int | float) -> int | float | None:
    """None for an infinity or a not-a-number, which a file can carry since
    the JSON reader accepts the bare words, and which no field can hold."""
    if isinstance(x, float):
        if not math.isfinite(x):
            return None
        if x == int(x) and abs(x) < 1e12:
            return int(x)
        return round(x, 4)
    return x

_MATH_NODE_PATTERNS = ("mathexpression", "simplemath", "mathformula",
                       "evaluateinteger", "evaluatefloat")
_MATH_EXPR_KEYS = ("expression", "expr", "formula", "python_expression")

def _is_math_node(class_type: str) -> bool:
    ct = str(class_type).lower().replace(" ", "").replace("_", "")
    return any(p in ct for p in _MATH_NODE_PATTERNS)

def _eval_math_node(prompt: dict, node: dict, max_depth: int = 8) -> int | float | None:
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
    # The expression refers to its inputs as a, b, c and d, which is what those
    # sockets are named.
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

_SCALAR_VALUE_KEYS = ("value", "Value", "int", "float", "number", "num",
                      "seed", "noise_seed", "steps", "cfg", "fps",
                      "Xi", "Xf", "x", "text", "string")

_PASSTHROUGH_PRIORITY_KEYS = ("value", "input", "any", "any_01", "source", "signal")

_NON_SCALAR_INPUT_KEYS = {
    "model", "clip", "vae", "latent", "latent_image", "samples", "image", "images",
    "conditioning", "mask", "audio", "sigmas", "noise", "guider", "sampler",
    "pipe", "basic_pipe", "detailer_pipe", "control_net", "controlnet",
    "model_high_noise", "model_low_noise", "clip_vision", "clip_vision_output",
    "start_image", "end_image", "reference_image", "upscale_model",
    "bbox_detector", "sam_model_opt", "segm_detector_opt", "hook_kf", "lora_stack",
    "positive", "negative",
}

# These measure something the run produced, so their stored inputs say nothing
# about the number they handed on.
_RUNTIME_OUTPUT_NODE_PATTERNS = (
    "getimagesize", "getresolution", "getvideoinfo", "getimagesizeandcount",
    "imagesizetonumber", "getlatentsize", "imagedimensions",
)

def _is_runtime_output_node(class_type: str) -> bool:
    ct = str(class_type).lower().replace(" ", "").replace("_", "")
    return any(p in ct for p in _RUNTIME_OUTPUT_NODE_PATTERNS)

def _resolve_scalar_smart(prompt: dict, ref: Any) -> int | float | str | bool | None:
    """Only a node the registry has no signature for, answered UNKNOWN, falls back
    to the walk over literals. UNRESOLVED and NO_VALUE are final, since a value
    computed at run time, split between branches or never set has no literal in
    the file that stands for it.
    """
    r = comfy_graph.resolve_link(prompt, ref, comfy_graph.get_registry())
    if r is comfy_graph.UNKNOWN:
        return _resolve_scalar_ref(prompt, ref)
    if r is comfy_graph.UNRESOLVED or r is comfy_graph.NO_VALUE:
        return None
    return r

def _resolve_scalar_ref(prompt: dict, start_ref: Any, max_depth: int = 8) -> int | float | str | bool | None:
    """Any literal but the usual value names is kept as a fallback while the walk
    carries on, so a passthrough that only forwards a value does not end it.
    """
    queue: list[tuple[Any, int]] = [(start_ref, 0)]
    visited: set[str] = set()
    fallback: int | float | str | bool | None = None

    while queue:
        ref, depth = queue.pop(0)
        if depth >= max_depth:
            continue
        ref = _demux_pipe_ref(prompt, ref)
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

        if _is_runtime_output_node(node.get("class_type", "")):
            continue

        if _is_math_node(node.get("class_type", "")):
            result = _eval_math_node(prompt, node, max_depth=max_depth - depth)
            if result is not None:
                return result

        for k in _SCALAR_VALUE_KEYS:
            v = inputs.get(k)
            if isinstance(v, (bool, int, float)):
                return v
            if isinstance(v, str) and v.strip():
                return v if len(v) <= 500 else v[:500]

        if fallback is None:
            for v in inputs.values():
                if isinstance(v, (bool, int, float)):
                    fallback = v
                    break
                if isinstance(v, str) and v.strip():
                    fallback = v if len(v) <= 500 else v[:500]
                    break

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

_DIM_STRING_RE = comfy_graph._DIM_STRING_RE

def _resolve_dimension_ref(prompt: dict, ref: Any, axis: int) -> int | None:
    """A resolution picker hands on a single string such as 1024x1024, and the
    output slot says which half this link takes.
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

def _chain_reaches(prompt: dict, start_ref: Any, patterns: tuple[str, ...], max_depth: int = 12,
                   accept_decoder: bool = False) -> bool:
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
        if accept_decoder:
            _sig = comfy_graph.get_registry().sig(node.get("class_type", ""))
            if _sig and "IMAGE" in _sig["output_types"] and any(
                    "LATENT" in str(t) for t in _sig["inputs"].values()):
                return True
        inputs = node.get("inputs", {})
        if isinstance(inputs, dict):
            for v in inputs.values():
                if isinstance(v, list) and len(v) >= 1:
                    queue.append((v, depth + 1))
    return False

def _feeds_upscaler_first(prompt: dict, start_nid: str, max_steps: int = 400,
                          consumers: dict[str, list[str]] | None = None) -> bool:
    """The walk runs forward through the consumers and stops at a re-encode or a
    sampler, since past one of those the picture is being generated again.
    """
    if consumers is None:
        consumers = comfy_graph._build_consumers(prompt)
    seen: set[str] = set()
    stack = [str(start_nid)]
    steps = 0
    while stack and steps < max_steps:
        steps += 1
        cur = stack.pop()
        if cur in seen:
            continue
        seen.add(cur)
        for cnid in consumers.get(cur, ()):
            cnd = prompt.get(cnid)
            if not isinstance(cnd, dict):
                continue
            ctl = str(cnd.get("class_type", "")).lower()
            if "upscale" in ctl or "upsampl" in ctl:
                return True
            if "vaeencode" in ctl or "sampler" in ctl:
                continue
            stack.append(cnid)
    return False

def _switch_active_ref(prompt: dict, node: dict) -> Any:
    ref = comfy_graph.live_switch_branch(prompt, node, comfy_graph.get_registry())
    return ref if isinstance(ref, list) and len(ref) >= 1 else None

def _switched_off_nids(prompt: dict, nids: set[str]) -> set[str]:
    """A node counts as off when it can reach an output with the switches ignored
    and cannot reach one with the switches obeyed.
    """
    if not nids:
        return set()
    # Nodes that pass values around without links leave the consumer map
    # incomplete, so nothing can be called unreachable.
    if comfy_graph.has_implicit_links(prompt, comfy_graph.get_registry()):
        return set()
    consumers: dict[str, list[str]] = {}
    for nid, nd in prompt.items():
        if not isinstance(nd, dict) or not isinstance(nd.get("inputs"), dict):
            continue
        for v in nd["inputs"].values():
            if isinstance(v, list) and len(v) >= 1:
                consumers.setdefault(str(v[0]), []).append(str(nid))

    reg = comfy_graph.get_registry()

    def _is_switch(nd: dict) -> bool:
        ct = str(nd.get("class_type", ""))
        try:
            if comfy_graph.classify(ct, reg.sig(ct)) == "switch":
                return True
        except Exception:
            pass
        return "switch" in ct.lower()

    def _reaches_output(start: str, respect_switches: bool) -> bool:
        seen: set[str] = set()
        stack = [start]
        while stack:
            cur = stack.pop()
            if cur in seen:
                continue
            seen.add(cur)
            cnode = prompt.get(cur)
            if isinstance(cnode, dict) and cur != start:
                cct = str(cnode.get("class_type", ""))
                if comfy_graph._is_output_like(cct, reg.sig(cct)):
                    return True
            for cnid in consumers.get(cur, ()):
                cnd = prompt.get(cnid)
                if not isinstance(cnd, dict):
                    continue
                if respect_switches and _is_switch(cnd):
                    active = _switch_active_ref(prompt, cnd)
                    if isinstance(active, list) and str(active[0]) != cur:
                        continue
                stack.append(cnid)
        return False

    off: set[str] = set()
    for nid in nids:
        nid = str(nid)
        if not _reaches_output(nid, respect_switches=True) and \
                _reaches_output(nid, respect_switches=False):
            off.add(nid)
    return off

# A model that rewrites the prompt before it is encoded. What the user typed
# survives upstream of it and is kept as the initial prompt.
_VLM_ENHANCER_PATTERNS = ("llava", "vlm", "prompt_enhancer", "promptenhancer",
                          "llamasampler", "llm", "florence", "joycaption",
                          "cogvlm", "minicpm", "internvl", "qwenvl",
                          "textgenerate", "ollamagenerate",
                          "promptexpand", "promptrefine",
                          "gemini", "chatgpt", "claude", "openai",
                          "llmsampler", "enhanceprompt", "improve_prompt",
                          "stylize_prompt", "rewrite_prompt")

def _find_enhancer_in_chain(prompt: dict, start_ref: Any, max_depth: int = 6) -> dict | None:
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

        if any(p in ct_lower for p in _VLM_ENHANCER_PATTERNS):
            return node

        inputs = node.get("inputs", {})
        if isinstance(inputs, dict):
            for key, val in inputs.items():
                if isinstance(val, list) and len(val) >= 2:
                    queue.append((val, depth + 1))

    return None

def _find_enhancer_initial_prompt(prompt: dict, text_ref: Any) -> str | None:
    """The enhancer's own instruction widgets come first. Failing those, a switch
    on the way in is asked for a branch that reaches no enhancer.
    """
    enhancer_node = _find_enhancer_in_chain(prompt, text_ref)
    if enhancer_node is None:
        return None

    ref_inputs = enhancer_node.get("inputs", {})
    _PROMPT_KEYS = ("user_prompt", "prompt_text", "prompt", "text", "question",
                    "instruction", "system_message", "input_text", "content")
    for pk in _PROMPT_KEYS:
        pv = ref_inputs.get(pk)
        if isinstance(pv, str) and pv.strip() and len(pv.strip()) > 5:
            return pv.strip()
        elif isinstance(pv, list):
            resolved_init = _resolve_text_recursive(prompt, pv)
            if resolved_init and len(resolved_init.strip()) > 5:
                return resolved_init.strip()

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

        is_switch = any(p in ct_lower for p in _SWITCH_PATTERNS)
        if is_switch:
            ref_inputs_list: list[tuple[str, Any]] = []
            for key, val in inputs_dict.items():
                if isinstance(val, list) and len(val) >= 2:
                    ref_inputs_list.append((key, val))

            for key, ref_val in ref_inputs_list:
                enhancer_on_path = _find_enhancer_in_chain(prompt, ref_val, max_depth=4)
                if enhancer_on_path is not None:
                    continue
                resolved = _resolve_text_recursive(prompt, ref_val)
                if resolved and len(resolved.strip()) > 5:
                    return resolved.strip()

        for key, val in inputs_dict.items():
            if isinstance(val, list) and len(val) >= 2:
                queue.append((val, depth + 1))

    return None

def _sampler_runs_no_steps(info: dict[str, Any]) -> bool:
    """Whether a pass begins at or past its own last step, and so did nothing."""
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
    """Read the executed graph into the summary."""
    samplers_found: list[dict] = []
    models_found: list[str] = []
    active_clip_refs: list = []
    main_vae_refs: list = []
    audio_vae_refs: list = []
    vae_loader_names: list[str] = []
    loras_found: list[dict] = []
    initial_images_found: list[str] = []
    initial_audios_found: list[str] = []
    controlnets_found: list[dict] = []
    adetailers_found: list[dict] = []
    positive_texts: list[tuple[str, str]] = []
    negative_texts: list[tuple[str, str]] = []
    initial_prompts: list[tuple[str, str]] = []
    tags_texts: list[tuple[str, str]] = []
    lyrics_texts: list[tuple[str, str]] = []
    enhancer_encoder_nids: list[str] = []
    upscaling_found: list[dict] = []
    interpolation_found: list[dict] = []
    mmaudio_info: dict | None = None
    model_loader_ids: dict[str, str] = {}
    sampler_passes: list[dict] = []
    diffusion_model_candidates: list = []

    negative_node_ids: set[str] = set()
    positive_node_ids: set[str] = set()
    _NEG_INPUT_NAMES = {"negative", "cond_negative", "negative_conditioning", "neg_conditioning"}

    _TEXT_PRODUCER_TYPES = {"cliptextencode", "textencode", "cliptextencodeflux",
                           "cliptextencodesd3", "cliptextencodehunyuan",
                           "bnk_cliptextencodeadvanced", "cliptextencodeflux"}

    _POSITIVE_INPUT_NAMES = {"positive", "cond_positive", "positive_conditioning",
                             "pos_conditioning", "cond"}

    # Which encoders are positive and which are negative is only knowable from
    # the socket their conditioning finally arrives at. `skip_names` keeps a
    # walk from crossing into the opposite polarity where a node takes both.
    def _trace_cond_chain(nid_str: str, mark: set[str], skip_names: set[str],
                          visited: set[str] | None = None) -> None:
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
        # Zeroed conditioning carries none of the text it was made from.
        if _role == "zero_conditioning" or "zeroout" in ct:
            return
        # A pipe bundles both polarities into one value, so which one came out
        # of it cannot be told from here.
        ct_spaced = ct_raw.lower()
        if _PIPE_FROM_PATTERN in ct_spaced or _PIPE_TO_PATTERN in ct_spaced:
            return
        if _role == "text_encode" or (_role is None and any(tp in ct for tp in _TEXT_PRODUCER_TYPES)):
            mark.add(nid_str)
            return
        inp = ndata.get("inputs", {})
        if not isinstance(inp, dict):
            return
        for key, val in inp.items():
            if key.lower() in skip_names:
                continue
            if isinstance(val, list) and len(val) >= 1:
                val = _demux_pipe_ref(prompt, val)
                if isinstance(val, list) and len(val) >= 1:
                    _trace_cond_chain(str(val[0]), mark, skip_names, visited)

    for nid, ndata in prompt.items():
        if isinstance(ndata, dict) and "inputs" in ndata and isinstance(ndata["inputs"], dict):
            for neg_name in _NEG_INPUT_NAMES:
                neg_ref = ndata["inputs"].get(neg_name)
                if isinstance(neg_ref, list) and len(neg_ref) >= 1:
                    neg_ref = _demux_pipe_ref(prompt, neg_ref)
                    if isinstance(neg_ref, list) and len(neg_ref) >= 1:
                        _trace_cond_chain(str(neg_ref[0]), negative_node_ids, _POSITIVE_INPUT_NAMES)
            for pos_name in _POSITIVE_INPUT_NAMES:
                pos_ref = ndata["inputs"].get(pos_name)
                if isinstance(pos_ref, list) and len(pos_ref) >= 1:
                    pos_ref = _demux_pipe_ref(prompt, pos_ref)
                    if isinstance(pos_ref, list) and len(pos_ref) >= 1:
                        _trace_cond_chain(str(pos_ref[0]), positive_node_ids, _NEG_INPUT_NAMES)

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

    # A display node, or one with no settings of its own, carries the name of
    # the node feeding it, and several nodes of one type each record what they
    # feed, so both ends of every link are remembered.
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

    generic_nodes: list[dict[str, Any]] = []

    _DISPLAY_NODE_PATTERNS = ("showtext", "showany", "showanything", "displayany",
                              "showstring", "displaytext", "previewany")

    # Left out of the node list: the ones read into a field of their own, and
    # the plumbing whose settings say nothing about the picture.
    _SKIP_GENERIC_TYPES = {
        "vaedecode", "vaeencode", "previewimage", "saveimage", "loadimage",
        "emptylatentimage", "emptysd3latentimage",
        "reroute", "unloadmodel", "ramcleanup",
        "easycleangpuused", "easyclearcacheall", "easyconvertanything",
        "imagefrombatch", "localmediamanagernode",
        "anyswitchrgthree", "anythingeverywhere", "anythingswitchrgthree",
        "note",
        "primitivestringmultiline", "primitivestringsimple", "primitiveboolean",
        "primitiveinteger", "primitivefloat",
        "df_text", "df_integer", "df_float",
        "textversionspro", "textversions", "stringliteral", "simpletext",
        "easyifelsestring", "easyifelse",
        "ksamplerselect", "basicscheduler", "randomnoise", "disablenoise",
        "basicguider", "cfgguider", "dualcfgguider", "splitsigmas",
        "cliptextencode", "cliptextencodesdxl", "cliptextencodesdxlrefiner",
        "controlnetloader", "diffcontrolnetloader", "setunioncontrolnettype",
        "modelpatchloader",
        "upscalemodelloader",
        "modelsamplingflux", "modelsamplingsd3", "modelsamplingdiscrete",
        "modelsamplingauraflow", "modelsampling",
        "clipsetlastlayer",
        "sdxlresolutionsjps", "getresolutioncrystools", "getimagesize",
        "jwimageresizelongerside", "jwimageresizebylongerside",
        "imagescaleby", "imagescale", "batchresizewithlanczos",
        "latentupscale", "latentupscaleby",
        "seedgeneratorimagesaver", "samplerselectorimagesaver",
        "schedulerselectorimagesaver",
        "selectoriginalimagenode", "seedvarianceenhancer",
        "textfindandreplace", "removeduplicatetagslp",
        "tagremover", "textconcatenate",
    }

    _dead_ids = comfy_graph.dead_node_ids(prompt, comfy_graph.get_registry())
    _consumers_map = comfy_graph._build_consumers(prompt)

    for node_id, node_data in prompt.items():
        if not isinstance(node_data, dict):
            continue
        # Nothing that was saved or shown was built from this node.
        if str(node_id) in _dead_ids:
            continue
        class_type = node_data.get("class_type", "")
        inputs = node_data.get("inputs", {})
        if not isinstance(inputs, dict):
            continue

        ct_lower = class_type.lower()
        node_title = str(node_data.get("_meta", {}).get("title", "")).strip()

        _is_handled = False
        _full_handled_params = False

        _LOAD_IMAGE_TYPES = ("loadimage", "loadimagemask", "loadimagefromurl",
                             "loadimagebatch", "loadimagelistfrombatch",
                             "loadimagewithmetadatacrystools",
                             "load image with metadata [crystools]",
                             "loadimageoutput", "etn_loadimagebase64",
                             "betterimageloader")
        if ct_lower.replace(" ", "").replace("_", "") in {
            t.replace(" ", "").replace("_", "") for t in _LOAD_IMAGE_TYPES
        } or ct_lower in ("loadimage", "loadimagemask"):
            img_val = inputs.get("image", "")
            # A loader nothing reads from was left in the graph and gave the
            # run no starting image.
            if (isinstance(img_val, str) and img_val.strip()
                    and len(img_val) <= 500
                    and _consumers_map.get(str(node_id))):
                _img = img_val.strip()
                if _img not in initial_images_found:
                    initial_images_found.append(_img)
            _is_handled = True

        if "loadaudio" in ct_lower.replace(" ", "").replace("_", ""):
            _aud_val = inputs.get("audio", "")
            if (isinstance(_aud_val, str) and _aud_val.strip()
                    and len(_aud_val) <= 500
                    and _consumers_map.get(str(node_id))):
                _aud = _aud_val.strip()
                if _aud not in initial_audios_found:
                    initial_audios_found.append(_aud)
            _is_handled = True
            # Its settings stay in the node list, since a layout can bind to
            # this node's own fields.
            _full_handled_params = True

        for _si_key in ("start_image", "init_image", "pixels"):
            _si_val = inputs.get(_si_key)
            if isinstance(_si_val, list) and len(_si_val) >= 2:
                _si_ref_id = str(_si_val[0])
                _si_ref_node = prompt.get(_si_ref_id)
                if isinstance(_si_ref_node, dict):
                    _si_ref_ct = (_si_ref_node.get("class_type") or "").lower()
                    _si_ref_inputs = _si_ref_node.get("inputs", {})
                    if isinstance(_si_ref_inputs, dict):
                        _si_img = _si_ref_inputs.get("image", "")
                        if isinstance(_si_img, str) and _si_img.strip() and len(_si_img) <= 500:
                            _si_ref_ct_clean = _si_ref_ct.replace(" ", "").replace("_", "")
                            if any(x in _si_ref_ct_clean for x in ("loadimage", "crystools", "imageloader")):
                                _si_clean = _si_img.strip()
                                if _si_clean not in initial_images_found:
                                    initial_images_found.append(_si_clean)

        # One the registry calls something else still counts if its name says
        # sampler and it puts out a latent, which a video pack spells its own
        # way.
        _node_role = comfy_graph.classify(class_type, comfy_graph.get_registry().sig(class_type))
        _name_says_sampler = comfy_graph.name_says_sampler(class_type)
        if _node_role == "sampler" or (_node_role is None and _name_says_sampler) or (
                _node_role == "other" and _name_says_sampler and any(
                    "latent" in str(t).lower()
                    for t in (comfy_graph.get_registry().sig(class_type) or {}).get("output_types", []))):
            info: dict[str, Any] = {}
            info["label"] = node_title or class_type
            _SAMPLER_KEYS = ("seed", "noise_seed", "steps", "cfg", "sampler_name",
                             "scheduler", "denoise", "start_at_step", "end_at_step",
                             "add_noise", "return_with_leftover_noise", "eta")
            for key in _SAMPLER_KEYS:
                val = inputs.get(key)
                if val is not None and not isinstance(val, (list, dict)):
                    out_key = "seed" if key == "noise_seed" else key
                    info[out_key] = val

            # A widget turned into a link keeps its last typed value in the
            # workflow, while the run used what the link resolves to.
            for key in _SAMPLER_KEYS:
                val = inputs.get(key)
                if not isinstance(val, list):
                    continue
                out_key = "seed" if key == "noise_seed" else key
                rv = _resolve_scalar_smart(prompt, val)
                if rv is not None and not isinstance(rv, (list, dict)):
                    info[out_key] = rv

            # A sampler setting that came down a link passes through a
            # primitive or a converter whose own widget is named something else.
            _SAMPLER_ALT_KEYS = {
                "sampler_name": ["sampler_name", "sampler"],
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
                    continue
                val = inputs.get(key)
                if not isinstance(val, list):
                    continue

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
                    # A math node's computed output is the value, so the walk
                    # stops there.
                    if _is_math_node(ref_node.get("class_type", "")):
                        mres = _eval_math_node(prompt, ref_node)
                        if mres is not None:
                            resolved = mres
                            break
                    for ak in alt_keys:
                        rv = ref_inputs.get(ak)
                        if rv is not None and not isinstance(rv, (list, dict)):
                            resolved = rv
                            break
                    if resolved is not None:
                        break
                    next_ref = None
                    for ak in alt_keys:
                        rv = ref_inputs.get(ak)
                        if isinstance(rv, list):
                            next_ref = rv
                            break
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

            # A custom sampler takes its sampler and sigmas from linked nodes,
            # and the advanced one its noise and guider as well.
            if "samplercustom" in ct_lower:
                def _scalar(val):
                    if isinstance(val, list):
                        return _resolve_scalar_smart(prompt, val)
                    if isinstance(val, dict):
                        return None
                    return val

                noise_ref = _demux_pipe_ref(prompt, inputs.get("noise"))
                if isinstance(noise_ref, list):
                    noise_node = _resolve_ref(prompt, noise_ref)
                    if noise_node and isinstance(noise_node, dict):
                        n_inputs = noise_node.get("inputs", {})
                        for sk in ("noise_seed", "seed"):
                            sv = _scalar(n_inputs.get(sk))
                            if sv is not None:
                                info.setdefault("seed", sv)
                                break

                guider_ref = _demux_pipe_ref(prompt, inputs.get("guider"))
                if isinstance(guider_ref, list):
                    guider_node = _resolve_ref(prompt, guider_ref)
                    if guider_node and isinstance(guider_node, dict):
                        g_inputs = guider_node.get("inputs", {})
                        cfg_val = _scalar(g_inputs.get("cfg"))
                        if cfg_val is not None:
                            info.setdefault("cfg", cfg_val)

                sampler_ref = _demux_pipe_ref(prompt, inputs.get("sampler"))
                if isinstance(sampler_ref, list):
                    sampler_node = _resolve_ref(prompt, sampler_ref)
                    if sampler_node and isinstance(sampler_node, dict):
                        s_inputs = sampler_node.get("inputs", {})
                        sname = s_inputs.get("sampler_name")
                        if isinstance(sname, str):
                            info.setdefault("sampler_name", sname)

                sigmas_ref = inputs.get("sigmas")
                _sig_seen: set[str] = set()
                for _ in range(8):
                    sigmas_ref = _demux_pipe_ref(prompt, sigmas_ref)
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
                    # The scheduler is always a chosen string, while the steps
                    # and the denoise can each arrive down a link.
                    for sk in ("steps", "scheduler", "denoise"):
                        raw = sig_inputs.get(sk)
                        sv = (raw if isinstance(raw, str) else None) if sk == "scheduler" else _scalar(raw)
                        if sv is not None:
                            info.setdefault(sk, sv)
                            if sk == "steps":
                                _got_steps = True
                    _msv = _scalar(sig_inputs.get("max_shift"))
                    if _msv is not None:
                        info.setdefault("shift", _msv)
                        _bsv = _scalar(sig_inputs.get("base_shift"))
                        if _bsv is not None:
                            info.setdefault("base_shift", _bsv)
                    if not _got_steps:
                        # A schedule written out by hand has one more sigma than
                        # it has steps.
                        _sraw = sig_inputs.get("sigmas")
                        if isinstance(_sraw, str) and _sraw.strip():
                            _toks = [t for t in re.split(r"[\s,]+", _sraw.strip()) if t]
                            try:
                                _nvals = len([float(t) for t in _toks])
                            except ValueError:
                                _nvals = 0
                            if _nvals >= 2:
                                info.setdefault("steps", _nvals - 1)
                                _got_steps = True
                    if _got_steps:
                        break
                    sigmas_ref = sig_inputs.get("sigmas")

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

            if any(k in info for k in ("seed", "steps", "cfg", "denoise", "sampler_name")):
                samplers_found.append(info)
                _is_handled = True
                _full_handled_params = True
                sampler_passes.append({
                    "nid": str(node_id),
                    "start": info.get("start_at_step"),
                    "add_noise": info.get("add_noise"),
                    "model_ref": inputs.get("model"),
                    "latent_ref": inputs.get("latent_image"),
                    "guider_ref": inputs.get("guider"),
                    "info": info,
                })

        if "checkpointloader" in ct_lower:
            name = inputs.get("ckpt_name")
            if name and isinstance(name, str):
                models_found.append(name)
                model_loader_ids[str(node_id)] = name
                _is_handled = True

        if "unetloader" in ct_lower:
            name = inputs.get("unet_name")
            if name and isinstance(name, str):
                models_found.append(name)
                model_loader_ids[str(node_id)] = name
                _is_handled = True

        # A loader from a node pack can be named for any kind of model, so one
        # of these only counts once a sampler is found to have used it.
        if "diffusionmodelloader" in ct_lower or (
                "modelloader" in ct_lower and not any(
                    x in ct_lower for x in ("clip", "vae", "lora", "controlnet",
                                            "control_net", "upscale", "style",
                                            "ipadapter", "instantid", "checkpoint",
                                            "unet"))):
            name = inputs.get("model_name") or inputs.get("unet_name") or inputs.get("model")
            if name and isinstance(name, str):
                diffusion_model_candidates.append((str(node_id), name))

        if "cliploader" in ct_lower or "dualcliploader" in ct_lower:
            _is_handled = True

        if _node_role == "lora" or ("lora" in ct_lower and "loader" in ct_lower):
            _loras_before = len(loras_found)
            name = inputs.get("lora_name")
            strength_m = inputs.get("strength_model")
            strength_c = inputs.get("strength_clip")
            if name and isinstance(name, str):
                entry: dict[str, Any] = {"name": name}
                if strength_m is not None and not isinstance(strength_m, (list, dict)):
                    entry["strength_model"] = strength_m
                if strength_c is not None and not isinstance(strength_c, (list, dict)):
                    entry["strength_clip"] = strength_c
                # The loader's id rides along so the high and low noise roles
                # can be hung on each LoRA once the passes are worked out.
                entry["loader"] = str(node_id)
                loras_found.append(entry)

            # A stacked loader keeps a numbered slot per LoRA, either as an
            # object with its own on switch and strength, or as a name in
            # `lora_N` with the strength in `strength_N`.
            _has_lora_slots = False
            for inp_key, inp_val in inputs.items():
                # The header widget marks the node as a stacked loader even
                # while every slot is empty.
                if inp_key == "PowerLoraLoaderHeaderWidget":
                    _has_lora_slots = True
                    continue
                if not inp_key.startswith("lora_"):
                    continue
                if isinstance(inp_val, dict):
                    _has_lora_slots = True
                    if inp_val.get("on") and inp_val.get("lora"):
                        lora_name = inp_val["lora"]
                        lora_strength = inp_val.get("strength", 1.0)
                        loras_found.append({
                            "name": lora_name,
                            "strength_model": lora_strength,
                            "loader": str(node_id),
                        })
                elif inp_key[5:].isdigit() and isinstance(inp_val, str):
                    _has_lora_slots = True
                    _slot_name = inp_val.strip()
                    if _slot_name and _slot_name.lower() != "none":
                        entry = {"name": _slot_name, "loader": str(node_id)}
                        _strength = inputs.get(f"strength_{inp_key[5:]}")
                        if _strength is not None and not isinstance(_strength, (list, dict)):
                            entry["strength_model"] = _strength
                        loras_found.append(entry)
            # A loader with every slot switched off counts as handled too,
            # since the generic capture would otherwise put the names of LoRAs
            # that never loaded into the node list.
            if len(loras_found) > _loras_before or _has_lora_slots:
                _is_handled = True

        _CN_APPLY_CLASSES = ("controlnetapply", "controlnetapplyadvanced",
                              "controlnetapplysd3", "acn_advancedcontrolnetapply",
                              "setunioncontrolnettype", "qwenimagediffsynthcontrolnet")
        if any(ac in ct_lower for ac in _CN_APPLY_CLASSES):
            cn_params: dict[str, Any] = {}
            for pk in ("strength", "start_percent", "end_percent"):
                pv = inputs.get(pk)
                if pv is not None and not isinstance(pv, (list, dict)):
                    cn_params[pk] = pv

            cn_name = None
            for key in ("control_net", "controlnet", "model_patch"):
                ref = inputs.get(key)
                if isinstance(ref, list) and len(ref) >= 1:
                    loader_id = str(ref[0])
                    if loader_id in cn_loader_map:
                        cn_name = cn_loader_map[loader_id]
                    else:
                        cn_name = _find_input_name_in_chain(prompt, ref, "control_net_name")
                    if cn_name:
                        break

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

        # The words ruled out here appear in the helper nodes that configure a
        # detailer, and only the node that runs one holds the detector.
        if ("facedetailer" in ct_lower or
            ("detailer" in ct_lower and "hook" not in ct_lower
             and "pipe" not in ct_lower and "schedule" not in ct_lower
             and "noise" not in ct_lower and "cfg" not in ct_lower
             and "custom" not in ct_lower and "coreml" not in ct_lower)):
            det_model = None

            for key in ("model_name", "bbox_detector", "detector", "sam_model_name", "segm_detector"):
                val = inputs.get(key)
                if isinstance(val, str) and val.strip():
                    det_model = val
                    break

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
                for pk in ("steps", "cfg", "sampler_name", "scheduler", "denoise",
                           "guide_size", "max_size"):
                    pv = inputs.get(pk)
                    if pv is not None and not isinstance(pv, (list, dict)):
                        det_entry[pk] = pv
                adetailers_found.append(det_entry)
            _is_handled = True

        if "mmaudiosampler" in ct_lower:
            mma: dict[str, Any] = {}
            for key in ("steps", "cfg", "seed", "prompt", "negative_prompt",
                        "duration", "mask_away_clip"):
                val = inputs.get(key)
                if val is not None and not isinstance(val, (list, dict)):
                    mma[key] = val
                elif isinstance(val, list) and key in ("prompt", "negative_prompt"):
                    resolved = _resolve_text_recursive(prompt, val)
                    if resolved and resolved.strip():
                        mma[key] = resolved
            if mma:
                mmaudio_info = mma
            _is_handled = True

        if "upscale" in ct_lower and "model" in ct_lower and "loader" not in ct_lower:
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
                # The id and the image link order the entries later on, and both
                # are popped before the summary is assembled.
                up_entry["_nid"] = str(node_id)
                _uiv = inputs.get("image")
                if isinstance(_uiv, list) and len(_uiv) >= 1:
                    up_entry["_img_ref"] = _uiv
                upscaling_found.append(up_entry)
            _is_handled = True
        elif _node_role == "latent_resize" or (
                ("upscale" in ct_lower or "upsampl" in ct_lower) and "loader" not in ct_lower):
            up_entry = {}
            for pk in ("upscale_method", "width", "height", "scale_by", "scale_factor",
                       "resolution"):
                pv = inputs.get(pk)
                if isinstance(pv, list):
                    rv = _resolve_scalar_smart(prompt, pv)
                    if isinstance(rv, (int, float)) or (pk == "upscale_method" and isinstance(rv, str)):
                        pv = rv
                    else:
                        pv = None
                if pv is not None and not isinstance(pv, (list, dict)):
                    if isinstance(pv, (int, float)) and not isinstance(pv, bool):
                        pv = _normalize_number(pv)
                    # A node that takes the size it is aiming for as
                    # `resolution` is stored under another name, since
                    # `resolution` in the summary is the file's own.
                    if pv is not None:
                        up_entry["target_resolution" if pk == "resolution" else pk] = pv
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
                for _ck, _ekey, _ckeys in (
                        ("vae", "vae", ("vae_name", "model_name", "model")),
                        ("clip", "clip", ("clip_name", "model_name", "model")),
                        ("text_encoder", "clip", ("clip_name", "model_name", "model"))):
                    if _ekey in up_entry:
                        continue
                    _cref = inputs.get(_ck)
                    if not isinstance(_cref, list):
                        continue
                    _cnode = _resolve_ref(prompt, _cref)
                    if isinstance(_cnode, dict) and isinstance(_cnode.get("inputs"), dict):
                        for _cn in _ckeys:
                            _cv = _cnode["inputs"].get(_cn)
                            if isinstance(_cv, str) and _cv.strip():
                                up_entry[_ekey] = _cv.strip()
                                break
                up_entry["type"] = class_type
                if "temporal" in str(up_entry.get("model", "")).lower():
                    interpolation_found.append(
                        {"type": class_type, "model_name": up_entry["model"],
                         "_nid": str(node_id)})
                else:
                    up_entry["_nid"] = str(node_id)
                    for _uk in ("image", "images", "pixels", "samples", "latent_image", "latent"):
                        _uiv = inputs.get(_uk)
                        if isinstance(_uiv, list) and len(_uiv) >= 1:
                            up_entry["_img_ref"] = _uiv
                            break
                    upscaling_found.append(up_entry)
            _is_handled = True
        elif _node_role == "image_resize" or (_node_role in (None, "other") and
              ("resize" in ct_lower or "scale" in ct_lower) and "image" in ct_lower
              and "latent" not in ct_lower):
            _img_ref = None
            for _ik in ("image", "images", "pixels", "input"):
                _iv = inputs.get(_ik)
                if isinstance(_iv, list) and len(_iv) >= 1:
                    _img_ref = _iv
                    break
            # A resize only counts as upscaling once the image it takes has
            # been generated, or where it leads into an upscaler.
            _in_pipeline = _img_ref is not None and _chain_reaches(
                prompt, _img_ref,
                ("vaedecode", "videodecode", "latentdecode",
                 "upscalewithmodel", "imageupscale"),
                accept_decoder=True)
            if not _in_pipeline and _img_ref is not None:
                _in_pipeline = _feeds_upscaler_first(prompt, str(node_id), consumers=_consumers_map)
            if _in_pipeline:
                up_entry = {}
                _RESIZE_KEY_MAP = (
                    (("upscale_method", "scale_method", "method", "interpolation", "resize_method"), "upscale_method"),
                    (("scale_by", "scale", "scale_factor", "factor", "upscale_factor", "multiplier"), "scale_by"),
                    (("width", "generation_width", "target_width"), "width"),
                    (("height", "generation_height", "target_height"), "height"),
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
                            pv = _normalize_number(pv)
                            if pv is not None:
                                up_entry[out_key] = pv
                                break
                if up_entry:
                    up_entry["type"] = class_type
                    up_entry["_nid"] = str(node_id)
                    up_entry["_img_ref"] = _img_ref
                    upscaling_found.append(up_entry)

        if _node_role == "interpolation" or (_node_role != "image_resize" and (
                "interpolation" in ct_lower or "vfi" in ct_lower or "rife" in ct_lower)):
            interp: dict[str, Any] = {}
            for key in ("source_fps", "target_fps", "scale", "model_name",
                        "multiplier", "ckpt_name"):
                val = inputs.get(key)
                if isinstance(val, list):
                    val = _demux_pipe_ref(prompt, val)
                    # The pipe carries nothing in that slot, and the sentinel
                    # saying so must not be stored as a value.
                    if val is comfy_graph.NO_VALUE:
                        continue
                if val is not None and not isinstance(val, (list, dict)):
                    interp[key] = val
                elif isinstance(val, list):
                    rv = _resolve_scalar_smart(prompt, val)
                    if isinstance(rv, (int, float)) or (key in ("model_name", "ckpt_name") and isinstance(rv, str)):
                        interp[key] = rv
            if interp:
                interp["type"] = class_type
                interp["_nid"] = str(node_id)
                for _fk in ("images", "frames", "image"):
                    _fv = inputs.get(_fk)
                    if isinstance(_fv, list) and len(_fv) >= 1:
                        interp["_img_ref"] = _fv
                        break
                interpolation_found.append(interp)
            _is_handled = True

        if _node_role == "text_encode" or (_node_role is None and (
                "cliptextencode" in ct_lower or "textencode" in ct_lower)):
            _clip_ref = inputs.get("clip")
            if isinstance(_clip_ref, list) and _clip_ref:
                active_clip_refs.append((str(node_id), _clip_ref))
            text = inputs.get("text")
            if text is None:
                text = inputs.get("prompt")
            # An audio encoder puts the style words in `tags` and the words
            # to be sung in `lyrics`.
            for _sk, _bucket in (("tags", tags_texts), ("lyrics", lyrics_texts)):
                _sv = inputs.get(_sk)
                if isinstance(_sv, list) and len(_sv) >= 1:
                    _sv = _resolve_text_recursive(prompt, _sv)
                if isinstance(_sv, str) and _sv.strip():
                    _bucket.append((str(node_id), _sv.strip()))
                    _full_handled_params = True
            # An encoder node for a two encoder model takes one box per
            # encoder, written as `text_g` with `text_l`, or as `clip_l` with
            # one of the T5 boxes.
            if text is None:
                _pair = None
                if inputs.get("text_g") is not None or inputs.get("text_l") is not None:
                    _pair = (inputs.get("text_g"), inputs.get("text_l"))
                elif any(inputs.get(_k) is not None for _k in ("clip_l", "t5xxl", "mt5xl")):
                    _pair = (inputs.get("clip_l"),
                             inputs.get("t5xxl") if inputs.get("t5xxl") is not None else inputs.get("mt5xl"))
                if _pair is not None:
                    _has_str = any(isinstance(p, str) and p.strip() for p in _pair)
                    _has_link = any(isinstance(p, list) and len(p) >= 1 for p in _pair)
                    if _has_str and _has_link:
                        _parts = []
                        for p in _pair:
                            if isinstance(p, str) and p.strip():
                                _parts.append(p.strip())
                            elif isinstance(p, list) and len(p) >= 1:
                                _resolved = _resolve_text_recursive(prompt, p)
                                if isinstance(_resolved, str) and _resolved.strip():
                                    _parts.append(_resolved.strip())
                    else:
                        _parts = [p.strip() for p in _pair if isinstance(p, str) and p.strip()]
                    if text is None and _parts:
                        if len(_parts) == 2 and _parts[0] == _parts[1]:
                            _parts = _parts[:1]
                        text = ", ".join(_parts)
                if text is None:
                    for _vk in ("text_g", "text_l", "t5xxl", "mt5xl", "clip_l"):
                        _vv = inputs.get(_vk)
                        if isinstance(_vv, list) and len(_vv) >= 1:
                            text = _vv
                            break
            initial_text = None
            enhanced_text = None
            enhancer_node = None

            if isinstance(text, list) and len(text) >= 1:
                enhancer_node = _find_enhancer_in_chain(prompt, text)

                if enhancer_node is not None:
                    initial_text = _find_enhancer_initial_prompt(prompt, text)

                    _CAPTURED_TEXT_KEYS = ("text_0", "text_1", "text_output", "text_out",
                                          "generated_text", "value", "string", "STRING",
                                          "result", "output_text")
                    _SHOW_TEXT_PATTERNS = _SHOW_TEXT_NODE_PATTERNS

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
                            for _ik, _iv in _inputs.items():
                                if isinstance(_iv, list) and len(_iv) >= 2 and str(_iv[0]) == enhancer_id:
                                    for _tk in ("text",) + _CAPTURED_TEXT_KEYS:
                                        _tv = _inputs.get(_tk)
                                        if isinstance(_tv, str) and _tv.strip() and len(_tv.strip()) > 10:
                                            enhanced_text = _tv.strip()
                                            break
                                if enhanced_text:
                                    break
                            if enhanced_text:
                                break

                    if not enhanced_text:
                        for _tk in _CAPTURED_TEXT_KEYS:
                            _tv = (enhancer_node.get("inputs") or {}).get(_tk)
                            if isinstance(_tv, str) and _tv.strip() and len(_tv.strip()) > 10:
                                enhanced_text = _tv.strip()
                                break

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

                resolved = _resolve_text_recursive(prompt, text)
                if resolved:
                    text = resolved
                elif initial_text:
                    text = initial_text

            if enhanced_text:
                text = enhanced_text

            if isinstance(text, str) and text.strip():
                title_lower = (node_title or "").lower()
                # A title that names the node negative counts on its own, even
                # where the conditioning walk found it on a positive path.
                _is_neg_by_title = bool(re.search(r'\bneg(?:ative)?\b', title_lower))
                _in_neg_chain = (str(node_id) in negative_node_ids
                                 and str(node_id) not in positive_node_ids)
                is_negative = _in_neg_chain or _is_neg_by_title
                if is_negative:
                    negative_texts.append((str(node_id), text.strip()))
                else:
                    positive_texts.append((str(node_id), text.strip()))
                    if initial_text:
                        initial_prompts.append((str(node_id), initial_text))
                    if enhancer_node is not None:
                        enhancer_encoder_nids.append(str(node_id))
                        summary["prompt_enhanced"] = True
            _is_handled = True

        if "vaeloader" in ct_lower:
            vae = inputs.get("vae_name")
            if vae and isinstance(vae, str):
                vae_loader_names.append(vae)
            _is_handled = True

        if "vaedecode" in ct_lower or "vaeencode" in ct_lower:
            _vref = inputs.get("vae")
            if isinstance(_vref, list) and _vref:
                if "audio" in ct_lower:
                    audio_vae_refs.append(_vref)
                else:
                    # Kept per consumer, so a VAE that only a later pass decodes
                    # with can be told from the one the generation used.
                    main_vae_refs.append((str(node_id), _vref))
        _avref = inputs.get("audio_vae")
        if isinstance(_avref, list) and _avref:
            audio_vae_refs.append(_avref)

        if "clipsetlastlayer" in ct_lower:
            # The layer is written as a negative index counting back from the
            # last, and clip skip is that same number without its sign.
            skip = inputs.get("stop_at_clip_layer")
            if skip is not None:
                summary.setdefault("clip_skip", abs(int(skip)) if isinstance(skip, (int, float)) else skip)
            _is_handled = True

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

        ct_clean = ct_lower.replace(" ", "").replace("_", "").replace("(", "").replace(")", "").replace("|", "")
        if ct_clean not in _SKIP_GENERIC_TYPES:
            from_label = None
            src_id = upstream_src.get(str(node_id))
            if src_id:
                src_node = prompt.get(src_id)
                if isinstance(src_node, dict):
                    from_label = (str(src_node.get("_meta", {}).get("title", "")).strip()
                                  or str(src_node.get("class_type", "")).strip() or None)
            is_display_node = any(p in ct_clean for p in _DISPLAY_NODE_PATTERNS)

            if _is_handled:
                _hp: dict[str, Any] = {}
                if _full_handled_params:
                    for _pk, _pv in inputs.items():
                        if isinstance(_pv, (str, int, float, bool)):
                            if isinstance(_pv, str) and (not _pv.strip() or len(_pv) > 500):
                                continue
                            _hp[_pk] = _pv
                generic_entry: dict[str, Any] = {
                    "class_type": class_type,
                    "params": _hp,
                    "_handled": True,
                }
                if node_title and node_title != class_type:
                    generic_entry["title"] = node_title
                if from_label and is_display_node:
                    generic_entry["_from"] = from_label
                generic_entry["_node_id"] = str(node_id)
                generic_nodes.append(generic_entry)
            else:
                _VLM_PATTERNS = ("llava", "vlm", "prompt_enhancer", "promptenhancer",
                                 "llamasampler", "llm", "florence", "joycaption",
                                 "cogvlm", "minicpm", "internvl", "qwenvl",
                                 "textgenerator", "ollamagenerate",
                                 "enhanceprompt", "improve_prompt")
                is_vlm = any(p in ct_lower for p in _VLM_PATTERNS)
                _PROMPT_KEYS = ("user_prompt", "system_prompt", "prompt", "text",
                                "question", "instruction", "system_message")

                _PROMPT_REF_HINTS = ("prompt", "msg", "message", "text", "caption",
                                     "system", "instruction", "question")

                node_params: dict[str, Any] = {}
                for k, v in inputs.items():
                    if isinstance(v, (str, int, float, bool)):
                        if isinstance(v, str):
                            if not v.strip():
                                continue
                            # A long value is a node's payload and no longer a
                            # setting, unless it is the instruction given to a
                            # language model.
                            if len(v) > 500 and not (is_vlm and k in _PROMPT_KEYS):
                                continue
                            if len(v) > _NODE_TEXT_MAX:
                                v = v[:_NODE_TEXT_MAX] + "…"
                        node_params[k] = v
                    elif isinstance(v, dict):
                        # A widget whose object holds a view link is a preview
                        # of a file the run left behind.
                        if "view?filename=" not in json.dumps(v, default=str):
                            node_params[k] = v
                    elif isinstance(v, list) and len(v) >= 1:
                        kl = k.lower()
                        if k in _PROMPT_KEYS or any(t in kl for t in _PROMPT_REF_HINTS):
                            resolved = _resolve_text_recursive(prompt, v)
                            if resolved and resolved.strip():
                                node_params[k] = resolved if len(resolved) <= 4000 else (resolved[:4000] + "…")
                        elif kl in _CLIP_INPUT_KEYS:
                            _cn, _baked, _cprojs = _resolve_clip_source(prompt, v)
                            if _cn:
                                node_params[k] = _cn[0]
                        elif kl not in _NON_SCALAR_INPUT_KEYS:
                            rv = _resolve_scalar_smart(prompt, v)
                            # A key naming something wants a string, and the
                            # nearest literal fallback can land on a number.
                            if kl.endswith("_name") or kl.endswith("name"):
                                if isinstance(rv, str) and rv.strip() and len(rv) <= 500:
                                    node_params[k] = rv
                            elif isinstance(rv, (bool, int, float)):
                                node_params[k] = rv
                            elif isinstance(rv, str) and rv.strip() and len(rv) <= 500:
                                node_params[k] = rv
                if _is_math_node(class_type):
                    mres = _eval_math_node(prompt, node_data)
                    if mres is not None:
                        node_params["result"] = mres
                generic_entry = {
                    "class_type": class_type,
                    "params": node_params,
                }
                if node_title and node_title != class_type:
                    generic_entry["title"] = node_title
                if is_vlm:
                    generic_entry["is_vlm"] = True
                if from_label and (is_display_node or not node_params):
                    generic_entry["_from"] = from_label
                generic_entry["_node_id"] = str(node_id)
                generic_nodes.append(generic_entry)

    if samplers_found:
        # A graph whose passes all look inactive keeps them, since showing none
        # of them would say less than showing all.
        active = [s for s in samplers_found if not _sampler_runs_no_steps(s)]
        summary.setdefault("samplers", active or samplers_found)

    if diffusion_model_candidates:
        _chain_nids: set = set()
        for _p in sampler_passes:
            _chain_nids.update(_collect_model_chain_nids(prompt, _p.get("model_ref")))
        for _nid, _nm in diffusion_model_candidates:
            if _nid in _chain_nids and _nm not in models_found:
                models_found.append(_nm)
                model_loader_ids[_nid] = _nm

    role_map = _compute_high_low_roles(prompt, sampler_passes, model_loader_ids)

    # Each pass holds its card by reference, so writing here writes the card.
    for _p in sampler_passes:
        _r = _p.get("role")
        if _r and isinstance(_p.get("info"), dict):
            _p["info"]["role"] = _r

    # One pass can be described by more than one node, so a card whose every
    # field matches another's is folded into it. A card carrying a high or low
    # noise role stands for a pass of its own and is left alone.
    _smp = summary.get("samplers")
    if isinstance(_smp, list) and len(_smp) > 1:
        _kept: list = []
        for _e in _smp:
            _host = None
            if isinstance(_e, dict) and "role" not in _e:
                for _m in _kept:
                    if not (isinstance(_m, dict) and "role" not in _m):
                        continue
                    if all(_m.get(_k) == _v for _k, _v in _e.items()):
                        _host = _m
                        break
                    if all(_e.get(_k) == _v for _k, _v in _m.items()):
                        _m.update(_e)
                        _host = _m
                        break
            if _host is None:
                _kept.append(_e)
        if len(_kept) < len(_smp):
            summary["samplers"] = _kept

    _pass_nids = {p["nid"] for p in sampler_passes}
    _pass_lineage = {p["nid"]: _trace_pass_lineage(prompt, p["nid"], _pass_nids)
                     for p in sampler_passes}

    def _predecessor_passes(nid: str) -> set[str]:
        return _pass_lineage.get(nid, set()) & (_pass_nids - {nid})

    def _pass_loaders(p: dict) -> set[str]:
        return {n for n in _collect_model_chain_nids(prompt, p.get("model_ref"))
                if n in model_loader_ids}

    # A pass fed by an earlier pass, loading models the first one never used, is
    # a stage of its own instead of a second half of the generation. It moves
    # into upscaling, taking the prompt, VAE and encoder that belong to it.
    if len(sampler_passes) > 1:
        _base_loaders: set[str] = set()
        for _p in sampler_passes:
            if not _predecessor_passes(_p["nid"]):
                _base_loaders |= _pass_loaders(_p)
        _post_pass_nids: set[str] = set()
        _upscale_entries: dict[str, dict] = {}
        for _p in sampler_passes:
            if _p.get("role") or not _predecessor_passes(_p["nid"]):
                continue
            _own = _pass_loaders(_p)
            if _own and _base_loaders and not (_own & _base_loaders):
                _entry: dict[str, Any] = {"type": _p["info"].get("label") or "sampler"}
                _names = [model_loader_ids[n] for n in sorted(_own)]
                if _names:
                    _entry["model"] = _names[0] if len(_names) == 1 else _names
                for _fk in ("sampler_name", "steps", "cfg", "denoise", "seed"):
                    if _fk in _p["info"]:
                        _entry[_fk] = _p["info"][_fk]
                _entry["_nid"] = _p["nid"]
                _pnode = prompt.get(_p["nid"]) if isinstance(prompt, dict) else None
                if isinstance(_pnode, dict) and isinstance(_pnode.get("inputs"), dict):
                    for _ik in ("latent_image", "latent", "samples", "image",
                                "images", "pixels"):
                        _iv = _pnode["inputs"].get(_ik)
                        if isinstance(_iv, list) and _iv:
                            _entry["_img_ref"] = _iv
                            break
                upscaling_found.append(_entry)
                _post_pass_nids.add(_p["nid"])
                _upscale_entries[_p["nid"]] = _entry
                # Removed by identity, since the fold above can leave the base
                # card equal to this one and removing by value would take that.
                _cards = summary.get("samplers")
                if isinstance(_cards, list):
                    for _ci, _c in enumerate(_cards):
                        if _c is _p["info"]:
                            del _cards[_ci]
                            break
            else:
                _stage = _stage_from_lineage(prompt, _pass_lineage.get(_p["nid"], set()))
                if _stage:
                    _p["info"]["stage"] = _stage
        if _post_pass_nids:
            _post_vis = set().union(*(_pass_lineage[n] for n in _post_pass_nids))
            _remaining = _pass_nids - _post_pass_nids
            _base_vis = set().union(*(_pass_lineage[n] for n in _remaining)) if _remaining else set()
            for _nid_pp, _uentry in _upscale_entries.items():
                _pv = _pass_lineage.get(_nid_pp, set())
                _eclip: list[str] = []
                for _enc, _ref in active_clip_refs:
                    if _enc in _pv and _enc not in _base_vis:
                        for _n in _resolve_clip_source(prompt, _ref)[0]:
                            if _n not in _eclip:
                                _eclip.append(_n)
                if _eclip:
                    _uentry["clip"] = _eclip[0] if len(_eclip) == 1 else _eclip
            active_clip_refs[:] = [(_enc, _ref) for _enc, _ref in active_clip_refs
                                   if _enc in _base_vis or _enc not in _post_vis]

            # An encoder sits in the pass's own lineage, while the decode that
            # pass feeds sits downstream of it.
            def _feeds_from_pass(_cnid: str, _depth: int = 6) -> str | None:
                queue: list[tuple[str, int]] = [(_cnid, 0)]
                seen: set[str] = set()
                while queue:
                    cur, d = queue.pop(0)
                    if cur in _post_pass_nids and cur != _cnid:
                        return cur
                    if d >= _depth or cur in seen:
                        continue
                    seen.add(cur)
                    nd = prompt.get(cur)
                    if isinstance(nd, dict) and isinstance(nd.get("inputs"), dict):
                        for v in nd["inputs"].values():
                            if isinstance(v, list) and v:
                                queue.append((str(v[0]), d + 1))
                return None

            for _nid_pp, _uentry in _upscale_entries.items():
                _pv = _pass_lineage.get(_nid_pp, set())
                if "prompt" not in _uentry:
                    for _enc, _text in positive_texts:
                        if _enc in _pv and _enc not in _base_vis:
                            _uentry["prompt"] = _text
                            break
            _kept_vrefs: list = []
            for _cnid, _vr in main_vae_refs:
                _pp = None
                if _cnid not in _base_vis:
                    _ccl = str((prompt.get(_cnid) or {}).get("class_type", "")).lower()
                    if "vaeencode" in _ccl:
                        for _nid_pp in _post_pass_nids:
                            if _cnid in _pass_lineage.get(_nid_pp, set()):
                                _pp = _nid_pp
                                break
                    else:
                        _pp = _feeds_from_pass(_cnid)
                if _pp:
                    _uentry = _upscale_entries.get(_pp)
                    if _uentry is not None and "vae" not in _uentry:
                        _v = _resolve_vae_source(prompt, _vr)
                        if _v:
                            _uentry["vae"] = _v
                else:
                    _kept_vrefs.append((_cnid, _vr))
            main_vae_refs[:] = _kept_vrefs
            _post_vaes = {e.get("vae") for e in _upscale_entries.values()
                          if e.get("vae")}
            if _post_vaes:
                vae_loader_names[:] = [n for n in vae_loader_names
                                       if n not in _post_vaes]
                if summary.get("vae") in _post_vaes:
                    summary.pop("vae", None)
            positive_texts[:] = [(n, t) for n, t in positive_texts
                                 if n in _base_vis or n not in _post_vis]
            negative_texts[:] = [(n, t) for n, t in negative_texts
                                 if n in _base_vis or n not in _post_vis]
            initial_prompts[:] = [(n, t) for n, t in initial_prompts
                                  if n in _base_vis or n not in _post_vis]
            tags_texts[:] = [(n, t) for n, t in tags_texts
                             if n in _base_vis or n not in _post_vis]
            lyrics_texts[:] = [(n, t) for n, t in lyrics_texts
                               if n in _base_vis or n not in _post_vis]
            enhancer_encoder_nids[:] = [n for n in enhancer_encoder_nids
                                        if n in _base_vis or n not in _post_vis]
            if not enhancer_encoder_nids:
                summary.pop("prompt_enhanced", None)
            sampler_passes[:] = [p for p in sampler_passes if p["nid"] not in _post_pass_nids]

        # The cards read in the order the passes ran.
        _cards = summary.get("samplers")
        if isinstance(_cards, list) and len(_cards) > 1:
            _nid_of = {id(p["info"]): p["nid"] for p in sampler_passes}
            _cards.sort(key=lambda e: len(_predecessor_passes(_nid_of.get(id(e), ""))))

    if models_found:
        seen: list[str] = []
        for m in models_found:
            if m not in seen:
                seen.append(m)
        # With both halves of a two model run named, the high noise model is the
        # one listed first.
        if role_map and model_loader_ids and len(seen) > 1:
            name_role: dict[str, str] = {}
            for nid, nm in model_loader_ids.items():
                r = role_map.get(nid)
                if r and nm not in name_role:
                    name_role[nm] = r
            if name_role:
                _ord = {"high": 0, "low": 1}
                seen.sort(key=lambda nm: _ord.get(name_role.get(nm, ""), 2))
        _active_ids, _safe = _resolve_active_model_loaders(prompt, sampler_passes, model_loader_ids)
        if _safe:
            _active_names = {model_loader_ids[a] for a in _active_ids if a in model_loader_ids}
            if _active_names and _active_names < set(seen):
                seen = [m for m in seen if m in _active_names]
        summary.setdefault("model", seen[0] if len(seen) == 1 else seen)

    clip_names: list[str] = []
    projection_names: list[str] = []
    for _enc_nid, _cref in active_clip_refs:
        _names, _baked, _projs = _resolve_clip_source(prompt, _cref)
        for _n in _names:
            if _n not in clip_names:
                clip_names.append(_n)
        for _n in _projs:
            if _n not in projection_names:
                projection_names.append(_n)
    if clip_names:
        summary.setdefault("clip_models", clip_names)
    if projection_names:
        summary.setdefault("text_projection",
                           projection_names[0] if len(projection_names) == 1 else projection_names)

    _main_vae = None
    for _cnid, _vr in main_vae_refs:
        _main_vae = _resolve_vae_source(prompt, _vr)
        if _main_vae:
            break
    # A loader's name stands in only where no decode link led to a VAE of its
    # own.
    if _main_vae is None and vae_loader_names:
        _main_vae = vae_loader_names[0]
    if _main_vae:
        summary.setdefault("vae", _main_vae)
        # Kept for the cleanup pass, which has to tell a VAE the graph named
        # from one that only a parameters line mentioned.
        summary["_vae_graph"] = _main_vae
    _audio_vae = None
    for _vr in audio_vae_refs:
        _audio_vae = _resolve_vae_source(prompt, _vr)
        if _audio_vae:
            break
    if _audio_vae and _audio_vae != summary.get("vae"):
        summary.setdefault("audio_vae", _audio_vae)

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

    if initial_images_found:
        summary.setdefault("initial_images", initial_images_found[:8])
        summary.setdefault("initial_image", initial_images_found[0])
    if initial_audios_found:
        summary.setdefault("initial_audios", initial_audios_found[:8])

    if controlnets_found:
        merged_cn: dict[str, dict] = {}
        for c in controlnets_found:
            key = c.get("model", "")
            if not key:
                continue
            if key in merged_cn:
                for k, v in c.items():
                    if v is not None and (k not in merged_cn[key] or merged_cn[key][k] is None):
                        merged_cn[key][k] = v
            else:
                merged_cn[key] = dict(c)
        summary.setdefault("controlnet", list(merged_cn.values()))

    if adetailers_found:
        seen_ad: set[str] = set()
        unique_ad: list[dict] = []
        for a in adetailers_found:
            key = a.get("model", "")
            if key not in seen_ad:
                seen_ad.add(key)
                unique_ad.append(a)
        summary.setdefault("adetailer", unique_ad)

    if mmaudio_info:
        summary.setdefault("mmaudio", mmaudio_info)

    if (upscaling_found or interpolation_found) and isinstance(prompt, dict):
        _gate_nids = {e.get("_nid") for e in upscaling_found + interpolation_found
                      if e.get("_nid")}
        _off = _switched_off_nids(prompt, _gate_nids)
        if _off:
            upscaling_found = [e for e in upscaling_found
                               if e.get("_nid") not in _off]
            interpolation_found = [e for e in interpolation_found
                                   if e.get("_nid") not in _off]

    def _upstream_nids(start_ref, max_depth: int = 24) -> set[str]:
        out: set[str] = set()
        queue = [(start_ref, 0)]
        while queue:
            ref, depth = queue.pop(0)
            if depth >= max_depth or not (isinstance(ref, list) and ref):
                continue
            nid = str(ref[0])
            if nid in out:
                continue
            out.add(nid)
            nd = prompt.get(nid) if isinstance(prompt, dict) else None
            if isinstance(nd, dict) and isinstance(nd.get("inputs"), dict):
                for v in nd["inputs"].values():
                    if isinstance(v, list) and v:
                        queue.append((v, depth + 1))
        return out

    # The entries read in the order the image passed through them.
    if upscaling_found:
        _up_nids = {u.get("_nid") for u in upscaling_found}
        _updeco: list[tuple[int, dict]] = []
        for u in upscaling_found:
            u.pop("_nid", None)
            _uset = _upstream_nids(u.pop("_img_ref", None)) & _up_nids
            _updeco.append((len(_uset), u))
        _updeco.sort(key=lambda t: t[0])
        upscaling_found = [u for _c, u in _updeco]
        for u in upscaling_found:
            if u.get("model") and not any(
                    k in u for k in ("scale_by", "scale_factor", "width",
                                     "height", "resolution")):
                _f = _scale_from_model_name(u["model"])
                if _f:
                    u["scale_by"] = _f
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

    if interpolation_found:
        interp_nids = {ip.get("_nid") for ip in interpolation_found}
        by_nid = {ip.get("_nid"): ip for ip in interpolation_found}
        decorated: list[tuple[int, set, str, dict]] = []
        ups_by_nid: dict = {}
        for ip in interpolation_found:
            _ip_nid = ip.pop("_nid", None)
            ups = _upstream_nids(ip.pop("_img_ref", None)) & interp_nids
            ups_by_nid[_ip_nid] = ups
            decorated.append((len(ups), ups, _ip_nid, ip))
        decorated.sort(key=lambda t: t[0])
        for _cnt, ups, _ip_nid, ip in decorated:
            if "source_fps" in ip or not ups:
                continue
            # Where every interpolator feeding this one targets the same rate,
            # that rate is what this one was handed.
            feeders = [n for n in ups
                       if n in by_nid and not any(
                           n in ups_by_nid.get(m, set()) for m in ups if m != n)]
            feeder_targets = [by_nid[n].get("target_fps") for n in feeders]
            feeder_targets = [t for t in feeder_targets
                              if isinstance(t, (int, float)) and t]
            if (feeders and len(feeder_targets) == len(feeders)
                    and len(set(feeder_targets)) == 1):
                ip["source_fps"] = feeder_targets[0]
        seen_interp: set[str] = set()
        unique_interp: list[dict] = []
        for _cnt, _ups, _ip_nid, ip in decorated:
            key = json.dumps(ip, sort_keys=True, default=str)
            if key in seen_interp:
                continue
            seen_interp.add(key)
            unique_interp.append(ip)
        summary.setdefault("interpolation", unique_interp)

    # A node inside a subgraph carries its parents' ids before its own, so each
    # segment sorts on its number where it has one.
    def _nid_sort_key(nid: str):
        return [(0, int(seg)) if seg.isdigit() else (1, seg) for seg in nid.split(":")]

    # Several encoders can hold different text, so the parts go in graph order,
    # ruled off from each other.
    def _joined_unique(texts: list[tuple[str, str]], clean=None) -> str | None:
        seen: set[str] = set()
        unique: list[str] = []
        for _nid, t in sorted(texts, key=lambda it: _nid_sort_key(it[0])):
            if clean is not None:
                t = clean(t)
                if not t:
                    continue
            if t not in seen:
                seen.add(t)
                unique.append(t)
        if not unique:
            return None
        return "\n---\n".join(unique) if len(unique) > 1 else unique[0]

    for _texts, _skey, _clean in (
            (positive_texts, "positive_prompt",
             lambda t: re.sub(r'<lora:[^>]+>', '', t).strip()),
            (initial_prompts, "initial_prompt", None),
            (tags_texts, "audio_tags", None),
            (lyrics_texts, "audio_lyrics", None),
            (negative_texts, "negative_prompt", None)):
        _joined = _joined_unique(_texts, _clean) if _texts else None
        if _joined is not None:
            summary.setdefault(_skey, _joined)

    if generic_nodes:
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

# A display node fed the file's own prompt or workflow shows the metadata back
# to itself.
def _looks_like_raw_metadata(t: str) -> bool:
    s = t.lstrip()
    if s.startswith("{"):
        return True
    return ('"class_type"' in s or '"last_node_id"' in s
            or '"extra_pnginfo"' in s or '"nodes":' in s)

_WF_WIDGET_KINDS = {"INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"}
_WF_CONTROL_VALUES = {"fixed", "increment", "decrement", "randomize"}

def _wf_map_widgets(node: dict, class_type: str, registry, api_inputs: dict) -> None:
    """`widgets_values` is a bare list in the order the node declares its widget
    inputs, so the registry's signature is what names them. A value stays in the
    list even for an input turned into a link, which is why the index always
    advances. A seed widget is followed by its own control value, which belongs
    to no input and is stepped over.
    """
    wv = node.get("widgets_values")
    if not isinstance(wv, list) or not wv:
        return
    sig = registry.sig(class_type) if registry else None
    if not sig:
        return
    idx = 0
    for name, kind in (sig.get("inputs") or {}).items():
        if kind not in _WF_WIDGET_KINDS:
            continue
        if idx >= len(wv):
            break
        val = wv[idx]
        idx += 1
        if (kind == "INT" and name in ("seed", "noise_seed")
                and idx < len(wv) and isinstance(wv[idx], str) and wv[idx] in _WF_CONTROL_VALUES):
            idx += 1
        api_inputs.setdefault(name, val)

# A subgraph definition can hold instances of another, and each instance is
# expanded into a fresh copy, so a chain where each level holds two of the
# next doubles at every level. Any real workflow sits far inside this.
_SUBGRAPH_MAX_NODES = 20000

class _ExpansionBudget(Exception):
    pass

def _workflow_to_prompt(workflow: dict, registry) -> dict | None:
    """The workflow holds nodes and links where the prompt holds inputs, so each
    link is followed to whatever really produced the value: through a node the
    user muted or bypassed, through a Set and Get pair that carries a value by
    name, and in and out of a subgraph, whose nodes come back with their
    instance id in front. A malformed workflow, or one whose subgraphs expand
    past the budget, gives nothing instead of failing the read.
    """
    try:
        if not isinstance(workflow, dict):
            return None
        expanded = 0
        defs: dict = {}
        for s in ((workflow.get("definitions") or {}).get("subgraphs") or []):
            if isinstance(s, dict) and s.get("id"):
                defs[s["id"]] = s

        set_nodes: dict = {}

        def _wf_norm(t):
            return str(t or "").replace(" ", "").replace("_", "").lower()

        # A Set and its Get are paired by the name in the node's first widget, and
        # fall back to the title, or to the part after an underscore where it has one.
        def _wf_vname(n):
            wv = n.get("widgets_values")
            if isinstance(wv, list) and wv and isinstance(wv[0], str):
                return wv[0]
            t = str(n.get("title") or "")
            return t.split("_", 1)[1] if "_" in t else t

        def build_frame(container, prefix, parent, inst_nid):
            nonlocal expanded
            nodes = {}
            for n in container.get("nodes", []) or []:
                if isinstance(n, dict) and n.get("id") is not None:
                    nodes[n["id"]] = n
            expanded += len(nodes)
            if expanded > _SUBGRAPH_MAX_NODES:
                raise _ExpansionBudget()
            by_target = {}
            by_link = {}
            # A link is written either as the list of its id, origin node,
            # origin slot, target node, target slot and type, or as an object
            # naming the same things.
            for l in container.get("links", []) or []:
                if isinstance(l, (list, tuple)) and len(l) >= 6:
                    by_target[(l[3], l[4])] = (l[1], l[2])
                    by_link[l[0]] = (l[1], l[2])
                elif isinstance(l, dict):
                    by_target[(l.get("target_id"), l.get("target_slot"))] = (l.get("origin_id"), l.get("origin_slot"))
                    by_link[l.get("id")] = (l.get("origin_id"), l.get("origin_slot"))
            fr = {"nodes": nodes, "by_target": by_target, "by_link": by_link, "prefix": prefix,
                  "parent": parent, "inst_nid": inst_nid, "children": {},
                  "in_id": (container.get("inputNode") or {}).get("id"),
                  "out_id": (container.get("outputNode") or {}).get("id"),
                  "input_names": [s.get("name") for s in (container.get("inputs") or []) if isinstance(s, dict)],
                  "output_names": [s.get("name") for s in (container.get("outputs") or []) if isinstance(s, dict)],
                  "output_links": [s.get("linkIds") for s in (container.get("outputs") or []) if isinstance(s, dict)]}
            for nid, n in nodes.items():
                if _wf_norm(n.get("type")) == "setnode":
                    set_nodes.setdefault(_wf_vname(n), (fr, nid))
                if n.get("type") in defs:
                    fr["children"][nid] = build_frame(defs[n["type"]], f"{prefix}{nid}/", fr, nid)
            return fr

        root = build_frame(workflow, "", None, None)

        def resolve_input(fr, node_id, slot, depth):
            src = fr["by_target"].get((node_id, slot))
            if src is None:
                return None
            return resolve_output(fr, src[0], src[1], depth + 1)

        def _bypass_through(fr, node, node_id, slot, depth):
            outs = node.get("outputs") or []
            out_type = outs[slot].get("type") if isinstance(slot, int) and 0 <= slot < len(outs) and isinstance(outs[slot], dict) else None
            for i, inp in enumerate(node.get("inputs") or []):
                if isinstance(inp, dict) and inp.get("link") is not None and (out_type is None or inp.get("type") == out_type):
                    return resolve_input(fr, node_id, i, depth + 1)
            return None

        def resolve_output(fr, node_id, slot, depth):
            if depth > 512:
                return None
            # An output taken from the subgraph's own input node leaves the
            # frame, so the question moves to the matching input of the
            # instance one level up.
            if fr["parent"] is not None and node_id == fr["in_id"]:
                names = fr["input_names"]
                tname = names[slot] if isinstance(slot, int) and 0 <= slot < len(names) else None
                inst = fr["parent"]["nodes"].get(fr["inst_nid"])
                if tname is None or not isinstance(inst, dict):
                    return None
                for j, inp in enumerate(inst.get("inputs") or []):
                    if isinstance(inp, dict) and inp.get("name") == tname:
                        return resolve_input(fr["parent"], fr["inst_nid"], j, depth + 1)
                return None
            node = fr["nodes"].get(node_id)
            if node is None:
                return None
            # Mode 2 is a muted node, which produced nothing, and mode 4 is a
            # bypassed one, which passed its input along.
            mode = node.get("mode")
            if mode == 2:
                return None
            nt = _wf_norm(node.get("type"))
            if nt == "getnode":
                tgt = set_nodes.get(_wf_vname(node))
                return resolve_input(tgt[0], tgt[1], 0, depth + 1) if tgt else None
            if nt == "setnode":
                return resolve_input(fr, node_id, 0, depth + 1)
            if mode == 4:
                return _bypass_through(fr, node, node_id, slot, depth)
            # An output of a subgraph instance is answered inside the subgraph,
            # by the link its matching output slot carries.
            if node.get("type") in defs:
                child = fr["children"].get(node_id)
                if child is None:
                    return None
                outs = node.get("outputs") or []
                oname = outs[slot].get("name") if isinstance(slot, int) and 0 <= slot < len(outs) and isinstance(outs[slot], dict) else None
                onames = child["output_names"]
                oslot = onames.index(oname) if oname in onames else (slot if isinstance(slot, int) else 0)
                olinks = child["output_links"]
                lids = olinks[oslot] if isinstance(oslot, int) and 0 <= oslot < len(olinks) else None
                if lids:
                    src = child["by_link"].get(lids[0])
                    if src is not None:
                        return resolve_output(child, src[0], src[1], depth + 1)
                return resolve_input(child, child["out_id"], oslot, depth + 1)
            return (fr["prefix"] + str(node_id), slot)

        prompt: dict = {}

        def emit(fr):
            for nid, node in fr["nodes"].items():
                ct = node.get("type")
                if ct in defs or node.get("mode") in (2, 4) or not isinstance(ct, str) or not ct \
                        or _wf_norm(ct) in ("setnode", "getnode"):
                    continue
                api_inputs: dict = {}
                for i, inp in enumerate(node.get("inputs") or []):
                    if not isinstance(inp, dict):
                        continue
                    name = inp.get("name")
                    if name is None or inp.get("link") is None:
                        continue
                    s = resolve_input(fr, nid, i, 0)
                    if s is not None:
                        api_inputs[name] = [s[0], s[1]]
                _wf_map_widgets(node, ct, registry, api_inputs)
                prompt[fr["prefix"] + str(nid)] = {"class_type": ct, "inputs": api_inputs}
            for child in fr["children"].values():
                emit(child)

        emit(root)
        return prompt or None
    except Exception:
        return None

def _extract_from_comfyui_workflow(workflow: dict, summary: dict,
                                   linked_size_ids: set[str] | frozenset = frozenset(),
                                   executed_ids: set[str] | None = None):
    """Widget values are whatever was last typed into the editor, so no size is
    read from a node named in `linked_size_ids` or absent from `executed_ids`.
    """
    nodes = workflow.get("nodes", [])
    if not isinstance(nodes, list):
        return

    _RESOLUTION_NODES = {
        "emptylatentimage", "emptysd3latent",
        "wanimagetovideo", "wanvideotovideo", "wanfuncontrolinpaint",
    }
    for node in nodes:
        if not isinstance(node, dict):
            continue
        if str(node.get("id")) in linked_size_ids:
            continue
        if executed_ids is not None and str(node.get("id")) not in executed_ids:
            continue
        ntype = node.get("type", "")
        if ntype.lower().replace(" ", "") in {n.replace(" ", "") for n in _RESOLUTION_NODES}:
            # These nodes take width first and height second.
            widgets = node.get("widgets_values", [])
            if isinstance(widgets, list) and len(widgets) >= 2:
                try:
                    w, h = int(widgets[0]), int(widgets[1])
                    # Outside these bounds the pair is some other widget.
                    if 64 <= w <= 8192 and 64 <= h <= 8192:
                        summary.setdefault("resolution", f"{w}×{h}")
                        summary.setdefault("width", w)
                        summary.setdefault("height", h)
                except (ValueError, TypeError):
                    pass

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
                if _looks_like_raw_metadata(t):
                    raw_meta_ids.add(str(node.get("id")))
                    continue
                wf_show_text[str(node.get("id"))] = t if len(t) <= _NODE_TEXT_MAX else (t[:_NODE_TEXT_MAX] + "…")

    # The workflow's own copy is what the node really displayed, while the text
    # input in the prompt can be a run behind, so this one replaces it.
    if wf_show_text:
        for entry in summary.get("workflow_nodes", []) or []:
            if not isinstance(entry, dict):
                continue
            nid = entry.get("_node_id")
            params = entry.get("params")
            if nid in wf_show_text and isinstance(params, dict):
                params["text"] = wf_show_text[nid]

    if raw_meta_ids:
        summary["workflow_nodes"] = [
            e for e in (summary.get("workflow_nodes") or [])
            if not (isinstance(e, dict) and str(e.get("_node_id")) in raw_meta_ids)
        ]

_MODEL_SCALE_X = re.compile(r"(?:^|[^0-9A-Za-z])[xX](\d{1,2})(?!\d)")
_MODEL_SCALE_NX = re.compile(r"(?:^|[^0-9A-Za-z])(\d{1,2})[xX](?!\d)")

def _scale_from_model_name(name: Any) -> int | None:
    """The factor an upscale model's own name states, written 4x or x4."""
    base = os.path.basename(str(name).replace("\\", "/"))
    for rx in (_MODEL_SCALE_X, _MODEL_SCALE_NX):
        m = rx.search(base)
        if m:
            f = int(m.group(1))
            if 2 <= f <= 16:
                return f
    return None

def _chain_upscale_pass_sizes(summary: dict[str, Any]) -> None:
    """A pass in the middle may state only a factor, so the sizes are filled
    forward from the generation resolution and then backward from the file's
    own, which stands as the last size whatever the forward pass worked out.
    """
    ups = summary.get("upscaling")
    if (not isinstance(ups, list) or not ups
            or not all(isinstance(u, dict) for u in ups)):
        return

    def _parse(res):
        m = re.match(r"^\s*(\d+)\s*[×x]\s*(\d+)\s*$", str(res or ""))
        wh = (int(m.group(1)), int(m.group(2))) if m else None
        return wh if wh and wh[0] > 0 and wh[1] > 0 else None

    def _num(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0 and math.isfinite(v)

    # A pass never produces an empty side, and a side of zero would be divided
    # by on the next pass, so every computed size is floored at one pixel.
    def _size(w, hgt):
        return (max(1, round(w)), max(1, round(hgt)))

    def _fwd(u, cur):
        sb = u.get("scale_by") or u.get("scale_factor")
        w, hgt = u.get("width"), u.get("height")
        if _num(sb):
            return _size(cur[0] * sb, cur[1] * sb)
        if _num(w) and _num(hgt):
            return _size(int(w), int(hgt))
        for key, edge in (("target_resolution", min), ("longer_edge", max)):
            t = u.get(key)
            if _num(t):
                f = t / edge(cur)
                return _size(cur[0] * f, cur[1] * f)
        mp = u.get("megapixels")
        if _num(mp):
            f = (mp * 1_000_000 / (cur[0] * cur[1])) ** 0.5
            return _size(cur[0] * f, cur[1] * f)
        return None

    def _bwd(u, nxt):
        sb = u.get("scale_by") or u.get("scale_factor")
        if _num(sb):
            return _size(nxt[0] / sb, nxt[1] / sb)
        return None

    n = len(ups)
    bounds: list = [None] * (n + 1)
    bounds[0] = _parse(summary.get("generation_resolution"))
    for i, u in enumerate(ups):
        if bounds[i] is not None and bounds[i + 1] is None:
            bounds[i + 1] = _fwd(u, bounds[i])
    file_wh = _parse(summary.get("resolution"))
    if file_wh:
        bounds[n] = file_wh
    for i in range(n - 1, -1, -1):
        if bounds[i + 1] is not None and bounds[i] is None:
            bounds[i] = _bwd(ups[i], bounds[i + 1])

    for i, u in enumerate(ups):
        if bounds[i] is not None:
            u["initial_resolution"] = f"{bounds[i][0]}×{bounds[i][1]}"
        if bounds[i + 1] is not None:
            u["final_resolution"] = f"{bounds[i + 1][0]}×{bounds[i + 1][1]}"

def _derive_generation_resolution(summary: dict[str, Any], w: int, h: int) -> None:
    """With more than one factor in the chain the share each took is a guess, so
    nothing is recorded.
    """
    if summary.get("generation_resolution"):
        return
    ups = summary.get("upscaling")
    if not isinstance(ups, list):
        return
    scales = [u.get("scale_by") for u in ups if isinstance(u, dict)]
    scales = [s for s in scales if isinstance(s, (int, float)) and not isinstance(s, bool) and s > 1]
    if len(scales) != 1:
        return
    gw, gh = round(w / scales[0]), round(h / scales[0])
    if gw >= 16 and gh >= 16:
        summary["generation_resolution"] = f"{gw}×{gh}"

# A camera or an editor writes its own text into the same EXIF fields, so one is
# only read as generation parameters once it carries a marker of them.
def _looks_like_generation_params(text: str) -> bool:
    if re.search(r"(?m)^Negative prompt:", text):
        return True
    if re.search(r"\bSteps:\s*\d+", text):
        return True
    if "<lora:" in text:
        return True
    return False

def _decode_exif_text(raw: Any) -> str | None:
    """The value opens with an eight byte code: `ASCII`, `UNICODE` for UTF-16,
    `JIS`, or eight zero bytes for unstated. Writers get this wrong often
    enough that the rest is sniffed when the code does not hold up.
    """
    if not isinstance(raw, (bytes, bytearray)):
        return raw if isinstance(raw, str) else None
    raw = bytes(raw)

    def _clean(s: str | None) -> str | None:
        if s is None:
            return None
        s = s.replace("﻿", "").replace("\x00", "").strip()
        return s or None

    def _utf16(payload: bytes) -> str | None:
        if payload[:2] in (b"\xff\xfe", b"\xfe\xff"):
            try:
                return _clean(payload.decode("utf-16"))
            except Exception:
                return None
        # Without a byte order mark the endianness is only knowable from what
        # each reading produces.
        best = None
        best_score = None
        for enc in ("utf-16-be", "utf-16-le"):
            try:
                cand = payload.decode(enc)
            except Exception:
                continue
            good = sum(1 for ch in cand if " " <= ch <= "~" or ch in "\n\r\t")
            bad = sum(1 for ch in cand
                      if ch == "\x00"
                      or (ord(ch) < 32 and ch not in "\n\r\t")
                      or 0xD800 <= ord(ch) <= 0xDFFF)
            score = good - 10 * bad
            if best is None or score > best_score:
                best, best_score = cand, score
        return _clean(best)

    if raw.startswith(b"ASCII\x00\x00\x00"):
        return _clean(raw[8:].decode("latin-1", errors="replace"))
    if raw.startswith(b"UNICODE"):
        # The code is seven letters padded to eight bytes with a zero, and some
        # writers put the byte order mark in that eighth byte instead.
        payload = raw[8:] if raw[7:8] == b"\x00" else raw[7:]
        return _utf16(payload)
    if raw.startswith(b"JIS\x00\x00\x00\x00\x00"):
        try:
            return _clean(raw[8:].decode("shift_jis"))
        except Exception:
            return _clean(raw[8:].decode("latin-1", errors="replace"))
    if raw.startswith(b"\x00" * 8):
        raw = raw[8:]
    try:
        s = raw.decode("utf-8")
        if "\x00" not in s:
            return _clean(s)
    except Exception:
        pass
    u16 = _utf16(raw)
    if u16:
        return u16
    return _clean(raw.decode("latin-1", errors="replace"))

def read_image_metadata_best_effort(path: str) -> dict[str, Any]:
    try:
        from PIL import Image
    except Exception:
        return {}

    try:
        with Image.open(path) as img:
            info = dict(img.info or {})
            # Popped by the caller, which would otherwise open the file again
            # for nothing but its size.
            info["_sbg_px"] = img.size
            exif = None
            try:
                exif = img.getexif()
            except Exception:
                exif = None
            if exif:
                info["exif"] = dict(exif)

                # Tag 270 is the image description and 37510 the user comment,
                # which are the two fields a generator writes its parameters to.
                _EXIF_TEXT_TAGS = {270: "parameters", 37510: "parameters"}

                for tag_id, target_key in _EXIF_TEXT_TAGS.items():
                    if target_key in info:
                        break
                    val = _decode_exif_text(exif.get(tag_id))
                    if isinstance(val, str) and val.strip() and _looks_like_generation_params(val):
                        info[target_key] = val.strip()

                # The user comment is usually one level down, in the EXIF sub
                # directory, where reading the top level tags does not reach it.
                if "parameters" not in info:
                    try:
                        ifd = exif.get_ifd(0x8769)
                        if ifd:
                            uc = _decode_exif_text(ifd.get(37510))
                            if isinstance(uc, str) and uc.strip() and _looks_like_generation_params(uc):
                                info["parameters"] = uc.strip()
                    except Exception:
                        pass

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

def read_video_sidecar(path: str, *, max_bytes: int | None = None) -> dict[str, Any] | None:
    """A writer either appends the suffix to the whole name or puts it in place of
    the extension, so both spellings of both names are looked for.
    """
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
            if max_bytes is not None and os.path.getsize(c) > max_bytes:
                continue
            with open(c, "r", encoding="utf-8") as f:
                return json.loads(f.read())
        except Exception:
            continue
    return None

def _duration_fields(secs: float) -> dict[str, Any]:
    mins, s = divmod(int(secs), 60)
    hrs, mins = divmod(mins, 60)
    text = f"{hrs}:{mins:02d}:{s:02d}" if hrs else f"{mins}:{s:02d}"
    return {"duration": text, "duration_seconds": round(secs, 2)}

def _extract_embedded_container_meta(container) -> dict[str, Any]:
    """The prompt and the workflow travel as a JSON object in the container's
    comment tag. Some writers use the description instead, or put the tag on a
    stream and not on the container, and some write each of the two as a tag of
    its own.
    """
    out: dict[str, Any] = {}
    tags = media_av.tags_of(container)
    for stream in container.streams:
        for k, v in media_av.tags_of(stream).items():
            tags.setdefault(k, v)
    comment = tags.get("comment", "") or tags.get("COMMENT", "") or tags.get("Comment", "")
    if not comment:
        for stream in container.streams:
            stags = media_av.tags_of(stream)
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
                    out["prompt"] = comment_data["prompt"]
                if "workflow" in comment_data:
                    out["workflow"] = comment_data["workflow"]
        except (json.JSONDecodeError, ValueError):
            pass
    for key in ("prompt", "workflow"):
        if key in out:
            continue
        v = tags.get(key) or tags.get(key.upper())
        if isinstance(v, str) and v.strip():
            parsed_v = _json_best_effort(v)
            if isinstance(parsed_v, dict):
                out[key] = parsed_v
    return out

def _read_video_av(path: str) -> dict[str, Any]:
    # Video reading is optional, and a file whose fields stay blank is better
    # than a scan that stops.
    try:
        import av
    except Exception:
        return {}

    info: dict[str, Any] = {}

    try:
        with media_av.open_media(path) as container:
            # The container's duration is in microseconds.
            if container.duration:
                info.update(_duration_fields(container.duration / 1_000_000))

            info.update(_extract_embedded_container_meta(container))

            vstreams = container.streams.video
            if vstreams:
                stream = vstreams[0]
                w = stream.width
                h = stream.height
                if w and h:
                    info["resolution"] = f"{w}×{h}"
                # The canonical name is the format's own, while the context's
                # name is whichever decoder was picked to read it.
                cdesc = getattr(stream.codec_context, "codec", None)
                codec = (getattr(cdesc, "canonical_name", None)
                         or getattr(stream.codec_context, "name", None))
                if codec:
                    info["codec"] = codec
                # The declared rate is what the file was written at, and the
                # average is only asked for where there is no declared one.
                for rate in (stream.base_rate, stream.average_rate):
                    if rate:
                        fps = float(rate)
                        # Outside these bounds the figure is no frame rate.
                        if 0 < fps < 1000:
                            info["fps"] = round(fps, 2)
                            break
                nb = stream.frames
                if nb:
                    info["total_frames"] = int(nb)
                if "duration_seconds" not in info and stream.duration and stream.time_base:
                    info.update(_duration_fields(float(stream.duration * stream.time_base)))
    except Exception:
        return {}

    return info

AUDIO_EXTS = media_types.AUDIO_EXTS
VIDEO_EXTS = media_types.VIDEO_EXTS

def _read_audio_av(path: str) -> dict[str, Any]:
    try:
        import av
    except Exception:
        return {}

    info: dict[str, Any] = {}

    # An allowlist, since the tags also carry encoder noise and the embedded
    # prompt.
    _TRACK_TAGS = ("title", "artist", "album", "album_artist", "albumartist",
                   "genre", "date", "year", "track", "composer", "publisher",
                   "copyright", "isrc")

    try:
        with media_av.open_media(path) as container:
            if container.duration:
                info.update(_duration_fields(container.duration / 1_000_000))

            info.update(_extract_embedded_container_meta(container))

            tags = media_av.tags_of(container)
            for stream in container.streams:
                for k, v in media_av.tags_of(stream).items():
                    tags.setdefault(k, v)
            lower = {str(k).lower(): v for k, v in tags.items()}
            track: dict[str, str] = {}
            for name in _TRACK_TAGS:
                v = lower.get(name)
                if isinstance(v, str) and v.strip() and len(v) <= 200:
                    track.setdefault("album_artist" if name == "albumartist" else name,
                                     v.strip())
            if track:
                info["track"] = track

            astreams = container.streams.audio
            if astreams:
                stream = astreams[0]
                cdesc = getattr(stream.codec_context, "codec", None)
                codec = (getattr(cdesc, "canonical_name", None)
                         or getattr(stream.codec_context, "name", None))
                if codec:
                    info["codec"] = codec
                sr = getattr(stream.codec_context, "sample_rate", None)
                if sr:
                    info["sample_rate"] = int(sr)
                ch = getattr(stream, "channels", None)
                if ch:
                    info["channels"] = int(ch)
                if "duration_seconds" not in info and stream.duration and stream.time_base:
                    info.update(_duration_fields(float(stream.duration * stream.time_base)))
                # The container's rate covers every stream in it, so it only
                # stands for the audio where the file holds no picture.
                br = getattr(stream, "bit_rate", None)
                if not br and not container.streams.video:
                    br = container.bit_rate
                if br:
                    info["bitrate"] = int(round(br / 1000))
    except Exception:
        return {}

    return info

def _sidecar_prompt_workflow(path: str, parsed: dict[str, Any],
                             *, max_bytes: int | None = None) -> tuple[Any, Any]:
    sidecar = read_video_sidecar(path, max_bytes=max_bytes)
    if sidecar is None:
        return None, None
    parsed["sidecar"] = sidecar
    prompt = workflow = None
    if isinstance(sidecar, dict):
        prompt = sidecar.get("prompt")
        workflow = sidecar.get("workflow")
        if workflow is None:
            for k in ("extra_pnginfo", "EXTRA_PNGINFO"):
                v = sidecar.get(k)
                if isinstance(v, dict) and "workflow" in v:
                    workflow = v["workflow"]
                    break
        # A sidecar that names neither can be the prompt or the workflow itself,
        # which its own shape tells apart.
        if prompt is None and workflow is None:
            for k, v in sidecar.items():
                if isinstance(v, dict) and "class_type" in v:
                    prompt = sidecar
                    break
        if prompt is None and workflow is None:
            if "nodes" in sidecar and isinstance(sidecar.get("nodes"), list):
                workflow = sidecar
    return prompt, workflow

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
    px: tuple[int, int] | None = None

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
        # A file saved with the extra information wrapped puts the workflow one
        # level down, under either spelling.
        if workflow is None:
            for k in ("extra_pnginfo", "EXTRA_PNGINFO"):
                v = parsed.get(k)
                if isinstance(v, dict) and "workflow" in v:
                    workflow = v.get("workflow")
                    break
    elif ext in {".jpg", ".jpeg", ".webp"}:
        parsed = read_image_metadata_best_effort(path)
        px = parsed.pop("_sbg_px", None) if isinstance(parsed, dict) else None
        prompt = parsed.get("prompt") if isinstance(parsed, dict) else None
        workflow = parsed.get("workflow") if isinstance(parsed, dict) else None
    else:
        # Only a known container extension is probed, since the reader makes up
        # stream fields for anything else.
        info = info_key = None
        if ext in AUDIO_EXTS:
            info, info_key = _read_audio_av(path), "audio_info"
        elif ext in VIDEO_EXTS:
            info, info_key = _read_video_av(path), "video_info"
        if info:
            parsed[info_key] = info
            if "prompt" in info:
                prompt = info.pop("prompt")
            if "workflow" in info:
                workflow = info.pop("workflow")

        if prompt is None and workflow is None:
            prompt, workflow = _sidecar_prompt_workflow(
                path, parsed, max_bytes=max_text_chunk_bytes)

    summary = _extract_summary(prompt, workflow, parsed)

    video_info = parsed.get("video_info") if isinstance(parsed.get("video_info"), dict) else None
    audio_info = parsed.get("audio_info") if isinstance(parsed.get("audio_info"), dict) else None

    # The PNG reader above never opened the image, so its real size is read now.
    file_w = file_h = None
    if px:
        file_w, file_h = px
    elif ext == ".png":
        try:
            from PIL import Image
            with Image.open(path) as img:
                file_w, file_h = img.size
        except Exception:
            pass

    finalize_summary(summary, video_info=video_info, audio_info=audio_info,
                     file_width=file_w, file_height=file_h)

    return MetadataResult(prompt=prompt, workflow=workflow, parsed=parsed, raw_text=raw_text, summary=summary)

def finalize_summary(summary: dict[str, Any], *, video_info: dict | None = None,
                     audio_info: dict | None = None,
                     file_width: int | None = None, file_height: int | None = None) -> None:
    """The file's own size is the resolution, and a size the graph asked for
    becomes the generation resolution. Everything else the container holds only
    fills a gap.
    """
    if audio_info:
        for k in ("duration", "duration_seconds", "codec", "sample_rate",
                  "channels", "bitrate", "track"):
            if k in audio_info:
                summary.setdefault(k, audio_info[k])

    if video_info:
        for k in ("duration", "duration_seconds", "codec", "fps", "total_frames"):
            if k in video_info:
                summary.setdefault(k, video_info[k])
        if "resolution" in video_info:
            _gen_res = summary.get("resolution")
            summary["resolution"] = video_info["resolution"]
            if _gen_res and _gen_res != summary["resolution"]:
                summary.setdefault("generation_resolution", _gen_res)
            try:
                res_parts = video_info["resolution"].replace("×", "x").split("x")
                if len(res_parts) == 2:
                    summary["width"] = int(res_parts[0])
                    summary["height"] = int(res_parts[1])
                    _derive_generation_resolution(summary, summary["width"], summary["height"])
            except (ValueError, TypeError):
                pass

        _interp = summary.get("interpolation")
        _fps = summary.get("fps")
        if isinstance(_interp, list):
            _known_targets = {
                _e.get("target_fps") for _e in _interp
                if isinstance(_e, dict) and isinstance(_e.get("target_fps"), (int, float))
            }
            for _e in _interp:
                if not isinstance(_e, dict):
                    continue
                try:
                    _mult = float(_e.get("multiplier"))
                except (TypeError, ValueError):
                    _mult = 0.0
                if _mult <= 1:
                    continue
                # An interpolator states a multiplier and leaves the rates open,
                # so the file's rate divides down to a source only where there
                # is one interpolator, or where the result meets another's
                # target.
                if "source_fps" not in _e and isinstance(_fps, (int, float)) and _fps:
                    _src = _fps / _mult
                    _src = int(_src) if float(_src).is_integer() else round(_src, 2)
                    if len(_interp) == 1 or _src in _known_targets:
                        _e["source_fps"] = _src
                _src = _e.get("source_fps")
                if "target_fps" not in _e and isinstance(_src, (int, float)) and _src:
                    _tgt = _src * _mult
                    _e["target_fps"] = int(_tgt) if float(_tgt).is_integer() else round(_tgt, 2)

    if file_width and file_height and file_width > 0 and file_height > 0:
        _gen_res = summary.get("resolution")
        summary["resolution"] = f"{file_width}×{file_height}"
        summary["width"] = file_width
        summary["height"] = file_height
        if _gen_res and _gen_res != summary["resolution"]:
            summary.setdefault("generation_resolution", _gen_res)
        _derive_generation_resolution(summary, file_width, file_height)

    _chain_upscale_pass_sizes(summary)

def guess_mime(path: str) -> str:
    return mimetypes.guess_type(path)[0] or "application/octet-stream"
