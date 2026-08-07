"""ComfyUI node-signature registry, structural classification, and the
pure-value link resolver.

This replaces the parser's name-pattern guessing with ComfyUI's own knowledge
of every installed node: input names/types, output names/types, category.

- NodeRegistry: live mode reads ComfyUI's NODE_CLASS_MAPPINGS in-process;
  snapshot mode loads an /object_info-shaped JSON snapshot so everything
  works without a live ComfyUI. Unknown classes
  return None and callers fall back to the legacy name heuristics.

- classify(): structural role of a node (sampler / text_encode / loader /
  lora / image_resize / latent_resize / interpolation / display / switch /
  zero_conditioning) derived from its I/O types instead of its name.

- resolve_link(): follow a [node_id, slot] reference to a concrete value.
  A value is only trusted if its producer is a PURE VALUE node, meaning all
  of its own connected inputs are scalars (recursively). Output slots are
  matched by their declared names (GetImageSize width/height, mxSlider2D X/Y,
  JPS width/height from a "WxH" combo string). Runtime-measured values (an
  IMAGE-fed producer) always yield UNRESOLVED rather than an unrelated
  upstream literal.
"""
from __future__ import annotations

import json
import math
import os
import re
from typing import Any

# Tensor-ish type names: a node with a CONNECTED input of one of these kinds
# computes its output at runtime, so its value is not in the file.
_SCALAR_TYPE_NAMES = {"INT", "FLOAT", "STRING", "BOOLEAN", "NUMBER", "COMBO"}

_DIM_STRING_RE = re.compile(r"(\d{2,5})\s*[x×]\s*(\d{2,5})")

# Sentinel: the chain crossed a node we have no signature for, so the caller
# should fall back to the legacy resolver (which handles unknown packs).
UNKNOWN = object()

# A link that provably carries NOTHING at run time: a context field with no
# override and no base to inherit from, or a reference to a node absent from
# the executed prompt. Distinct from UNRESOLVED, where a value flowed through
# the link but the file just does not store it. The split matters at
# switches: a NO_VALUE branch is skipped in favour of later ones, while an
# UNRESOLVED branch may have been the one that actually ran.
NO_VALUE = object()
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
        # an unknown class is just a cheap dict miss with no INPUT_TYPES() call.
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
    """The process-wide registry: live inside ComfyUI, otherwise a snapshot
    (named by the SBG_OBJECT_INFO_SNAPSHOT env var, with a local fixture
    fallback)."""
    global _live_registry
    if _live_registry is not None:
        return _live_registry
    snap = os.environ.get("SBG_OBJECT_INFO_SNAPSHOT")
    if not snap:
        try:
            import nodes  # noqa: F401 (running inside ComfyUI)
            _live_registry = NodeRegistry(None)
            return _live_registry
        except Exception:
            cand = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                                "tests", "fixtures", "object_info_snapshot.json")
            snap = cand if os.path.isfile(cand) else None
    if snap and os.path.isfile(snap):
        _live_registry = NodeRegistry.from_snapshot(snap)
    else:
        _live_registry = NodeRegistry({})  # nothing known: callers use legacy paths
    return _live_registry


def _is_scalar_kind(kind: str) -> bool:
    return kind in _SCALAR_TYPE_NAMES


# Structural classification

_SAMPLER_PARAM_NAMES = {"steps", "cfg", "seed", "noise_seed", "denoise", "sampler_name"}

