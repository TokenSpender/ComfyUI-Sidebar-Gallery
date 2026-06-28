"""ComfyUI node-signature registry, structural classification, and the
pure-value link resolver.

This replaces the parser's name-pattern guessing with ComfyUI's own knowledge
of every installed node: input names/types, output names/types, category.

- NodeRegistry: live mode reads ComfyUI's NODE_CLASS_MAPPINGS in-process;
  snapshot mode loads the /object_info-shaped JSON written by
  tools/build_fixtures.py so tests run without ComfyUI. Unknown classes
  return None and callers fall back to the legacy name heuristics.

- classify(): structural role of a node (sampler / text_encode / loader /
  lora / image_resize / latent_resize / interpolation / display / switch /
  zero_conditioning) derived from its I/O types, not its name.

- resolve_link(): follow a [node_id, slot] reference to a concrete value.
  A value is only trusted if its producer is a PURE VALUE node — all of its
  own connected inputs are scalars (recursively). Output slots are matched
  by their declared names (GetImageSize width/height, mxSlider2D X/Y, JPS
  width/height from a "WxH" combo string). Runtime-measured values (an
  IMAGE-fed producer) yield UNRESOLVED, never an unrelated upstream literal.
"""
from __future__ import annotations

import json
import math
import os
import re
from typing import Any

# Tensor-ish type names: a node with a CONNECTED input of one of these kinds
# computes its output at runtime — its value is not in the file.
_SCALAR_TYPE_NAMES = {"INT", "FLOAT", "STRING", "BOOLEAN", "NUMBER", "COMBO"}

_DIM_STRING_RE = re.compile(r"(\d{2,5})\s*[x×]\s*(\d{2,5})")

# Sentinel: the chain crossed a node we have no signature for — the caller
# should fall back to the legacy resolver (which handles unknown packs).
UNKNOWN = object()
# Sentinel: provably unresolvable from the file (runtime-measured / ambiguous).
UNRESOLVED = object()


class NodeRegistry:
    """Signature lookup per class_type. sig() returns a dict:
    {category, output_names, output_types, output_node, inputs: {name: kind}}
    where kind is the raw type string ("INT", "IMAGE", …) or "COMBO" for
    enum widgets; or None for unknown classes."""

    def __init__(self, table: dict[str, dict] | None = None):
        self._table = table  # snapshot mode when not None
        self._cache: dict[str, dict | None] = {}

    @staticmethod
    def from_snapshot(path: str) -> "NodeRegistry":
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        table = {}
        for ct, info in raw.items():
            inputs = {}
            for src in ("input_required", "input_optional"):
                for k, t in (info.get(src) or {}).items():
                    inputs[k] = "COMBO" if isinstance(t, list) else (t or "*")
            table[ct] = {
                "category": info.get("category") or "",
                "output_names": [str(n) for n in (info.get("output_name") or [])],
                "output_types": ["COMBO" if isinstance(t, (list, tuple)) else str(t)
                                 for t in (info.get("output") or [])],
                "output_node": bool(info.get("output_node")),
                "inputs": inputs,
            }
        return NodeRegistry(table)

    def sig(self, class_type: str) -> dict | None:
        if not class_type:
            return None
        if class_type in self._cache:
            return self._cache[class_type]
        out: dict | None = None
        if self._table is not None:
            out = self._table.get(class_type)
        else:
            out = self._live_sig(class_type)
        # Only memoize HITS. Caching a miss would pin a class as "unknown" for
        # the whole process, so a node pack installed mid-session (live mode
        # hot-reloads NODE_CLASS_MAPPINGS) would never be picked up. Re-resolving
        # an unknown class is just a dict miss — cheap, no INPUT_TYPES() call.
        if out is not None:
            self._cache[class_type] = out
        return out

    @staticmethod
    def _live_sig(class_type: str) -> dict | None:
        try:
            import nodes as comfy_nodes  # ComfyUI's module; we run in-process
            cls = comfy_nodes.NODE_CLASS_MAPPINGS.get(class_type)
            if cls is None:
                return None
            it = cls.INPUT_TYPES() if hasattr(cls, "INPUT_TYPES") else {}
            inputs = {}
            for src in ("required", "optional"):
                for k, spec in (it.get(src) or {}).items():
                    t = spec[0] if isinstance(spec, (list, tuple)) and spec else None
                    inputs[k] = "COMBO" if isinstance(t, (list, tuple)) else (str(t) if t else "*")
            rt = ["COMBO" if isinstance(t, (list, tuple)) else str(t)
                  for t in (getattr(cls, "RETURN_TYPES", ()) or ())]
            rn = [str(n) for n in (getattr(cls, "RETURN_NAMES", ()) or ())] or list(rt)
            return {
                "category": str(getattr(cls, "CATEGORY", "") or ""),
                "output_names": rn,
                "output_types": rt,
                "output_node": bool(getattr(cls, "OUTPUT_NODE", False)),
                "inputs": inputs,
            }
        except Exception:
            return None


