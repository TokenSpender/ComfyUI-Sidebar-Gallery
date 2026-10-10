from __future__ import annotations

import json
import math
import os
import re
from typing import Any

_SCALAR_TYPE_NAMES = {"INT", "FLOAT", "STRING", "BOOLEAN", "NUMBER", "COMBO"}

# Matches the size inside a resolution preset widget's text.
_DIM_STRING_RE = re.compile(r"(\d{2,5})\s*[x×]\s*(\d{2,5})")

# The node class is absent from the registry, so nothing can be said about it.
UNKNOWN = object()

# The links were followed to their end and no value was set anywhere along them.
NO_VALUE = object()
# A value the prompt cannot pin down, as when the producer computes it at run
# time or two branches give different answers.
UNRESOLVED = object()

class NodeRegistry:

    def __init__(self, table: dict[str, dict] | None = None):
        self._table = table
        self._cache: dict[str, dict | None] = {}

    @staticmethod
    def from_snapshot(path: str) -> "NodeRegistry":
        with open(path, encoding="utf-8") as f:
            raw = json.load(f)
        table = {}
        for ct, info in raw.items():
            # In an /object_info reply a dropdown input or output carries the
            # list of its choices where a type name would otherwise be.
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
        if out is not None:
            # A cached miss would pin a class as unknown for the life of the
            # process, so a pack loaded later would never be seen.
            self._cache[class_type] = out
        return out

    @staticmethod
    def _live_sig(class_type: str) -> dict | None:
        try:
            import nodes as comfy_nodes
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
    # A snapshot named in the environment wins over the live node table, which
    # is what lets the parser run outside a ComfyUI process.
    global _live_registry
    if _live_registry is not None:
        return _live_registry
    snap = os.environ.get("SBG_OBJECT_INFO_SNAPSHOT")
    if not snap:
        try:
            # Imported for the exception alone, to settle whether ComfyUI is
            # in the process.
            import nodes
            _live_registry = NodeRegistry(None)
            return _live_registry
        except Exception:
            cand = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "object_info_snapshot.json")
            snap = cand if os.path.isfile(cand) else None
    if snap and os.path.isfile(snap):
        _live_registry = NodeRegistry.from_snapshot(snap)
    else:
        _live_registry = NodeRegistry({})
    return _live_registry

def _is_scalar_kind(kind: str) -> bool:
    return kind in _SCALAR_TYPE_NAMES

_SAMPLER_PARAM_NAMES = {"steps", "cfg", "seed", "noise_seed", "denoise", "sampler_name"}

# Names that carry the word sampler while not being the sampler that made the
# image: a picker, a carrier of settings, and audio or language model nodes.
_NOT_A_SAMPLER_NAME = ("select", "mmaudio", "parameter", "packer",
                       "llava", "llama", "llm", "vlm")

def name_says_sampler(class_type: str) -> bool:
    ct = str(class_type).lower()
    return "sampler" in ct and not any(x in ct for x in _NOT_A_SAMPLER_NAME)

def classify(class_type: str, sig: dict | None) -> str | None:
    if not sig:
        return None
    inputs: dict[str, str] = sig["inputs"]
    out_types = set(sig["output_types"])
    in_types = set(inputs.values())
    ctl = class_type.lower()

    # A node whose first output is named CONTEXT carries a bundle of named
    # fields instead of one value.
    out_names = sig["output_names"] or []
    if out_names and str(out_names[0]).upper() == "CONTEXT":
        return "context"

    if "zeroout" in ctl and "CONDITIONING" in out_types:
        return "zero_conditioning"
    if "LATENT" in out_types:
        if _SAMPLER_PARAM_NAMES & set(inputs):
            return "sampler"
        if {"NOISE", "GUIDER", "SIGMAS"} & in_types:
            return "sampler"
    if "CONDITIONING" in out_types and "CLIP" in in_types:
        return "text_encode"
    if "IMAGE" in out_types and "IMAGE" in in_types:
        if {"source_fps", "target_fps", "multiplier"} & set(inputs):
            return "interpolation"
        if "UPSCALE_MODEL" in in_types or "upscal" in (sig["category"] or "").lower():
            return "image_resize"
        if {"upscale_method", "scale_method", "scale_by", "scale", "megapixels",
            "resolution", "longer_edge", "width", "height",
            "generation_width", "generation_height",
            "target_width", "target_height"} & set(inputs):
            return "image_resize"
    if "LATENT" in out_types and "LATENT" in in_types and (
            {"upscale_method", "scale_by", "width", "height"} & set(inputs)):
        return "latent_resize"
    tensorish_in = {t for t in in_types if not _is_scalar_kind(t) and t != "*"}
    if not tensorish_in and ({"MODEL", "CLIP", "VAE", "UPSCALE_MODEL", "CONTROL_NET"} & out_types):
        return "loader"
    # Only an input that names a LoRA counts, since a node carrying no more than
    # a lora_strength or lora_stack input loads none of its own.
    if "MODEL" in out_types and "MODEL" in in_types and any(
            k in ("lora_name", "lora") or (k.startswith("lora_") and k[5:].isdigit())
            for k in inputs):
        return "lora"
    if sig["output_node"] and ("STRING" in in_types or "*" in in_types):
        return "display"
    if sig["output_types"] and all(t == "*" for t in sig["output_types"]) and (
            not inputs or any(t == "*" for t in in_types)):
        return "switch"
    return "other"