# Name-only sampler test for UNKNOWN (uninstalled-pack) classes. This is the
# single source of truth shared by find_generation_resolution and metadata.py's
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
    # They are carriers rather than samplers, and must be classified as such
    # BEFORE the sampler test, which would otherwise fire on their LATENT output
    # + seed/steps/cfg inputs and yield a phantom sampler. resolve_link already treats CONTEXT
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
            "resolution", "longer_edge", "width", "height",
            "generation_width", "generation_height",
            "target_width", "target_height"} & set(inputs):
            return "image_resize"
    if "LATENT" in out_types and "LATENT" in in_types and (
            {"upscale_method", "scale_by", "width", "height"} & set(inputs)):
        return "latent_resize"
    # Loaders: no tensor inputs, produce model-ish objects.
    tensorish_in = {t for t in in_types if not _is_scalar_kind(t) and t != "*"}
    if not tensorish_in and ({"MODEL", "CLIP", "VAE", "UPSCALE_MODEL", "CONTROL_NET"} & out_types):
        return "loader"
    # A LoRA loader must have an input that SELECTS a LoRA (lora_name, lora,
    # or numbered lora_1/lora_01 slots). lora_strength / lora_stack / lora_list
    # alone must not qualify: IPAdapter FaceID loaders and stack appliers
    # carry those without being LoRA loaders themselves.
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


# Pure-value link resolution

# Crystools pipe nodes bundle arbitrary values: "Pipe to/edit any" packs
# any_1..any_N into a CPipeAny, and "Pipe from any" unpacks it, with output
# slot 0 the pipe itself and slot k carrying any_k. A ref into a pipe slot is
# demuxed to the bundled source ref before resolution, so every walk built
# on resolve_link sees through pipes identically.
PIPE_FROM_PATTERN = "pipe from any"
PIPE_TO_PATTERN = "pipe to/edit any"


# A pipe slot proven to carry nothing: the packer chain ends without ever
# packing it, the unpacker has no bundle, or the bundle's source was pruned
# from the executed prompt. Distinct from an inconclusive walk (unknown
# carrier class, a cycle, the hop cap), which stays fail-open.
SLOT_EMPTY = object()


def pipe_slot_source(prompt: dict, pipe_ref: Any, slot: int, max_hops: int = 12) -> Any:
    """Walk a CPipeAny chain upstream to the nearest to/edit pipe that
    connects any_<slot>, and return that bundled ref. Edit pipes override
    slots selectively, so the walk continues through CPipeAny while the slot
    is absent. Returns SLOT_EMPTY when the chain provably never packs the
    slot, and None when the walk is inconclusive."""
    key = f"any_{slot}"
    ref = pipe_ref
    seen: set[str] = set()
    for _ in range(max_hops):
        if not (isinstance(ref, list) and len(ref) >= 1):
            return SLOT_EMPTY  # chain ended without packing the slot
        nid = str(ref[0])
        if nid in seen:
            return None
        seen.add(nid)
        node = prompt.get(nid)
        if not isinstance(node, dict):
            return SLOT_EMPTY  # bundle source pruned from the executed prompt
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
            return None  # bundle from a class this walk cannot see through
    return None