_live_registry: NodeRegistry | None = None


def get_registry() -> NodeRegistry:
    """The process-wide registry: live inside ComfyUI, snapshot in tests
    (SBG_OBJECT_INFO_SNAPSHOT env var or tests/fixtures fallback)."""
    global _live_registry
    if _live_registry is not None:
        return _live_registry
    snap = os.environ.get("SBG_OBJECT_INFO_SNAPSHOT")
    if not snap:
        try:
            import nodes  # noqa: F401 — running inside ComfyUI
            _live_registry = NodeRegistry(None)
            return _live_registry
        except Exception:
            cand = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "tests", "fixtures", "object_info_snapshot.json")
            snap = cand if os.path.isfile(cand) else None
    if snap and os.path.isfile(snap):
        _live_registry = NodeRegistry.from_snapshot(snap)
    else:
        _live_registry = NodeRegistry({})  # nothing known — callers use legacy paths
    return _live_registry


def _is_scalar_kind(kind: str) -> bool:
    return kind in _SCALAR_TYPE_NAMES


# ── Structural classification ─────────────────────────────────────────

_SAMPLER_PARAM_NAMES = {"steps", "cfg", "seed", "noise_seed", "denoise", "sampler_name"}

# Name-only sampler test for UNKNOWN (uninstalled-pack) classes — the single
# source of truth shared by find_generation_resolution and metadata.py's
# extractor so the two can't drift. Excludes selectors, parameter packers and
# audio/LLM "samplers" that aren't diffusion samplers.
_NOT_A_SAMPLER_NAME = ("select", "mmaudio", "parameter", "packer",
                       "llava", "llama", "llm", "vlm")


def name_says_sampler(class_type: str) -> bool:
    ct = str(class_type).lower()
    return "sampler" in ct and not any(x in ct for x in _NOT_A_SAMPLER_NAME)


def classify(class_type: str, sig: dict | None) -> str | None:
    """Structural role, or None when the class is unknown (legacy fallback)."""
    if not sig:
        return None
    inputs: dict[str, str] = sig["inputs"]
    out_types = set(sig["output_types"])
    in_types = set(inputs.values())
    ctl = class_type.lower()

    # rgthree Context / Context Big (and similar pipe bundles) carry a CONTEXT
    # object on output slot 0 and expose seed/steps/cfg as PASSTHROUGH fields.
    # They are carriers, not samplers — classify them as such BEFORE the sampler
    # test, which would otherwise fire on their LATENT output + seed/steps/cfg
    # inputs and yield a phantom sampler. resolve_link already treats CONTEXT
    # slots as passthrough; this keeps classify() consistent with it.
    out_names = sig["output_names"] or []
    if out_names and str(out_names[0]).upper() == "CONTEXT":
        return "context"

    if "zeroout" in ctl and "CONDITIONING" in out_types:
        return "zero_conditioning"
    # Samplers: produce a LATENT and take denoising parameters, or are the
    # custom-sampling executor (NOISE/GUIDER/SIGMAS plumbing).
    if "LATENT" in out_types:
        if _SAMPLER_PARAM_NAMES & set(inputs):
            return "sampler"
        if {"NOISE", "GUIDER", "SIGMAS"} & in_types:
            return "sampler"
    if "CONDITIONING" in out_types and "CLIP" in in_types:
        return "text_encode"
    # Image-space resize/upscale: IMAGE in and out, with a size-ish parameter
    # or an upscaling category/model input.
    if "IMAGE" in out_types and "IMAGE" in in_types:
        if {"source_fps", "target_fps", "multiplier"} & set(inputs):
            return "interpolation"
        if "UPSCALE_MODEL" in in_types or "upscal" in (sig["category"] or "").lower():
            return "image_resize"
        if {"upscale_method", "scale_method", "scale_by", "scale", "megapixels",
            "resolution", "longer_edge", "width", "height"} & set(inputs):
            return "image_resize"
    if "LATENT" in out_types and "LATENT" in in_types and (
            {"upscale_method", "scale_by", "width", "height"} & set(inputs)):
        return "latent_resize"
    # Loaders: no tensor inputs, produce model-ish objects.
    tensorish_in = {t for t in in_types if not _is_scalar_kind(t) and t != "*"}
    if not tensorish_in and ({"MODEL", "CLIP", "VAE", "UPSCALE_MODEL", "CONTROL_NET"} & out_types):
        return "loader"
    if "MODEL" in out_types and "MODEL" in in_types and any(
            k == "lora_name" or k.startswith("lora_") for k in inputs):
        return "lora"
    if sig["output_node"] and ("STRING" in in_types or "*" in in_types):
        return "display"
    if sig["output_types"] and all(t == "*" for t in sig["output_types"]) and (
            not inputs or any(t == "*" for t in in_types)):
        return "switch"
    return "other"