# A pipe node is recognised by these words inside its lowercased class name. It
# names the pipe it continues CPipeAny and the values it carries any_1 upwards,
# and its output slot 0 is the pipe itself while slot k carries any_k.
PIPE_FROM_PATTERN = "pipe from any"
PIPE_TO_PATTERN = "pipe to/edit any"

# Separates a chain that ended with the slot never filled from a reference that
# was never part of a pipe.
SLOT_EMPTY = object()

def pipe_slot_source(prompt: dict, pipe_ref: Any, slot: int, max_hops: int = 12) -> Any:
    key = f"any_{slot}"
    ref = pipe_ref
    seen: set[str] = set()
    for _ in range(max_hops):
        if not (isinstance(ref, list) and len(ref) >= 1):
            return SLOT_EMPTY
        nid = str(ref[0])
        if nid in seen:
            return None
        seen.add(nid)
        node = prompt.get(nid)
        if not isinstance(node, dict):
            return SLOT_EMPTY
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return SLOT_EMPTY
        ct_l = str(node.get("class_type", "")).lower()
        if PIPE_TO_PATTERN in ct_l:
            v = inputs.get(key)
            if isinstance(v, list) and len(v) >= 1:
                return v
            ref = inputs.get("CPipeAny")
        elif PIPE_FROM_PATTERN in ct_l:
            ref = inputs.get("CPipeAny")
        else:
            return None
    return None

def demux_pipe_ref(prompt: dict, ref: Any, max_hops: int = 8) -> Any:
    for _ in range(max_hops):
        if not (isinstance(ref, list) and len(ref) >= 2):
            return ref
        node = prompt.get(str(ref[0]))
        if not isinstance(node, dict):
            return ref
        if PIPE_FROM_PATTERN not in str(node.get("class_type", "")).lower():
            return ref
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            return ref
        try:
            slot = int(ref[1])
        except (TypeError, ValueError):
            return ref
        if slot < 1:
            return ref
        got = pipe_slot_source(prompt, inputs.get("CPipeAny"), slot)
        if got is SLOT_EMPTY:
            return NO_VALUE
        if got is None:
            return ref
        ref = got
    return ref

