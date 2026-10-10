"""The media extension sets and the node text cap, kept in a module of their
own so the index and the parser share them without importing each other."""

from __future__ import annotations

IMAGE_EXTS = frozenset({".png", ".jpg", ".jpeg", ".webp"})
VIDEO_EXTS = frozenset({".mp4", ".webm", ".mov", ".mkv", ".avi"})
AUDIO_EXTS = frozenset({".mp3", ".flac", ".wav", ".ogg", ".opus", ".m4a"})
ALL_MEDIA_EXTS = IMAGE_EXTS | VIDEO_EXTS | AUDIO_EXTS

# Characters kept from a display node's text, since one can be wired to show
# text of any size.
NODE_TEXT_MAX = 4000

def kind_from_ext(ext: str) -> str:
    if ext in VIDEO_EXTS:
        return "video"
    if ext in AUDIO_EXTS:
        return "audio"
    return "image"