# ── Pure-value link resolution ────────────────────────────────────────


def _resolve_context_field(prompt: dict, node_id: str, field_name: str,
                           registry: NodeRegistry, depth: int, visited: set):
    """Resolve a named field out of an rgthree Context bundle.

    The field is set on this Context node directly (an override input) or
    inherited from the base context it extends — follow base_ctx upward.
    Returns the scalar value, or UNRESOLVED.
    """
    if depth > 12:
        return UNRESOLVED
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return UNRESOLVED
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        return UNRESOLVED
    fl = field_name.lower()
    # Direct override on this context node.
    if fl in inputs:
        v = inputs[fl]
        if isinstance(v, list):
            return resolve_link(prompt, v, registry, depth + 1, visited)
        return v
    # Otherwise inherit from the base context. If the base is produced by a
    # class the registry doesn't know, return UNKNOWN (not UNRESOLVED) so the
    # caller falls back to the legacy resolver instead of silently giving up.
    for bk in ("base_ctx", "ctx", "context"):
        bv = inputs.get(bk)
        if isinstance(bv, list) and len(bv) >= 1:
            base_node = prompt.get(str(bv[0]))
            if isinstance(base_node, dict) and registry.sig(base_node.get("class_type", "")) is None:
                return UNKNOWN
            return _resolve_context_field(prompt, bv[0], field_name, registry, depth + 1, visited)
    return UNRESOLVED


def _node_of(prompt: dict, ref: Any) -> tuple[dict | None, str, int]:
    if not (isinstance(ref, list) and len(ref) >= 1):
        return None, "", 0
    nid = str(ref[0])
    slot = ref[1] if len(ref) > 1 and isinstance(ref[1], int) else 0
    node = prompt.get(nid)
    return (node if isinstance(node, dict) else None), nid, slot