def _resolve_context_field(prompt: dict, node_id: str, field_name: str,
                           registry: NodeRegistry, depth: int, visited: set):
    """A context node sets a field from its own input of the same name and
    inherits every field it does not set from the context it was built on.
    """
    if depth > 12:
        return UNRESOLVED
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return NO_VALUE
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        return NO_VALUE
    fl = field_name.lower()
    if fl in inputs:
        v = inputs[fl]
        if isinstance(v, list):
            return resolve_link(prompt, v, registry, depth + 1, visited)
        return v
    for bk in ("base_ctx", "ctx", "context"):
        bv = inputs.get(bk)
        if isinstance(bv, list) and len(bv) >= 1:
            base_node = prompt.get(str(bv[0]))
            if isinstance(base_node, dict) and registry.sig(base_node.get("class_type", "")) is None:
                return UNKNOWN
            return _resolve_context_field(prompt, bv[0], field_name, registry, depth + 1, visited)
    cands = [v for k, v in inputs.items()
             if k.lower().startswith("ctx") and isinstance(v, list) and len(v) >= 1]
    if cands:
        results = []
        for cv in cands:
            base_node = prompt.get(str(cv[0]))
            if isinstance(base_node, dict) and registry.sig(base_node.get("class_type", "")) is None:
                return UNKNOWN
            results.append(_resolve_context_field(
                prompt, cv[0], field_name, registry, depth + 1, set(visited or ())))
        if any(r is UNKNOWN for r in results):
            return UNKNOWN
        ct_kind = str(node.get("class_type", "")).lower()
        if "merge" in ct_kind:
            # A merge lays its later context over the earlier one, so the last
            # branch that holds the field wins.
            for r in reversed(results):
                if r is not NO_VALUE:
                    return r
            return NO_VALUE
        if "switch" in ct_kind:
            # Which branch a switch selected is not known here, so only a value
            # on the first branch can be reported.
            for i, r in enumerate(results):
                if r is not NO_VALUE:
                    if any(x is NO_VALUE for x in results[:i]):
                        return UNRESOLVED
                    return r
            return NO_VALUE
        vals = [r for r in results if r is not NO_VALUE]
        if not vals:
            return NO_VALUE
        if any(r is UNRESOLVED for r in vals):
            return UNRESOLVED
        if all(v == vals[0] for v in vals[1:]):
            return vals[0]
        return UNRESOLVED
    ct = str(node.get("class_type", ""))
    sig = registry.sig(ct)
    out_names = (sig or {}).get("output_names") or []
    if not (out_names and str(out_names[0]).upper() == "CONTEXT"):
        follow = None
        if classify(ct, sig) == "switch" or "switch" in ct.lower():
            follow = live_switch_branch(prompt, node, registry)
        else:
            linked = [v for v in inputs.values() if isinstance(v, list) and len(v) >= 1]
            if len(linked) == 1:
                follow = linked[0]
        if isinstance(follow, list) and len(follow) >= 1:
            nxt = prompt.get(str(follow[0]))
            if isinstance(nxt, dict) and registry.sig(nxt.get("class_type", "")) is None:
                return UNKNOWN
            return _resolve_context_field(prompt, follow[0], field_name, registry, depth + 1, visited)
        return UNRESOLVED
    return NO_VALUE

def _node_of(prompt: dict, ref: Any) -> tuple[dict | None, str, int]:
    if not (isinstance(ref, list) and len(ref) >= 1):
        return None, "", 0
    nid = str(ref[0])
    slot = ref[1] if len(ref) > 1 and isinstance(ref[1], int) else 0
    node = prompt.get(nid)
    return (node if isinstance(node, dict) else None), nid, slot

def _selector_switch_parts(sig: dict | None):
    if not sig or len(sig.get("output_types") or []) != 1:
        return None
    out_t = sig["output_types"][0]
    sels = [k for k, t in sig["inputs"].items() if t in ("BOOLEAN", "INT")]
    branches = [k for k, t in sig["inputs"].items()
                if k not in sels and (t == out_t or t == "*" or out_t == "*")]
    if len(sels) != 1 or len(branches) < 2:
        return None
    return sels[0], branches

def _selector_switch_choice(prompt: dict, node: dict, sig: dict | None,
                            registry: NodeRegistry, _depth: int = 0,
                            _visited: set | None = None):
    ct_l = str(node.get("class_type", "")).lower()
    if "switch" not in ct_l and "ifelse" not in ct_l and "if_else" not in ct_l:
        return None
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        return None
    parts = _selector_switch_parts(sig)
    if parts is None:
        sel = inputs.get("select")
        if isinstance(sel, (int, float)) and not isinstance(sel, bool):
            numbered = False
            for k, v in inputs.items():
                m = re.search(r"(\d+)\s*$", k)
                if not m:
                    continue
                numbered = True
                if int(m.group(1)) == int(sel):
                    if isinstance(v, list) and len(v) >= 1:
                        return ("ref", v)
                    if v is None:
                        return ("sentinel", NO_VALUE)
                    return ("value", v)
            if numbered:
                return ("sentinel", UNRESOLVED)
        return None
    sel_name, branch_names = parts
    sv = inputs.get(sel_name)
    if isinstance(sv, list):
        sv = resolve_link(prompt, sv, registry, _depth + 1, set(_visited or ()))
        if sv is UNKNOWN:
            return ("sentinel", UNKNOWN)
        if sv is UNRESOLVED or sv is NO_VALUE:
            return ("sentinel", UNRESOLVED)
    if isinstance(sv, bool):
        token = "true" if sv else "false"
        want = [b for b in branch_names if token in b.lower()]
    elif isinstance(sv, int):
        want = []
        for b in branch_names:
            m = re.search(r"(\d+)\s*$", b)
            if m and int(m.group(1)) == sv:
                want.append(b)
    else:
        return None
    if len(want) != 1:
        return None
    bv = inputs.get(want[0])
    if isinstance(bv, list):
        return ("ref", bv)
    if bv is None:
        return ("sentinel", NO_VALUE)
    return ("value", bv)