def demux_pipe_ref(prompt: dict, ref: Any, max_hops: int = 8) -> Any:
    """Resolve a ref pointing into a "Pipe from any" output slot to the
    bundled source ref, repeating while the result is itself a pipe slot.
    Returns NO_VALUE for a slot the chain provably never packs. Refs that do
    not point into a pipe unpacker, and inconclusive walks, come back
    unchanged so callers stay fail-open."""
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
    """Resolve a named field out of an rgthree Context bundle.

    The field is set on this Context node directly (an override input) or
    inherited from the base context it extends (follow base_ctx upward).
    Returns the scalar value, NO_VALUE when the field is provably unset (no
    override and no base to inherit from), or UNRESOLVED when unprovable.
    """
    if depth > 12:
        return UNRESOLVED
    node = prompt.get(str(node_id))
    if not isinstance(node, dict):
        return NO_VALUE  # the carrier is absent from the executed prompt
    inputs = node.get("inputs", {})
    if not isinstance(inputs, dict):
        return NO_VALUE
    fl = field_name.lower()
    # Direct override on this context node.
    if fl in inputs:
        v = inputs[fl]
        if isinstance(v, list):
            return resolve_link(prompt, v, registry, depth + 1, visited)
        return v
    # Otherwise inherit from the base context. If the base is produced by a
    # class the registry doesn't know, return UNKNOWN rather than UNRESOLVED so
    # the caller falls back to the legacy resolver instead of silently giving up.
    for bk in ("base_ctx", "ctx", "context"):
        bv = inputs.get(bk)
        if isinstance(bv, list) and len(bv) >= 1:
            base_node = prompt.get(str(bv[0]))
            if isinstance(base_node, dict) and registry.sig(base_node.get("class_type", "")) is None:
                return UNKNOWN
            return _resolve_context_field(prompt, bv[0], field_name, registry, depth + 1, visited)
    # Context Switch and Context Merge carry candidate bundles on dynamic
    # ctx_NN inputs instead of a single base, and each kind decides its
    # winner differently at run time, so the field resolves per kind below.
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
            # A merge lets later bundles override earlier ones per field, so
            # the last candidate carrying the field wins outright.
            for r in reversed(results):
                if r is not NO_VALUE:
                    return r
            return NO_VALUE
        if "switch" in ct_kind:
            # A switch forwards its first non-empty BUNDLE, emitting its
            # field even when unset. A candidate whose field resolves proves
            # its bundle non-empty and wins; one preceded by a field-empty
            # candidate is unknowable, since that earlier bundle may carry
            # other fields.
            for i, r in enumerate(results):
                if r is not NO_VALUE:
                    if any(x is NO_VALUE for x in results[:i]):
                        return UNRESOLVED
                    return r
            return NO_VALUE
        # A carrier matching neither kind: settle only when every carrying
        # candidate agrees on one value.
        vals = [r for r in results if r is not NO_VALUE]
        if not vals:
            return NO_VALUE  # no candidate ever packs the field
        if any(r is UNRESOLVED for r in vals):
            return UNRESOLVED
        if all(v == vals[0] for v in vals[1:]):
            return vals[0]
        return UNRESOLVED  # the candidates disagree, so the winner is unknowable
    # A node that is not itself a context carrier can still relay the
    # bundle: a switch forwards its taken input, a passthrough its only
    # connection. NO_VALUE below is reserved for genuine carriers only, since
    # on any other class it would misread "unknown node" as proven emptiness
    # and make an enclosing switch skip the taken branch.
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
    # No override and no base context connected: the field is None at run time.
    return NO_VALUE


def _node_of(prompt: dict, ref: Any) -> tuple[dict | None, str, int]:
    if not (isinstance(ref, list) and len(ref) >= 1):
        return None, "", 0
    nid = str(ref[0])
    slot = ref[1] if len(ref) > 1 and isinstance(ref[1], int) else 0
    node = prompt.get(nid)
    return (node if isinstance(node, dict) else None), nid, slot


def _selector_switch_parts(sig: dict | None):
    """(selector_input, [branch_inputs]) when the signature shapes a
    selector-driven switch: a single output, exactly one BOOLEAN or INT
    input (the selector), and at least two branch inputs carrying the
    output's type. Returns None for every other shape, including the
    selector-less any-switches that pick by liveness."""
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
    """Decide a selector-driven switch's taken branch from the graph.

    Resolves the selector and maps it to the branch it names: boolean to the
    true/false branch, integer to the branch whose numeric suffix matches.
    Gated to switch-named classes so a node merely combining a flag with two
    same-typed inputs (a blend) is never treated as routing.

    Returns None when not a decidable selector switch (caller keeps its
    existing behavior). Otherwise a pair: ("ref", link) for a connected
    branch, ("value", literal) for a widget branch, or ("sentinel",
    UNRESOLVED | UNKNOWN | NO_VALUE) when undecidable or provably empty."""
    ct_l = str(node.get("class_type", "")).lower()
    if "switch" not in ct_l and "ifelse" not in ct_l and "if_else" not in ct_l:
        return None
    inputs = node.get("inputs")
    if not isinstance(inputs, dict):
        return None
    parts = _selector_switch_parts(sig)
    if parts is None:
        # parts is None both for known shapes the gate rejects (a trailing
        # help/debug output, an extra mode flag) and for unsignatured
        # classes; the numeric-suffix select widget still applies either way.
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
                        return ("sentinel", NO_VALUE)  # chosen slot unconnected
                    return ("value", v)
            if numbered:
                # Numbered branches exist but none carries the selected
                # number: the taken branch is unknowable from here.
                return ("sentinel", UNRESOLVED)
        return None
    sel_name, branch_names = parts
    sv = inputs.get(sel_name)
    if isinstance(sv, list):
        # The selector walks with its own copy of the visited set so its
        # path never makes the chosen branch's walk trip the cycle guard.
        sv = resolve_link(prompt, sv, registry, _depth + 1, set(_visited or ()))
        if sv is UNKNOWN:
            return ("sentinel", UNKNOWN)
        if sv is UNRESOLVED or sv is NO_VALUE:
            # The selection itself is not stored in the file (or the selector
            # link provably carries nothing); guessing a branch would report
            # a value the run may never have used.
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
        return None  # names do not disambiguate this selector value
    bv = inputs.get(want[0])
    if isinstance(bv, list):
        return ("ref", bv)
    if bv is None:
        return ("sentinel", NO_VALUE)  # chosen branch unconnected: nothing flows
    return ("value", bv)