def resolve_link(prompt: dict, ref: Any, registry: NodeRegistry,
                 _depth: int = 0, _visited: set | None = None):
    """Resolve [node_id, slot] to a scalar value, UNRESOLVED, or UNKNOWN.

    UNKNOWN means the chain crossed a class the registry doesn't know —
    the caller should use the legacy resolver for this link.
    """
    if _depth > 10:
        return UNRESOLVED
    node, nid, slot = _node_of(prompt, ref)
    if node is None:
        return UNRESOLVED
    _visited = _visited or set()
    vkey = f"{nid}:{slot}"
    if vkey in _visited:
        return UNRESOLVED
    _visited.add(vkey)

    ct = node.get("class_type", "")
    sig = registry.sig(ct)
    if sig is None:
        return UNKNOWN
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        return UNRESOLVED
    in_kinds: dict[str, str] = sig["inputs"]
    out_names_all = sig["output_names"] or []
    out_name = str(out_names_all[slot]) if slot < len(out_names_all) else ""

    # Context bundles (rgthree Context / Context Big): a passthrough carrier,
    # NOT a runtime computation. Output slot N carries a named field (SEED,
    # STEPS, STEP_REFINER, CFG…); resolve that field through this node's own
    # input or, if absent, the base context it extends. Must run BEFORE the
    # purity gate (the base_ctx input is a non-scalar bundle type).
    if (out_names_all and str(out_names_all[0]).upper() == "CONTEXT"
            and slot > 0 and out_name):
        return _resolve_context_field(prompt, nid, out_name, registry, _depth + 1, _visited)

    # Purity: every CONNECTED input must be scalar-typed (or itself pure).
    # An IMAGE/LATENT/... input means the output is computed at runtime.
    tensor_connected = any(
        isinstance(v, list) and not _is_scalar_kind(in_kinds.get(k, "*")) and in_kinds.get(k, "*") != "*"
        for k, v in inputs.items()
    )
    if tensor_connected:
        return UNRESOLVED  # runtime-measured (GetImageSize and friends)

    role = classify(ct, sig)

    # Switches (rgthree Any Switch and friends): the FIRST connected input wins
    # — literal widget fallbacks are ignored. So return the first connected
    # branch that resolves; only if no branch resolves fall back to a literal.
    if role == "switch":
        saw_unknown = False
        for k, v in inputs.items():
            if isinstance(v, list):
                r = resolve_link(prompt, v, registry, _depth + 1, _visited)
                if r is UNKNOWN:
                    saw_unknown = True  # try the other branches before deferring
                    continue
                if r is not UNRESOLVED and r is not None:
                    return r
        if saw_unknown:
            return UNKNOWN  # a branch crossed an unknown pack — let legacy resolve
        # No branch resolved → fall back to a lone literal widget. Exclude bools:
        # a switch's literal fallback carries a value, not a control flag, and a
        # stray bool returned where a numeric param is expected would be wrong.
        lits = [v for v in inputs.values()
                if isinstance(v, (int, float, str)) and not isinstance(v, bool)]
        return lits[0] if len(lits) == 1 else UNRESOLVED

    # Math-expression nodes: their computed result IS the value.
    from . import metadata as _md  # late import to avoid a cycle
    if _md._is_math_node(ct):
        res = _md._eval_math_node(prompt, node)
        return res if res is not None else UNRESOLVED

    def _value_of(input_name: str):
        v = inputs.get(input_name)
        if isinstance(v, list):
            return resolve_link(prompt, v, registry, _depth + 1, _visited)
        return v

    # 1) input named like the output slot (GetImageSize-style): exact match
    # first, else case-insensitive. The named input is authoritative for this
    # slot — return its value, or propagate the UNRESOLVED/UNKNOWN sentinel
    # (both are real answers; don't fall through to a later strategy and risk
    # returning an unrelated input's value).
    lower_map = {k.lower(): k for k in inputs}
    match_key = None
    if out_name:
        if out_name in inputs:
            match_key = out_name
        elif out_name.lower() in lower_map:
            match_key = lower_map[out_name.lower()]
    if match_key is not None:
        v = _value_of(match_key)
        if v is not None:
            return v

    # 2) prefixed inputs (mxSlider2D: output "X" → inputs Xi/Xf + isfloatX).
    # Require the match to be the output name plus a SHORT suffix (≤2 chars, the
    # i/f of Xi/Xf) so an unrelated input that merely shares a leading letter
    # (e.g. "weight" for output "W") can't masquerade as the value.
    if out_name:
        pref = [k for k in inputs if k.lower().startswith(out_name.lower())
                and not k.lower().startswith("isfloat")
                and len(k) - len(out_name) <= 2]
        if pref:
            flag = inputs.get(f"isfloat{out_name}")
            chosen = None
            if flag is not None and len(pref) > 1:
                want_suffix = "f" if flag else "i"
                for k in pref:
                    if k.lower() == (out_name + want_suffix).lower():
                        chosen = k
                        break
            if chosen is None:
                chosen = pref[0]
            v = _value_of(chosen)
            if v not in (None, UNRESOLVED, UNKNOWN):
                return v

    # 3) "WxH" combo string for width/height-named outputs (JPS, CR Aspect…).
    if out_name.lower() in ("width", "height", "w", "h"):
        for v in inputs.values():
            if isinstance(v, str):
                m = _DIM_STRING_RE.search(v)
                if m:
                    return int(m.group(1 if out_name.lower() in ("width", "w") else 2))

    # 4) single scalar widget → that's the value (Primitive*, sliders, Seed…).
    scalars = [(k, v) for k, v in inputs.items()
               if isinstance(v, (int, float, str, bool)) and not isinstance(v, dict)]
    # Ignore obvious control widgets that never carry the value.
    scalars = [(k, v) for k, v in scalars
               if k.lower() not in ("control_after_generate", "autorefresh", "is_changed")]
    if len(scalars) == 1:
        v = scalars[0][1]
        if isinstance(v, str):
            m = _DIM_STRING_RE.search(v)
            if m and out_name.lower() in ("width", "height", "w", "h"):
                return int(m.group(1 if out_name.lower() in ("width", "w") else 2))
        return v

    # 5) single connected scalar link.
    links = [v for k, v in inputs.items() if isinstance(v, list)]
    if len(links) == 1 and not scalars:
        return resolve_link(prompt, links[0], registry, _depth + 1, _visited)

    return UNRESOLVED