def resolve_link(prompt: dict, ref: Any, registry: NodeRegistry,
                 _depth: int = 0, _visited: set | None = None):
    if _depth > 10:
        return UNRESOLVED
    ref = demux_pipe_ref(prompt, ref)
    if ref is NO_VALUE:
        return NO_VALUE
    node, nid, slot = _node_of(prompt, ref)
    if node is None:
        return NO_VALUE
    _visited = _visited or set()
    # Keyed by slot as well, since two outputs of one node resolve separately.
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

    # A context read and a decided switch both run before the tensor check below,
    # since the inputs they follow are non-scalar by design.
    if (out_names_all and str(out_names_all[0]).upper() == "CONTEXT"
            and slot > 0 and out_name):
        return _resolve_context_field(prompt, nid, out_name, registry, _depth + 1, _visited)

    choice = _selector_switch_choice(prompt, node, sig, registry, _depth, _visited)
    if choice is not None:
        ckind, cval = choice
        if ckind == "ref":
            return resolve_link(prompt, cval, registry, _depth + 1, _visited)
        return cval

    # A node fed a tensor produces its output at run time, so no widget value on
    # it can stand for what it sent. A wildcard input says nothing about what it
    # carries and is left out of the check.
    tensor_connected = any(
        isinstance(v, list) and not _is_scalar_kind(in_kinds.get(k, "*")) and in_kinds.get(k, "*") != "*"
        for k, v in inputs.items()
    )
    if tensor_connected:
        return UNRESOLVED

    role = classify(ct, sig)

    if role == "switch":
        saw_unknown = saw_connected = False
        for k, v in inputs.items():
            if isinstance(v, list):
                saw_connected = True
                # Each branch walks with its own copy of the visited set, since
                # two branches meeting one upstream slot would read as a cycle.
                r = resolve_link(prompt, v, registry, _depth + 1, set(_visited))
                if r is NO_VALUE:
                    continue
                if r is UNKNOWN:
                    saw_unknown = True
                    continue
                if r is not UNRESOLVED and r is not None:
                    return r
                return UNKNOWN if saw_unknown else UNRESOLVED
        if saw_unknown:
            return UNKNOWN
        lits = [v for v in inputs.values()
                if isinstance(v, (int, float, str)) and not isinstance(v, bool)]
        if len(lits) == 1:
            return lits[0]
        return NO_VALUE if saw_connected else UNRESOLVED

    # Imported here because metadata imports this module at load time.
    from . import metadata as _md
    if _md._is_math_node(ct):
        # A math node's output is computed from its own inputs, so evaluating it
        # gives the value and the walk stops there.
        res = _md._eval_math_node(prompt, node)
        return res if res is not None else UNRESOLVED

    def _value_of(input_name: str):
        v = inputs.get(input_name)
        if isinstance(v, list):
            return resolve_link(prompt, v, registry, _depth + 1, _visited)
        return v

    lower_map = {k.lower(): k for k in inputs}
    match_key = None
    if out_name:
        if out_name in inputs:
            match_key = out_name
        elif out_name.lower() in lower_map:
            match_key = lower_map[out_name.lower()]
    if match_key is not None:
        # An input named like the output is the answer, so even a sentinel from
        # it is returned instead of falling through to a looser match.
        v = _value_of(match_key)
        if v is not None:
            return v

    if out_name:
        # Capped at the output name plus two characters, or an input sharing
        # only a first letter could pose as the value.
        pref = [k for k in inputs if k.lower().startswith(out_name.lower())
                and not k.lower().startswith("isfloat")
                and len(k) - len(out_name) <= 2]
        if pref:
            # A node offering both an integer and a float widget for one output
            # names the choice isfloat<output> and suffixes each widget i or f.
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
            if v not in (None, UNRESOLVED, UNKNOWN, NO_VALUE):
                return v

    if out_name.lower() in ("width", "height", "w", "h"):
        for v in inputs.values():
            if isinstance(v, str):
                m = _DIM_STRING_RE.search(v)
                if m:
                    return int(m.group(1 if out_name.lower() in ("width", "w") else 2))

    scalars = [(k, v) for k, v in inputs.items()
               if isinstance(v, (int, float, str, bool)) and not isinstance(v, dict)]
    scalars = [(k, v) for k, v in scalars
               if k.lower() not in ("control_after_generate", "autorefresh", "is_changed")]
    if len(scalars) == 1:
        v = scalars[0][1]
        if isinstance(v, str):
            m = _DIM_STRING_RE.search(v)
            if m and out_name.lower() in ("width", "height", "w", "h"):
                return int(m.group(1 if out_name.lower() in ("width", "w") else 2))
        return v

    links = [v for k, v in inputs.items() if isinstance(v, list)]
    if len(links) == 1 and not scalars:
        return resolve_link(prompt, links[0], registry, _depth + 1, _visited)

    return UNRESOLVED