def resolve_link(prompt: dict, ref: Any, registry: NodeRegistry,
                 _depth: int = 0, _visited: set | None = None):
    """Resolve [node_id, slot] to a scalar value, NO_VALUE, UNRESOLVED, or
    UNKNOWN.

    UNKNOWN means the chain crossed a class the registry doesn't know, and
    the caller should use the legacy resolver for this link. NO_VALUE means
    the link provably carries nothing at run time (see the sentinel's note);
    callers treating the result as a scalar handle it like UNRESOLVED.
    """
    if _depth > 10:
        return UNRESOLVED
    ref = demux_pipe_ref(prompt, ref)
    if ref is NO_VALUE:
        return NO_VALUE  # a pipe slot the chain provably never packs
    node, nid, slot = _node_of(prompt, ref)
    if node is None:
        # Node absent from the executed prompt: pruned before execution, so it produced nothing.
        return NO_VALUE
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

    # Context bundles (rgthree Context / Context Big) are passthrough carriers
    # with no runtime computation. Output slot N carries a named field (SEED,
    # STEPS, STEP_REFINER, CFG…); resolve that field through this node's own
    # input or, if absent, the base context it extends. Must run BEFORE the
    # purity gate (the base_ctx input is a non-scalar bundle type).
    if (out_names_all and str(out_names_all[0]).upper() == "CONTEXT"
            and slot > 0 and out_name):
        return _resolve_context_field(prompt, nid, out_name, registry, _depth + 1, _visited)

    # Selector-driven switches (an if/else or index switch): the selector
    # value designates the taken branch outright, so only it gets resolved.
    # Must run BEFORE the purity gate, since branch inputs carry non-scalar
    # types by design.
    choice = _selector_switch_choice(prompt, node, sig, registry, _depth, _visited)
    if choice is not None:
        ckind, cval = choice
        if ckind == "ref":
            return resolve_link(prompt, cval, registry, _depth + 1, _visited)
        return cval  # a widget literal on the chosen branch, or a sentinel

    # Purity: every CONNECTED input must be scalar-typed (or itself pure).
    # An IMAGE/LATENT/... input means the output is computed at runtime.
    tensor_connected = any(
        isinstance(v, list) and not _is_scalar_kind(in_kinds.get(k, "*")) and in_kinds.get(k, "*") != "*"
        for k, v in inputs.items()
    )
    if tensor_connected:
        return UNRESOLVED  # runtime-measured (GetImageSize and friends)

    role = classify(ct, sig)

    # Switches (rgthree Any Switch and friends): at run time the FIRST input
    # that carries a value wins; literal widget fallbacks are ignored. Skip
    # NO_VALUE branches and settle on the first live one, even if that leaves
    # the switch UNRESOLVED, rather than checking a later branch the run
    # never took. An unknown-class branch defers to the legacy resolver
    # unless a later live branch settles the value first.
    if role == "switch":
        saw_unknown = saw_connected = False
        for k, v in inputs.items():
            if isinstance(v, list):
                saw_connected = True
                # Each branch walks with its own copy of the visited set:
                # sibling branches converging on one upstream slot would
                # otherwise trip the cycle guard and read as live.
                r = resolve_link(prompt, v, registry, _depth + 1, set(_visited))
                if r is NO_VALUE:
                    continue  # provably empty branch: the switch skips it
                if r is UNKNOWN:
                    saw_unknown = True
                    continue
                if r is not UNRESOLVED and r is not None:
                    return r
                # Live branch's value isn't in the file. An earlier
                # unknown-pack branch may still be the taken one, so deferring
                # to the legacy resolver beats a blank answer.
                return UNKNOWN if saw_unknown else UNRESOLVED
        if saw_unknown:
            return UNKNOWN  # a branch crossed an unknown pack, so let legacy resolve
        # Every connected branch was provably empty, so the switch emits
        # nothing, but a lone literal widget still counts as its fallback
        # value. Exclude bools: a fallback carries a value rather than a
        # control flag, and a stray bool here would be wrong for a numeric
        # param.
        lits = [v for v in inputs.values()
                if isinstance(v, (int, float, str)) and not isinstance(v, bool)]
        if len(lits) == 1:
            return lits[0]
        return NO_VALUE if saw_connected else UNRESOLVED

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
    # slot, so return its value or propagate the UNRESOLVED/UNKNOWN sentinel
    # (both are real answers; falling through to a later strategy would risk
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

    # 2) prefixed inputs (mxSlider2D: output "X" is fed by inputs Xi/Xf + isfloatX).
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
            if v not in (None, UNRESOLVED, UNKNOWN, NO_VALUE):
                return v

    # 3) "WxH" combo string for width/height-named outputs (JPS, CR Aspect…).
    if out_name.lower() in ("width", "height", "w", "h"):
        for v in inputs.values():
            if isinstance(v, str):
                m = _DIM_STRING_RE.search(v)
                if m:
                    return int(m.group(1 if out_name.lower() in ("width", "w") else 2))

    # 4) a lone scalar widget is taken as the value (Primitive*, sliders, Seed…).
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