# ── Pipeline model: generation resolution from the active sampler chain ──


def _build_consumers(prompt: dict) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for nid, nd in prompt.items():
        if not isinstance(nd, dict) or not isinstance(nd.get("inputs"), dict):
            continue
        for v in nd["inputs"].values():
            if isinstance(v, list) and len(v) >= 1:
                out.setdefault(str(v[0]), []).append(str(nid))
    return out


def _is_output_like(class_type: str, sig: dict | None) -> bool:
    """Output/save/display node? Uses ComfyUI's OUTPUT_NODE flag when the class
    is known; for unknown classes a tight name match that excludes parameter
    packers / selectors / loaders (which can carry a saver-suite tag in their
    name, e.g. 'Sampler Parameters (ImageSaver)')."""
    if sig is not None:
        return bool(sig["output_node"])
    return bool(re.search(r"save|videocombine|preview", class_type, re.I)
                and not re.search(r"parameter|packer|unpacker|selector|loader|"
                                  r"generator|bridge|reroute|switch",
                                  class_type, re.I))


def _is_display_node(class_type: str) -> bool:
    """Terminal show/display node (ShowText/DisplayAny/…) the user placed to view
    a value. dead_node_ids keeps it (and its upstream) alive so its shown text is
    captured — but it is NOT a save output, so find_generation_resolution must not
    treat a sampler that only feeds a display as 'active' (which would change or
    null the reported generation resolution)."""
    return bool(re.search(r"showtext|showany|showstring|displaytext|displayany|showlabel",
                          class_type, re.I))


def _reaches_output_node(prompt: dict, nid: str, consumers: dict[str, list[str]],
                         registry: NodeRegistry) -> tuple[bool, bool]:
    """(reaches_output, via_ambiguous_switch): does this node's output flow
    into a save node, and does the path cross a runtime switch that also has
    OTHER connected branches (so which branch produced the saved pixels is
    not knowable from the file)?

    The `seen` set alone bounds the walk; there is deliberately NO depth cap —
    one would falsely report a node many hops upstream of the save node as not
    reaching it, silently dropping its metadata on deep (video/upscale) graphs.
    """
    queue = [(nid, False)]
    seen: set[str] = set()
    found = ambiguous = False
    while queue:
        cur, amb = queue.pop(0)
        if cur in seen:
            continue
        seen.add(cur)
        node = prompt.get(cur)
        node_amb = amb
        if isinstance(node, dict):
            ct = node.get("class_type", "")
            sig = registry.sig(ct)
            role = classify(ct, sig)
            if (role == "switch" or (sig is None and "switch" in ct.lower())):
                branch_refs = [v for v in (node.get("inputs") or {}).values() if isinstance(v, list)]
                if len(branch_refs) >= 2 and any(
                        not _originates_from(prompt, br, nid) for br in branch_refs):
                    node_amb = True
            if _is_output_like(ct, sig):
                found = True
                ambiguous = ambiguous or node_amb
                continue
        for nxt in consumers.get(cur, []):
            queue.append((nxt, node_amb))
    return found, ambiguous


