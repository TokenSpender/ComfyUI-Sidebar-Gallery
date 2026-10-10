from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass

@dataclass(frozen=True)
class AllowedRoot:
    root_id: str
    label: str
    path: str

def extra_root_path(raw: str) -> str:
    """The path an extra folder is served from and its root id is taken from."""
    return os.path.normpath(os.path.expandvars(os.path.expanduser(raw.strip())))

def make_root_id(path: str) -> str:
    # Taken from the path alone, so a folder keeps its id across restarts. The
    # id is only a lookup key, so the digest carries no security requirement.
    h = hashlib.sha1(path.encode("utf-8", errors="ignore")).hexdigest()[:10]
    return f"extra_{h}"

# Windows drops a trailing dot or space from each part of a path, so "foo."
# opens the folder "foo". Other systems keep such a name as an entry of its own.
NAMES_FOLD = os.name == "nt"

def name_folds(name: str) -> bool:
    """Whether opening `name` would reach an entry under another name."""
    return NAMES_FOLD and name != "." and name.endswith((".", " "))

def safe_join(root_path: str, relpath: str) -> str:
    if not isinstance(relpath, str):
        raise ValueError("Invalid path")
    parts = relpath.replace("\\", "/").split("/")
    if relpath.startswith(("/", "\\")) or ".." in parts or any(name_folds(p) for p in parts):
        raise ValueError("Invalid path")

    root_abs = os.path.abspath(root_path)
    full = os.path.abspath(os.path.join(root_abs, relpath))
    if os.path.commonpath([full, root_abs]) != root_abs:
        raise ValueError("Path escapes root")

    # The text of the path stays inside the root, so this pass catches a link
    # inside the root that points out of it. Both sides are resolved so a root
    # that is itself a link stays valid, while the lexical path is returned.
    try:
        root_real = os.path.realpath(root_abs)
        full_real = os.path.realpath(full)
        within = os.path.commonpath([full_real, root_real]) == root_real
    except OSError:
        # Windows raises at a junction it holds untrusted, and the check above
        # already proved the path itself stays inside the root.
        within = True
    except ValueError:
        # commonpath refuses two paths on different drives, which is an escape.
        within = False
    if not within:
        raise ValueError("Path escapes root")
    return full
