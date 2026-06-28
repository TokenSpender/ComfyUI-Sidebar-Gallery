from __future__ import annotations

WEB_DIRECTORY = "./web"

# Importing routes registers the HTTP endpoints with PromptServer.
# (Wrapped so importing this package outside ComfyUI won't hard-fail.)
try:
    from .server import routes as _routes  # noqa: F401
except Exception:
    _routes = None

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]