def live_switch_branch(prompt: dict, node: Any, registry: NodeRegistry):
    """The switch input link the run actually forwarded, or None.

    Any branch except one that provably carries nothing (NO_VALUE) counts as
    live; the first live branch wins. Falls back to the first connected
    input when every branch is empty, keeping callers fail-open. Single
    source of truth for switch branch selection, so other walks cannot drift
    from resolve_link's behaviour."""
    if not isinstance(node, dict) or not isinstance(node.get("inputs"), dict):
        return None
    sig = registry.sig(str(node.get("class_type", "")))
    choice = _selector_switch_choice(prompt, node, sig, registry)
    if choice is not None:
        ckind, cval = choice
        # A widget-literal branch, or an undecidable selector, leaves nothing to follow.
        return cval if ckind == "ref" else None
    first = None
    for v in node["inputs"].values():
        if isinstance(v, list) and len(v) >= 1:
            if first is None:
                first = v
            if resolve_link(prompt, v, registry) is not NO_VALUE:
                return v
    return first


# Pipeline model: generation resolution from the active sampler chain


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
    captured. It is still NOT a save output, so find_generation_resolution must not
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

    The `seen` set alone bounds the walk; there is deliberately NO depth cap,
    because one would falsely report a node many hops upstream of the save node
    as not reaching it, silently dropping its metadata on deep (video/upscale)
    graphs.
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