def live_switch_branch(prompt: dict, node: Any, registry: NodeRegistry):
    # Every walk that meets a switch settles it here, so two walks over one
    # prompt cannot pick different branches.
    if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
        return None
    sig = registry.sig(str(node.get("class_type", "")))
    choice = _selector_switch_choice(prompt, node, sig, registry)
    if choice is not None:
        ckind, cval = choice
        return cval if ckind == "ref" else None
    first = None
    for v in node["inputs"].values():
        if isinstance(v, list) and len(v) >= 1:
            if first is None:
                first = v
            if resolve_link(prompt, v, registry) is not NO_VALUE:
                return v
    return first

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
    if sig is not None:
        return bool(sig["output_node"])
    # With no signature the class name is the only evidence.
    return bool(re.search(r"save|videocombine|preview", class_type, re.I)
                and not re.search(r"parameter|packer|unpacker|selector|loader|"
                                  r"generator|bridge|reroute|switch",
                                  class_type, re.I))

# A text display node writes no file, and whatever feeds it is live all the same.
def _is_display_node(class_type: str) -> bool:
    return bool(re.search(r"showtext|showany|showstring|displaytext|displayany|showlabel",
                          class_type, re.I))

def _reaches_output_node(prompt: dict, nid: str, consumers: dict[str, list[str]],
                         registry: NodeRegistry) -> tuple[bool, bool]:
    """Whether this node's output reaches an output node, and whether it got
    there through a switch that could route around it."""
    queue = [(nid, False)]
    seen: set[tuple[str, bool]] = set()
    found = ambiguous = False
    while queue:
        cur, amb = queue.pop(0)
        if (cur, amb) in seen:
            continue
        seen.add((cur, amb))
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

def _aspect_combo_size_node(node: Any) -> tuple[int, int] | None:
    """Read the size a selector node states in its own widgets, either as a
    WxH string or as megapixels with a ratio."""
    if not isinstance(node, dict):
        return None
    ct = str(node.get("class_type", "")).lower().replace(" ", "").replace("_", "")
    if "aspectratio" not in ct and "resolution" not in ct:
        return None
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        return None
    for v in inputs.values():
        if not isinstance(v, str):
            continue
        m = _DIM_STRING_RE.search(v)
        if m:
            w, h = int(m.group(1)), int(m.group(2))
            if str(inputs.get("swap_dimensions", "")).strip().lower() in (
                    "on", "yes", "true", "swap"):
                w, h = h, w
            return (w, h)
    mp = None
    for k, v in inputs.items():
        if "megapixel" in k.lower():
            try:
                mp = float(v)
            except (TypeError, ValueError):
                pass
            break
    ratio = None
    # Such a node carries a preset ratio and a custom one at once, and the
    # custom flag says which of the two is live.
    _custom = str(inputs.get("custom_ratio", "")).strip().lower() in ("true", "on", "yes")
    for k, v in inputs.items():
        if not isinstance(v, str) or "ratio" not in k.lower():
            continue
        if (k.lower().startswith("custom")) != _custom:
            continue
        m = re.search(r"(\d+)\s*:\s*(\d+)", v)
        if m:
            ratio = (int(m.group(1)), int(m.group(2)))
            break
    if not (mp and ratio and ratio[0] > 0 and ratio[1] > 0):
        return None
    div = 64
    for k, v in inputs.items():
        if "divisible" in k.lower():
            try:
                div = max(1, int(float(v)))
            except (TypeError, ValueError):
                pass
            break
    area = mp * 1_000_000
    w = round((area * ratio[0] / ratio[1]) ** 0.5 / div) * div
    h = round((area * ratio[1] / ratio[0]) ** 0.5 / div) * div
    if 16 <= w <= 16384 and 16 <= h <= 16384:
        return (w, h)
    return None

