"""Pixel size of an image from its first bytes, with struct only.

The og:image is read up to 256 KiB; the size is decoded from the header:
PNG IHDR, JPEG SOFn markers (scan segments until SOF0..SOF15 except DHT/JPG/DAC),
GIF logical screen, WebP VP8 / VP8L / VP8X. Anything else, or a truncated
header, returns None: the caller records "tamaño no legible", never a guess.
"""

from __future__ import annotations

import struct
from dataclasses import dataclass

_PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# JPEG start-of-frame markers: C0..CF except C4 (DHT), C8 (JPG) and CC (DAC).
_JPEG_SOF = frozenset(range(0xC0, 0xD0)) - {0xC4, 0xC8, 0xCC}
# Markers without a length field.
_JPEG_STANDALONE = frozenset({0x01, 0xD8}) | frozenset(range(0xD0, 0xD8))


@dataclass(frozen=True)
class ImageInfo:
    format: str  # "png", "jpeg", "gif", "webp"
    width: int
    height: int


def _ok(fmt: str, width: int, height: int) -> ImageInfo | None:
    if width <= 0 or height <= 0:
        return None
    return ImageInfo(fmt, width, height)


def _jpeg(data: bytes) -> ImageInfo | None:
    i = 2
    n = len(data)
    while i < n:
        if data[i] != 0xFF:
            return None  # lost sync: not a marker where one must be
        while i < n and data[i] == 0xFF:  # fill bytes
            i += 1
        if i >= n:
            return None
        marker = data[i]
        i += 1
        if marker in _JPEG_STANDALONE:
            continue
        if marker in (0xD9, 0xDA):  # end of image, start of scan: no frame header first
            return None
        if i + 2 > n:
            return None
        (length,) = struct.unpack(">H", data[i : i + 2])
        if length < 2:
            return None
        if marker in _JPEG_SOF:
            if i + 7 > n:
                return None
            height, width = struct.unpack(">HH", data[i + 3 : i + 7])
            return _ok("jpeg", width, height)
        i += length
    return None


def _webp(data: bytes) -> ImageInfo | None:
    if len(data) < 16:
        return None
    chunk = data[12:16]
    if chunk == b"VP8X":
        if len(data) < 30:
            return None
        width = 1 + int.from_bytes(data[24:27], "little")
        height = 1 + int.from_bytes(data[27:30], "little")
        return _ok("webp", width, height)
    if chunk == b"VP8 ":
        if len(data) < 30 or data[23:26] != b"\x9d\x01\x2a":
            return None
        width = int.from_bytes(data[26:28], "little") & 0x3FFF
        height = int.from_bytes(data[28:30], "little") & 0x3FFF
        return _ok("webp", width, height)
    if chunk == b"VP8L":
        if len(data) < 25 or data[20] != 0x2F:
            return None
        bits = int.from_bytes(data[21:25], "little")
        width = (bits & 0x3FFF) + 1
        height = ((bits >> 14) & 0x3FFF) + 1
        return _ok("webp", width, height)
    return None


def image_info(data: bytes) -> ImageInfo | None:
    """Decode format and pixel size from ``data``; None when unknown or truncated."""
    if not data:
        return None
    data = bytes(data)
    try:
        if data.startswith(_PNG_SIGNATURE):
            if len(data) < 24 or data[12:16] != b"IHDR":
                return None
            width, height = struct.unpack(">II", data[16:24])
            return _ok("png", width, height)
        if data[:6] in (b"GIF87a", b"GIF89a"):
            if len(data) < 10:
                return None
            width, height = struct.unpack("<HH", data[6:10])
            return _ok("gif", width, height)
        if data.startswith(b"\xff\xd8"):
            return _jpeg(data)
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return _webp(data)
    except struct.error:
        return None
    return None