def _aspect_combo_size_node(node: Any) -> tuple[int, int] | None:
    """Dimensions stated by a size-selector node's own widgets.

    Two dialects. A combo spells the size out as text
    ("832 x 1216 (portrait)"), so the text is parsed, honouring a
    swap_dimensions widget. A FluxResolutionNode style selector states a
    megapixel area, an "A:B" ratio, and a rounding unit; each side is the
    square root of the area times its ratio share, rounded to the unit, which
    reproduces the node's own arithmetic. Both compute at runtime, so the
    link stays UNRESOLVED under pure-value rules even though the choice is
    written in the file."""
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
        m = re.search(r"(\d{2,5})\s*[x×]\s*(\d{2,5})", v)
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
    """The latent size entering the FIRST active sampler.

    Walks each sampler's latent chain upstream to its source (EmptyLatent*-
    style node or an image-to-video conditioner with width/height). Samplers
    whose output never reaches a save node are editing leftovers and are
    ignored. img2img sources (VAEEncode) and runtime-measured sizes yield
    None rather than a guess.
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
                    # another sampler or a latent op, so keep walking up
                    return latent_source(src_id, depth + 1, seen)
                if takes_pixels and not ("width" in s_inputs or "height" in s_inputs):
                    return "img2img"  # VAEEncode: the size is not in the file
                if "width" in s_inputs or "height" in s_inputs:
                    return src_node  # EmptyLatent* / WanImageToVideo-style creator
                if _aspect_combo_size_node(src_node):
                    # An aspect-ratio node emitting the empty latent itself:
                    # the size lives in its combo text rather than in inputs.
                    return src_node
                return None
        return None

    # Prefer samplers that actually flow into an output node; among them, the
    # one whose chain ends at a latent CREATOR (the first pass). When every
    # path to the output crosses a multi-branch runtime switch, which branch
    # produced the saved pixels is unknowable, so claim nothing.
    reach = {s: _reaches_output_node(prompt, s, consumers, registry) for s in sampler_ids}
    unambiguous = [s for s in sampler_ids if reach[s][0] and not reach[s][1]]
    active = [s for s in sampler_ids if reach[s][0]]
    if active and not unambiguous:
        return None
    for sid in (unambiguous or active or sampler_ids):
        src = latent_source(sid)
        if src == "img2img":
            continue  # this pass starts from a measured image, so try other samplers
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
                # Runtime-computed size: an aspect-ratio combo upstream (or the
                # creator itself) still states the chosen dimensions verbatim.
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
            continue  # creator found but size unresolvable here, so try other samplers
    return None


_BROADCAST_PATTERNS = ("anythingeverywhere", "useeverywhere", "everywhere",
                       "setnode", "getnode")


def has_implicit_links(prompt: dict, registry: NodeRegistry) -> bool:
    """True if the graph uses nodes that create connections NOT present as
    explicit input links: rgthree 'Anything Everywhere'/'Use Everywhere'
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
    """Node ids that take no part in producing the saved output: disconnected
    editing leftovers that should not appear in the metadata panel.

    Computed ONLY for graphs without implicit-link nodes, where reachability
    through explicit input links is exact. With broadcasts/Set-Get present the
    set is empty (conservative: a node that looks unconnected may be broadcast
    upstream, so keep it). A node is kept when it (transitively) feeds an
    output/save node OR is itself one (a ShowText/Preview the user placed).
    """
    if has_implicit_links(prompt, registry):
        return set()
    # Need at least one recognizable output/save node to anchor reachability;
    # without one (atypical graphs, odd exports) liveness can't be judged, so
    # keep everything rather than nuke the whole graph.
    output_ids = [str(nid) for nid, nd in prompt.items()
                  if isinstance(nd, dict)
                  and (_is_output_like(nd.get("class_type", ""), registry.sig(nd.get("class_type", "")))
                       or _is_display_node(nd.get("class_type", "")))]
    if not output_ids:
        return set()
    # A node is LIVE if it (transitively) feeds an output. ONE reverse walk from
    # the outputs to their producers marks every such node in O(N+E), replacing
    # a separate forward BFS per node (O(N·(N+E)), whose old depth cap also
    # dropped live nodes far upstream of the save node). dead = the rest.
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