def _aspect_combo_size(prompt: dict, ref: Any) -> tuple[int, int] | None:
    node, _nid, _slot = _node_of(prompt, ref)
    return _aspect_combo_size_node(node)

def find_generation_resolution(prompt: dict, registry: NodeRegistry,
                               legacy_dim_fn=None) -> tuple[int, int] | None:
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
                    return latent_source(src_id, depth + 1, seen)
                if takes_pixels and not ("width" in s_inputs or "height" in s_inputs):
                    # A latent encoded from an image takes its size from that
                    # image, so this sampler carries no generation size.
                    return "img2img"
                if "width" in s_inputs or "height" in s_inputs:
                    return src_node
                if _aspect_combo_size_node(src_node):
                    return src_node
                return None
        return None

    reach = {s: _reaches_output_node(prompt, s, consumers, registry) for s in sampler_ids}
    unambiguous = [s for s in sampler_ids if reach[s][0] and not reach[s][1]]
    active = [s for s in sampler_ids if reach[s][0]]
    if active and not unambiguous:
        # Every sampler reaching an output does so through a switch that could
        # route around it, so no size is reported at all.
        return None
    # Only the samplers that reach an output unambiguously are tried, or every
    # sampler when none reaches one, so a workflow with no recognised output
    # node still reports a size.
    for sid in (unambiguous or active or sampler_ids):
        src = latent_source(sid)
        if src == "img2img":
            continue
        if isinstance(src, dict):
            inputs = src.get("inputs", {})
            wl, hl = inputs.get("width"), inputs.get("height")
            wv, hv = wl, hl
            if isinstance(wv, list):
                wv = resolve_dimension(prompt, wv, 0, registry, legacy_dim_fn)
            if isinstance(hv, list):
                hv = resolve_dimension(prompt, hv, 1, registry, legacy_dim_fn)
            def _dim_ok(v):
                try:
                    return 16 <= int(v) <= 16384
                except (TypeError, ValueError):
                    return False
            if not (_dim_ok(wv) and _dim_ok(hv)):
                combo = _aspect_combo_size_node(src)
                if not combo:
                    for lnk in (wl, hl):
                        if isinstance(lnk, list):
                            combo = _aspect_combo_size(prompt, lnk)
                            if combo:
                                break
                if combo:
                    wv, hv = combo
            try:
                wi, hi = int(wv), int(hv)
                if 16 <= wi <= 16384 and 16 <= hi <= 16384:
                    return wi, hi
            except (TypeError, ValueError):
                pass
            continue
    return None

# These node kinds can deliver a value without the prompt recording a link for it.
_BROADCAST_PATTERNS = ("anythingeverywhere", "useeverywhere", "everywhere",
                       "setnode", "getnode")

def has_implicit_links(prompt: dict, registry: NodeRegistry) -> bool:
    for nd in prompt.values():
        if not isinstance(nd, dict):
            continue
        ct = str(nd.get("class_type", "")).lower().replace(" ", "").replace("_", "")
        if any(b in ct for b in _BROADCAST_PATTERNS):
            return True
    return False

def dead_node_ids(prompt: dict, registry: NodeRegistry) -> set[str]:
    if has_implicit_links(prompt, registry):
        # Walking the recorded links would report live nodes as dead.
        return set()
    output_ids = [str(nid) for nid, nd in prompt.items()
                  if isinstance(nd, dict)
                  and (_is_output_like(nd.get("class_type", ""), registry.sig(nd.get("class_type", "")))
                       or _is_display_node(nd.get("class_type", "")))]
    if not output_ids:
        # With nothing to anchor reachability, nothing is called dead.
        return set()
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
    """Resolve a size link to an int, where axis 0 reads the width and 1 the
    height."""
    r = resolve_link(prompt, ref, registry)
    # The caller's own reader is consulted only for a class the registry does not
    # know, since any other answer here is already final.
    if r is UNKNOWN and legacy_fn is not None:
        return legacy_fn(ref, axis)
    if r in (UNRESOLVED, UNKNOWN, NO_VALUE) or isinstance(r, bool):
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
