"""Pure metadata search matching for Sidebar Gallery.

Extracted from routes.py so the matcher is decoupled from the aiohttp route
handler and can be unit-tested in isolation (routes.py pulls in aiohttp +
folder_paths and cannot be imported in a bare environment).

Pure stdlib so it imports anywhere, including environments without ComfyUI.
"""
from __future__ import annotations

from typing import Any


def _count_hits(haystack: str, needle: str) -> int:
    """Occurrences of needle in haystack; 1 for presence-only hits (empty
    needle, or a key-name match with no value hit) so bare-section searches
    don't count every character position."""
    if needle and needle in haystack:
        return haystack.count(needle)
    return 1


def match_item(s: dict | None, relpath: str, tags: list[dict], mode: str) -> list[dict] | None:
    """Evaluate every search tag against one item and combine them with AND/OR.

    ``s`` is the parsed metadata summary (None when the item has none),
    ``relpath`` the item's DB-relative path. Returns the matched-fields list
    for badge display, or None when the item does not match.

    A ``name`` tag matches the FILENAME only and must never reach
    match_summary: lora entries (and some node params) carry a literal
    "name" key, so a deep metadata match would hit lora names instead of
    filenames and break AND searches that combine name: with metadata tags.
    """
    file_matched_fields: list[dict] = []
    tag_checks: list[bool] = []

    for tag in tags:
        field = tag.get("field", "any").lower()
        value = tag.get("value", "").lower()
        is_exclude = tag.get("exclude", False)
        node_classes = tag.get("node_classes")

        if not value and field == "any" and not is_exclude:
            tag_checks.append(True)
            continue

        tag_matched_fields: list[dict] = []

        if field == "name":
            fname = relpath.replace("\\", "/").rsplit("/", 1)[-1].lower()
            if value in fname:
                tag_matched_fields = [{"field": "name", "count": fname.count(value) if value else 1}]
        elif s:
            tag_matched_fields = match_summary(s, field, value, node_classes)

        # Fallback string check against the path, so free-text searches also
        # hit the filename.
        if not tag_matched_fields and field == "any" and value and value in relpath.lower():
            tag_matched_fields = [{"field": "filename", "count": relpath.lower().count(value)}]

        if is_exclude:
            # Exclude tag: file passes if term is NOT found
            tag_checks.append(len(tag_matched_fields) == 0)
        else:
            if tag_matched_fields:
                file_matched_fields.extend(tag_matched_fields)
                tag_checks.append(True)
            else:
                tag_checks.append(False)

    is_match = all(tag_checks) if mode == "AND" else any(tag_checks)
    if not is_match:
        return None
    # Tags that were all empty or all excludes can pass with no concrete
    # field hits; report a generic match so the item still shows.
    return file_matched_fields or [{"field": "any", "count": 1}]


