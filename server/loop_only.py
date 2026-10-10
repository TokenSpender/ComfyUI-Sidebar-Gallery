from __future__ import annotations

import asyncio

# State declared loop-only carries no thread lock while scans and requests run
# on executor threads, so a touch from the wrong thread has to raise.
_bound_loop: asyncio.AbstractEventLoop | None = None

def bind_loop(loop: asyncio.AbstractEventLoop) -> None:
    global _bound_loop
    _bound_loop = loop

def assert_on_loop(name: str) -> None:
    if _bound_loop is None:
        raise RuntimeError(f"{name} is loop-only and was touched before the loop was bound")
    try:
        running = asyncio.get_running_loop()
    except RuntimeError:
        running = None
    if running is not _bound_loop:
        raise RuntimeError(f"{name} is loop-only and was touched off the event loop thread")
