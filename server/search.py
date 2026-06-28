"""Pure metadata search matching for Sidebar Gallery.

Extracted verbatim from routes.py so the matcher is decoupled from the aiohttp
route handler and can be unit-tested in isolation (routes.py pulls in aiohttp +
folder_paths and cannot be imported in a bare environment). Behaviour is
identical to the previous ``routes._match_summary`` — an AST comparison guards
the extraction, and tests/test_search.py characterises the behaviour.

Pure stdlib so it imports anywhere, including a test env without ComfyUI.
"""
from __future__ import annotations

from typing import Any


def match_summary(s: dict, field: str, value: str) -> list[dict]:
    """Check if a summary dict matches a search query. Returns list of {field, count} for ALL matching fields."""
    results: list[dict] = []

    if field in ("model", "any"):
        m = s.get("model", "")
        models = m if isinstance(m, list) else [m] if m else []
        count = sum(1 for model in models if value in str(model).lower())
        if count:
            results.append({"field": "model", "count": count})

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
        if value in str(s.get("sampler_name", "")).lower():
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
        pos_count = pos.count(value) if value else 0
        neg_count = neg.count(value) if value else 0
        if pos_count:
            results.append({"field": "pos_prompt", "count": pos_count})
        if neg_count:
            results.append({"field": "neg_prompt", "count": neg_count})

    if field in ("app", "source_app", "any"):
        app = str(s.get("source_app", "")).lower()
        if value and value in app:
            results.append({"field": "app", "count": 1})

    # ── Section-scoped searches ────────────────────────────────────
    if field in ("mmaudio", "any"):
        mma = s.get("mmaudio")
        if isinstance(mma, dict):
            count = 0
            for k, v in mma.items():
                sv = str(v).lower()
                if value in k.lower() or value in sv:
                    count += sv.count(value) if value in sv else 1
            if count:
                results.append({"field": "mmaudio", "count": count})

    if field in ("sampling", "any") and field != "sampler":
        samplers = s.get("samplers", [])
        if isinstance(samplers, list):
            for samp in samplers:
                if not isinstance(samp, dict):
                    continue
                for k, v in samp.items():
                    # In "any" mode, skip sampler_name — already covered by the sampler check above
                    if field == "any" and k == "sampler_name":
                        continue
                    sv = str(v).lower()
                    if value in k.lower() or value in sv:
                        results.append({"field": "sampling", "count": sv.count(value) if value in sv else 1})
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
                        count += sv.count(value) if value in sv else 1
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
                        count += sv.count(value) if value in sv else 1
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
                        count += sv.count(value) if value in sv else 1
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
                    count += sv.count(value) if value in sv else 1
            if count:
                results.append({"field": "extra", "count": count})

    if field in ("workflow_nodes", "any"):
        # Search ALL workflow nodes for a name or param key/value match
        nodes = s.get("workflow_nodes", [])
        if isinstance(nodes, list):
            for node in nodes:
                if not isinstance(node, dict):
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
                            count += sv.count(value) if value in sv else 1
                if count:
                    results.append({"field": node_display, "count": count})

    if field not in ("any", "app", "source_app", "model", "lora", "sampler", "controlnet", "prompt", "keyword", "pos_prompt", "neg_prompt",
                     "mmaudio", "sampling", "adetailer", "upscaling", "interpolation", "fileinfo", "extra", "workflow_nodes"):
        # Check if field matches a workflow node name. Match against BOTH class_type
        # and title (case-insensitively): the layout editor keys node paths by
        # class_type, but a node may carry a custom title — either should match.
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

    checked_keys = {"model", "loras", "samplers", "sampler_name", "scheduler", "steps", "cfg", "denoise", "seed", "clip_skip", "source_app", "controlnet", "positive_prompt", "negative_prompt", "workflow_nodes", "mmaudio", "adetailer", "upscaling", "interpolation", "extra",
                     "resolution", "codec", "fps", "total_frames", "duration", "duration_seconds", "vae", "model_hash", "clip_models", "shift", "sampling_type"}

    # Deep recursive search (only for 'any' or unrecognized fields).
    # Skip when an unrecognized field was already matched as a workflow-node
    # name above — running both could count the same hit twice.
    if field == "any" or (not results and field not in ("model", "lora", "sampler", "controlnet", "prompt", "keyword", "pos_prompt", "neg_prompt",
                                                        "app", "source_app", "mmaudio", "sampling", "adetailer", "upscaling", "interpolation",
                                                        "fileinfo", "extra", "workflow_nodes")):
        def _deep_search(obj: Any, is_root: bool = False) -> int:
            matches = 0
            if isinstance(obj, dict):
                for k, v in obj.items():
                    if is_root and field == "any" and k in checked_keys:
                        continue  # Already handled by specific matchers above — skip entirely
                    val_str = str(v).lower()
                    if field == "any":
                        if value in k.lower() or value in val_str:
                            matches += val_str.count(value) if value in val_str else 1
                    else:
                        if k.lower() == field.lower() and value in val_str:
                            matches += val_str.count(value)
                    matches += _deep_search(v)
            elif isinstance(obj, list):
                for item in obj:
                    matches += _deep_search(item)
            return matches

        deep_matches = _deep_search(s, is_root=True)
        if deep_matches > 0:
            results.append({"field": field, "count": deep_matches})

    return results