def _originates_from(prompt: dict, ref: Any, target_id: str) -> bool:
    # The `seen` set bounds the upstream walk; no depth cap (a cap could falsely
    # report a branch as NOT originating from the start node, over-flagging a
    # switch as ambiguous on deep graphs).
    queue = [ref]
    seen: set[str] = set()
    while queue:
        cur = queue.pop(0)
        if not (isinstance(cur, list) and len(cur) >= 1):
            continue
        cid = str(cur[0])
        if cid == str(target_id):
            return True
        if cid in seen:
            continue
        seen.add(cid)
        node = prompt.get(cid)
        if isinstance(node, dict) and isinstance(node.get("inputs"), dict):
            for v in node["inputs"].values():
                if isinstance(v, list):
                    queue.append(v)
    return False


def find_generation_resolution(prompt: dict, registry: NodeRegistry,
                               legacy_dim_fn=None) -> tuple[int, int] | None:
    """The latent size entering the FIRST active sampler.

    Walks each sampler's latent chain upstream to its source (EmptyLatent*-
    style node or an image-to-video conditioner with width/height). Samplers
    whose output never reaches a save node are editing leftovers and are
    ignored. img2img sources (VAEEncode) and runtime-measured sizes yield
    None — the honest answer.
    """
    consumers = _build_consumers(prompt)
    sampler_ids: list[str] = []
    for nid, nd in prompt.items():
        if not isinstance(nd, dict):
            continue
        ct = nd.get("class_type", "")
        sig = registry.sig(ct)
        role = classify(ct, sig)
        if role == "sampler":
            sampler_ids.append(str(nid))
        elif role is None and name_says_sampler(ct):
            sampler_ids.append(str(nid))
    if not sampler_ids:
        return None

    def latent_source(start_nid: str, depth: int = 0, seen: set | None = None):
        """Follow the latent input chain up to the node that CREATES the latent."""
        seen = seen or set()
        if depth > 15 or start_nid in seen:
            return None
        seen.add(start_nid)
        node = prompt.get(start_nid)
        if not isinstance(node, dict):
            return None
        inputs = node.get("inputs", {})
        if not isinstance(inputs, dict):
            return None
        sig = registry.sig(node.get("class_type", ""))
        # Candidate latent-carrying inputs (typed LATENT when known, else by name).
        for k, v in inputs.items():
            if not isinstance(v, list):
                continue
            kind = (sig["inputs"].get(k, "*") if sig else "*")
            if (sig and "LATENT" in kind) or (not sig and k in ("latent_image", "samples", "latent")):
                src_node, src_id, _slot = _node_of(prompt, v)
                if src_node is None:
                    return None
                s_sig = registry.sig(src_node.get("class_type", ""))
                s_role = classify(src_node.get("class_type", ""), s_sig)
                s_inputs = src_node.get("inputs", {}) if isinstance(src_node.get("inputs"), dict) else {}
                has_latent_in = any(
                    isinstance(sv, list) and ((s_sig and "LATENT" in s_sig["inputs"].get(sk, "")) or
                                              (not s_sig and sk in ("latent_image", "samples", "latent")))
                    for sk, sv in s_inputs.items())
                takes_pixels = any(
                    isinstance(sv, list) and ((s_sig and s_sig["inputs"].get(sk, "") == "IMAGE") or
                                              (not s_sig and sk in ("pixels", "image")))
                    for sk, sv in s_inputs.items())
                if s_role == "sampler" or has_latent_in:
                    # another sampler or a latent op — keep walking up
                    return latent_source(src_id, depth + 1, seen)
                if takes_pixels and not ("width" in s_inputs or "height" in s_inputs):
                    return "img2img"  # VAEEncode — size not in the file
                if "width" in s_inputs or "height" in s_inputs:
                    return src_node  # EmptyLatent* / WanImageToVideo-style creator
                return None
        return None

    # Prefer samplers that actually flow into an output node; among them, the
    # one whose chain ends at a latent CREATOR (the first pass). When every
    # path to the output crosses a multi-branch runtime switch, which branch
    # produced the saved pixels is unknowable — claim nothing.
    reach = {s: _reaches_output_node(prompt, s, consumers, registry) for s in sampler_ids}
    unambiguous = [s for s in sampler_ids if reach[s][0] and not reach[s][1]]
    active = [s for s in sampler_ids if reach[s][0]]
    if active and not unambiguous:
        return None
    for sid in (unambiguous or active or sampler_ids):
        src = latent_source(sid)
        if src == "img2img":
            continue  # this pass starts from a measured image — try other samplers
        if isinstance(src, dict):
            inputs = src.get("inputs", {})
            wv, hv = inputs.get("width"), inputs.get("height")
            if isinstance(wv, list):
                wv = resolve_dimension(prompt, wv, 0, registry, legacy_dim_fn)
            if isinstance(hv, list):
                hv = resolve_dimension(prompt, hv, 1, registry, legacy_dim_fn)
            try:
                wi, hi = int(wv), int(hv)
                if 16 <= wi <= 16384 and 16 <= hi <= 16384:
                    return wi, hi
            except (TypeError, ValueError):
                pass
            continue  # creator found but size unresolvable here — try other samplers
    return None


