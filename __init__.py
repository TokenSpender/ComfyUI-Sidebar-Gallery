from __future__ import annotations

WEB_DIRECTORY = "./web"

# Importing routes registers the HTTP routes on ComfyUI's server. A failure in
# either line reaches ComfyUI's loader, which logs it and marks the extension as
# failed to import.
from .server import routes as _routes
_routes.init()

# ComfyUI reports a package without this as skipped, and this one adds no nodes.
NODE_CLASS_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "WEB_DIRECTORY"]
