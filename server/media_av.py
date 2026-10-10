"""Opening a media file and reading its tags the same way on every PyAV."""

from __future__ import annotations

from typing import Any

# PyAV before 19 stops opening a file at the first tag that is not UTF-8
# unless it is told to replace the bytes.
_LENIENT_TAGS: dict[str, Any] = {"metadata_errors": "replace"}

def open_media(path: str) -> Any:
    import av

    try:
        return av.open(path, **_LENIENT_TAGS)
    except TypeError:
        # PyAV 19 dropped the argument, since it no longer fails on such a tag.
        return av.open(path)

def _clean(text: str) -> str:
    try:
        text.encode("utf-8")
        return text
    except UnicodeEncodeError:
        # PyAV 19 hands a byte that is not UTF-8 back as a lone surrogate, which
        # the index cannot store. This is the text older versions answer.
        return text.encode("utf-8", "surrogateescape").decode("utf-8", "replace")

def tags_of(holder: Any) -> dict[str, str]:
    """The tags of a container or of one stream."""
    return {_clean(k): _clean(v) for k, v in (holder.metadata or {}).items()}