_BROADCAST_PATTERNS = ("anythingeverywhere", "useeverywhere", "everywhere",
                       "setnode", "getnode")


def has_implicit_links(prompt: dict, registry: NodeRegistry) -> bool:
    """True if the graph uses nodes that create connections NOT present as
    explicit input links — rgthree 'Anything Everywhere'/'Use Everywhere'
    broadcasts and Set/Get virtual wires. When present, explicit-link
    reachability is incomplete, so dead-node detection must stand down."""
    for nd in prompt.values():
        if not isinstance(nd, dict):
            continue
        ct = str(nd.get("class_type", "")).lower().replace(" ", "").replace("_", "")
        if any(b in ct for b in _BROADCAST_PATTERNS):
            return True
    return False


def dead_node_ids(prompt: dict, registry: NodeRegistry) -> set[str]:
    """Node ids that take no part in producing the saved output — disconnected
    editing leftovers (e.g. an LLava sampler wired to nothing) that should not
    appear in the metadata panel.

    Computed ONLY for graphs without implicit-link nodes, where reachability
    through explicit input links is exact. With broadcasts/Set-Get present the
    set is empty (conservative: a node that looks unconnected may be broadcast
    upstream, so keep it). A node is kept when it (transitively) feeds an
    output/save node OR is itself one (a ShowText/Preview the user placed).
    """
    if has_implicit_links(prompt, registry):
        return set()
    # Need at least one recognizable output/save node to anchor reachability;
    # without one (atypical graphs, test stubs) liveness can't be judged — keep
    # everything rather than nuke the whole graph.
    output_ids = [str(nid) for nid, nd in prompt.items()
                  if isinstance(nd, dict)
                  and (_is_output_like(nd.get("class_type", ""), registry.sig(nd.get("class_type", "")))
                       or _is_display_node(nd.get("class_type", "")))]
    if not output_ids:
        return set()
    # A node is LIVE if it (transitively) feeds an output. ONE reverse walk from
    # the outputs to their producers marks every such node in O(N+E) — instead
    # of a separate forward BFS per node (O(N·(N+E)), and with its old depth cap
    # it also dropped live nodes far upstream of the save node). dead = the rest.
    live: set[str] = set()
    queue = list(output_ids)
    while queue:
        cur = queue.pop()
        if cur in live:
            continue
        live.add(cur)
        node = prompt.get(cur)
        if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
            continue
        for v in node["inputs"].values():
            if isinstance(v, list) and len(v) >= 1:
                producer = str(v[0])
                if producer not in live and isinstance(prompt.get(producer), dict):
                    queue.append(producer)
    return {str(nid) for nid, nd in prompt.items()
            if isinstance(nd, dict) and str(nid) not in live}


def resolve_dimension(prompt: dict, ref: Any, axis: int, registry: NodeRegistry,
                      legacy_fn=None):
    """Resolve a width/height link to an int. axis: 0=width, 1=height.
    Falls back to legacy_fn(ref, axis) when the chain crosses unknown nodes."""
    r = resolve_link(prompt, ref, registry)
    if r is UNKNOWN and legacy_fn is not None:
        return legacy_fn(ref, axis)
    if r in (UNRESOLVED, UNKNOWN) or isinstance(r, bool):
        return None
    if isinstance(r, (int, float)):
        return int(r)
    if isinstance(r, str):
        m = _DIM_STRING_RE.search(r)
        if m:
            return int(m.group(1 if axis == 0 else 2))
        try:
            f = float(r)
            if math.isfinite(f):
                return int(f)
        except ValueError:
            pass
    return None
