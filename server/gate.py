from __future__ import annotations

import asyncio
from concurrent.futures import Executor
from typing import Any, Callable

async def run_gated(gate: asyncio.Semaphore, executor: Executor, fn: Callable[[], Any]) -> Any:
    """Holds one permit of `gate` until `fn` itself finishes, even when the
    caller stops waiting, since a cancelled wait cannot stop a thread already
    running."""
    await gate.acquire()
    loop = asyncio.get_running_loop()
    try:
        fut = loop.run_in_executor(executor, fn)
    except BaseException:
        gate.release()
        raise
    fut.add_done_callback(lambda _f: gate.release())
    return await asyncio.shield(fut)