def match_summary(s: dict, field: str, value: str, node_classes: list | None = None) -> list[dict]:
    """Check if a summary dict matches a search query. Returns list of {field, count} for ALL matching fields.

    ``node_classes`` scopes a ``workflow_nodes`` search to nodes whose
    class_type or title is in the list. The frontend sends it when the typed
    field named a user-made layout section, so that section's own nodes are
    searched instead of the whole workflow.
    """
    results: list[dict] = []

    if field in ("model", "any"):
        m = s.get("model", "")
        models = list(m) if isinstance(m, list) else [m] if m else []
        # vae / clip_models live in the Models section and have no matcher of
        # their own; fold them in for a plain search so it can still find them
        # (both keys are skipped by the deep search via checked_keys). An
        # explicit "model:" search means the checkpoint or diffusion model, so
        # the other component files stay out of it.
        if field == "any":
            for extra_key in ("vae", "clip_models"):
                ev = s.get(extra_key)
                if isinstance(ev, list):
                    models.extend(ev)
                elif ev:
                    models.append(ev)
        count = sum(1 for model in models if value in str(model).lower())
        if count:
            results.append({"field": "model", "count": count})

    # vae: matches the main and the audio VAE (both are VAEs to the person
    # typing it).
    if field == "vae":
        vaes = [v for v in (s.get("vae"), s.get("audio_vae")) if v]
        count = sum(1 for v in vaes if value in str(v).lower())
        if count:
            results.append({"field": "vae", "count": count})

    if field == "clip":
        cm = s.get("clip_models")
        clips = list(cm) if isinstance(cm, list) else [cm] if cm else []
        tp = s.get("text_projection")
        clips.extend(tp if isinstance(tp, list) else [tp] if tp else [])
        count = sum(1 for c in clips if value in str(c).lower())
        if count:
            results.append({"field": "clip", "count": count})

    if field in ("lora", "any"):
        loras = s.get("loras", [])
        count = 0
        for l in (loras if isinstance(loras, list) else []):
            lname = l.get("name", "") if isinstance(l, dict) else str(l)
            if value in lname.lower():
                count += 1
        if count:
            results.append({"field": "lora", "count": count})

    if field in ("sampler", "any"):
        samplers = s.get("samplers", [])
        count = 0
        for samp in (samplers if isinstance(samplers, list) else []):
            sname = samp.get("sampler_name", "") if isinstance(samp, dict) else ""
            if value in sname.lower():
                count += 1
        sname_top = str(s.get("sampler_name", "")).lower()
        if sname_top and value in sname_top:
            count += 1
        if count:
            results.append({"field": "sampler", "count": count})

    if field in ("controlnet", "any"):
        cns = s.get("controlnet", [])
        count = 0
        for cn in (cns if isinstance(cns, list) else []):
            cname = cn.get("model", "") if isinstance(cn, dict) else str(cn)
            if value in cname.lower():
                count += 1
        if count:
            results.append({"field": "controlnet", "count": count})

    if field in ("prompt", "keyword", "any"):
        pos = str(s.get("positive_prompt", "")).lower()
        neg = str(s.get("negative_prompt", "")).lower()
        # Empty value = presence query (bare "prompt" section search).
        pos_count = pos.count(value) if value else (1 if pos else 0)
        neg_count = neg.count(value) if value else (1 if neg else 0)
        if pos_count:
            results.append({"field": "pos_prompt", "count": pos_count})
        if neg_count:
            results.append({"field": "neg_prompt", "count": neg_count})

    if field in ("app", "source_app", "any"):
        app = str(s.get("source_app", "")).lower()
        if value and value in app:
            results.append({"field": "app", "count": 1})

    # Section-scoped searches
    if field in ("mmaudio", "any"):
        mma = s.get("mmaudio")
        if isinstance(mma, dict):
            count = 0
            for k, v in mma.items():
                sv = str(v).lower()
                if value in k.lower() or value in sv:
                    count += _count_hits(sv, value)
            if count:
                results.append({"field": "mmaudio", "count": count})

    if field in ("sampling", "any"):
        samplers = s.get("samplers", [])
        if isinstance(samplers, list):
            for samp in samplers:
                if not isinstance(samp, dict):
                    continue
                for k, v in samp.items():
                    # In "any" mode, skip sampler_name: the sampler check above already covers it
                    if field == "any" and k == "sampler_name":
                        continue
                    sv = str(v).lower()
                    if value in k.lower() or value in sv:
                        results.append({"field": "sampling", "count": _count_hits(sv, value)})
                        break
        # Also check top-level sampling-related keys
        for tk in ("clip_skip", "shift", "sampling_type"):
            tv = s.get(tk)
            if tv is not None and value in str(tv).lower():
                results.append({"field": "sampling", "count": 1})

    if field in ("adetailer", "any"):
        ads = s.get("adetailer", [])
        if isinstance(ads, list):
            for ad in ads:
                if not isinstance(ad, dict):
                    continue
                count = 0
                for k, v in ad.items():
                    sv = str(v).lower()
                    if value in k.lower() or value in sv:
                        count += _count_hits(sv, value)
                if count:
                    results.append({"field": "adetailer", "count": count})

    if field in ("upscaling", "any"):
        ups = s.get("upscaling", [])
        if isinstance(ups, list):
            for up in ups:
                if not isinstance(up, dict):
                    continue
                count = 0
                for k, v in up.items():
                    sv = str(v).lower()
                    if value in k.lower() or value in sv:
                        count += _count_hits(sv, value)
                if count:
                    results.append({"field": "upscaling", "count": count})

    if field in ("interpolation", "any"):
        ips = s.get("interpolation", [])
        if isinstance(ips, list):
            for ip in ips:
                if not isinstance(ip, dict):
                    continue
                count = 0
                for k, v in ip.items():
                    sv = str(v).lower()
                    if value in k.lower() or value in sv:
                        count += _count_hits(sv, value)
                if count:
                    results.append({"field": "interpolation", "count": count})

    if field in ("fileinfo", "any"):
        # File info is stored at top-level: resolution, codec, fps, duration, etc.
        for fk in ("resolution", "codec", "fps", "total_frames", "duration", "duration_seconds"):
            fv = s.get(fk)
            if fv is not None and value in str(fv).lower():
                results.append({"field": "fileinfo", "count": 1})

    if field in ("extra", "any"):
        extra = s.get("extra", {})
        if isinstance(extra, dict):
            count = 0
            for k, v in extra.items():
                sv = str(v).lower()
                if value in k.lower() or value in sv:
                    count += _count_hits(sv, value)
            if count:
                results.append({"field": "extra", "count": count})

    if field in ("workflow_nodes", "any"):
        # Search ALL workflow nodes for a name or param key/value match, or
        # only the node_classes subset when the tag carries one.
        wanted = {str(c).lower() for c in node_classes} if node_classes else None
        nodes = s.get("workflow_nodes", [])
        if isinstance(nodes, list):
            for node in nodes:
                if not isinstance(node, dict):
                    continue
                if wanted is not None:
                    ct = str(node.get("class_type") or "").lower()
                    ti = str(node.get("title") or "").lower()
                    if ct not in wanted and ti not in wanted:
                        continue
                node_display = node.get("title") or node.get("class_type") or "Node"
                node_name_lower = node_display.lower()
                count = 0
                # Match against the node name itself (title / class_type)
                if value and value in node_name_lower:
                    count += 1
                # Also match against param keys and values
                params = node.get("params", {})
                if isinstance(params, dict):
                    for k, v in params.items():
                        sv = str(v).lower()
                        if value in k.lower() or value in sv:
                            count += _count_hits(sv, value)
                if count:
                    results.append({"field": node_display, "count": count})

    if field not in ("any", "app", "source_app", "model", "vae", "clip", "lora", "sampler", "controlnet", "prompt", "keyword", "pos_prompt", "neg_prompt",
                     "mmaudio", "sampling", "adetailer", "upscaling", "interpolation", "fileinfo", "extra", "workflow_nodes"):
        # Check if field matches a workflow node name. Match against BOTH class_type
        # and title (case-insensitively): the layout editor keys node paths by
        # class_type, but a node may carry a custom title, and either should match.
        nodes = s.get("workflow_nodes", [])
        if isinstance(nodes, list):
            clean_field = field.replace("workflow nodes::", "").strip().lower()
            for node in nodes:
                if not isinstance(node, dict): continue
                ct = str(node.get("class_type") or "").lower()
                title = str(node.get("title") or "").lower()
                if clean_field and (clean_field == ct or clean_field == title):
                    display_name = node.get("title") or node.get("class_type") or "Node"
                    if not value:
                        results.append({"field": display_name, "count": 1})
                    else:
                        params = node.get("params", {})
                        def _search_val(obj: Any) -> int:
                            m = 0
                            if isinstance(obj, dict):
                                for v in obj.values(): m += _search_val(v)
                            elif isinstance(obj, list):
                                for item in obj: m += _search_val(item)
                            elif value in str(obj).lower():
                                m += str(obj).lower().count(value)
                            return m
                        c = _search_val(params)
                        if c > 0:
                            results.append({"field": display_name, "count": c})

    # Top-level keys the specific matchers above already cover; the deep
    # search below skips them so an 'any' hit isn't counted twice. Every key
    # listed here MUST have a matcher, or 'any' searches silently miss it
    # (top-level keys with no matcher, e.g. legacy seed/steps/cfg/scheduler,
    # must stay OFF this list so the deep search reaches them).
    checked_keys = {"model", "vae", "clip_models",              # model matcher
                    "loras", "samplers", "sampler_name",        # lora/sampler matchers
                    "clip_skip", "shift", "sampling_type",      # sampling matcher
                    "source_app", "controlnet", "positive_prompt", "negative_prompt",
                    "workflow_nodes", "mmaudio", "adetailer", "upscaling", "interpolation", "extra",
                    "resolution", "codec", "fps", "total_frames", "duration", "duration_seconds"}

    # Deep recursive search (only for 'any' or unrecognized fields).
    # Skip when an unrecognized field was already matched as a workflow-node
    # name above, since running both could count the same hit twice.
    if field == "any" or (not results and field not in ("model", "vae", "clip", "lora", "sampler", "controlnet", "prompt", "keyword", "pos_prompt", "neg_prompt",
                                                        "app", "source_app", "mmaudio", "sampling", "adetailer", "upscaling", "interpolation",
                                                        "fileinfo", "extra", "workflow_nodes")):
        def _deep_search(obj: Any, is_root: bool = False) -> int:
            matches = 0
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if is_root and field == "any" and k in checked_keys:
                        continue  # a specific matcher above already handled this key
                    # The scalar mirrors initial_images[0] only in summaries
                    # that carry the list; skip it just then so a source
                    # filename is not counted twice. A pre-list summary has the
                    # scalar alone, and it must stay searchable.
                    if (is_root and field == "any" and k == "initial_image"
                            and "initial_images" in obj):
                        continue
                    val_str = str(v).lower()
                    if field == "any":
                        if value in k.lower() or value in val_str:
                            matches += _count_hits(val_str, value)
                    else:
                        if k.lower() == field.lower() and value in val_str:
                            matches += _count_hits(val_str, value)
                    matches += _deep_search(v)
            elif isinstance(obj, list):
                for item in obj:
                    matches += _deep_search(item)
            return matches

        deep_matches = _deep_search(s, is_root=True)
        if deep_matches > 0:
            results.append({"field": field, "count": deep_matches})

    # One badge per field: the per-entry section matchers append one result
    # per adetailer/upscaler/sampler entry, so counts merge here. Empty-value
    # searches are presence queries; pin their counts to 1.
    merged: dict[str, dict] = {}
    for r in results:
        prev = merged.get(r["field"])
        if prev is None:
            merged[r["field"]] = r
        else:
            prev["count"] += r["count"]
    if not value:
        for r in merged.values():
            r["count"] = 1
    return list(merged.values())
