"""Statement images: decode an upload and save it again without its metadata.

A photo straight from a phone carries EXIF (GPS position, camera, time taken),
and editors add XMP, PNG text chunks and GIF/JPEG comments. Statement images
are served to every student, so ``strip_metadata`` re-encodes each upload with
Pillow and passes on only what affects how it looks: pixels, the ICC colour
profile, transparency, and animation timing. EXIF orientation is applied to the
pixels before the tag is dropped, so photos don't turn sideways. Decoding the
whole image is also a stronger check than the magic-byte sniff: a damaged or
truncated file is rejected here.

Re-encoding is kept as close to lossless as each format allows: JPEG reuses the
upload's own quantisation tables and chroma subsampling, PNG and GIF are
lossless, and WebP stays lossless when the upload was.

    from services.images import InvalidImage, strip_metadata

    try:
        clean = strip_metadata(data, "image/jpeg")
    except InvalidImage:
        ...  # 415
"""

from __future__ import annotations

import io
import struct
import warnings
from typing import Any, Optional

from PIL import Image as PilImage
from PIL import ImageOps, JpegImagePlugin

# Bounds the memory one upload can take while it is decoded: a 5 MB file can
# still describe a huge canvas (a decompression bomb). Animated images keep
# every frame in memory while they are written, so frames count towards the
# total. 40 MP is a 7700 x 5200 photo; 64 MP total is ~250 MB as RGBA.
MAX_PIXELS = 40_000_000
MAX_TOTAL_PIXELS = 64_000_000
MAX_FRAMES = 1000
WEBP_LOSSY_QUALITY = 90  # the upload's own quality is unknown; stay near-transparent

# The Pillow format names that may stand behind each sniffed MIME type. MPO is
# a phone JPEG with extra embedded pictures (each with its own EXIF); only the
# first one is kept.
_FORMATS = {
    "image/png": {"PNG"},
    "image/jpeg": {"JPEG", "MPO"},
    "image/gif": {"GIF"},
    "image/webp": {"WEBP"},
}


class InvalidImage(ValueError):
    """The upload could not be decoded, or decoding it would use too much memory."""


def strip_metadata(data: bytes, mime: str) -> bytes:
    """Return ``data`` re-encoded in the same format without metadata. Raises ``InvalidImage``."""
    try:
        with warnings.catch_warnings():
            # Pillow only warns between its own bomb limit and twice that
            warnings.simplefilter("error", PilImage.DecompressionBombWarning)
            with PilImage.open(io.BytesIO(data)) as im:
                return _reencode(im, data, mime)
    except InvalidImage:
        raise
    except (OSError, ValueError, SyntaxError, EOFError, struct.error, MemoryError,
            PilImage.DecompressionBombError, PilImage.DecompressionBombWarning) as exc:
        raise InvalidImage(str(exc)) from exc


def _reencode(im: PilImage.Image, data: bytes, mime: str) -> bytes:
    if im.format not in _FORMATS[mime]:
        raise InvalidImage(f"content is {im.format}, not {mime}")
    frames = getattr(im, "n_frames", 1) if mime != "image/jpeg" else 1
    width, height = im.size
    if width * height > MAX_PIXELS or frames > MAX_FRAMES or width * height * frames > MAX_TOTAL_PIXELS:
        raise InvalidImage("image is too large to process")

    animated = frames > 1
    # Rotating an animation would mean re-assembling every frame; orientation
    # tags on animations are rare enough to just drop
    source = im if animated else ImageOps.exif_transpose(im)
    options: dict[str, Any] = {}
    icc_profile: Optional[bytes] = im.info.get("icc_profile")
    if icc_profile:
        options["icc_profile"] = icc_profile

    if mime == "image/jpeg":
        options["qtables"] = im.quantization  # type: ignore[attr-defined]
        sampling = JpegImagePlugin.get_sampling(im)
        if sampling != -1:
            options["subsampling"] = sampling
        options["progressive"] = bool(im.info.get("progressive"))
        options["comment"] = b""  # the encoder copies the upload's comment otherwise
        fmt = "JPEG"
    elif mime == "image/png":
        # Text, time and EXIF chunks are written only when passed explicitly;
        # transparency is carried over by the encoder
        fmt = "PNG"
    elif mime == "image/gif":
        # Loop, duration, disposal, background and transparency come from the
        # frames' info; the comment would too
        options["comment"] = b""
        fmt = "GIF"
    else:
        # EXIF and XMP are written only when passed explicitly
        if _webp_is_lossless(data):
            options["lossless"] = True
        else:
            options["quality"] = WEBP_LOSSY_QUALITY
        if animated:
            # Unlike GIF and APNG, the WebP encoder reads one duration for all
            # frames and defaults the loop count to 0 (forever)
            options["loop"] = im.info.get("loop", 0)
            options["duration"] = _webp_durations(im)
        fmt = "WEBP"

    if animated:
        options["save_all"] = True
    out = io.BytesIO()
    source.save(out, format=fmt, **options)
    return out.getvalue()


def _webp_durations(im: PilImage.Image) -> list[int]:
    durations = []
    for index in range(im.n_frames):  # type: ignore[attr-defined]
        im.seek(index)
        im.load()  # a frame's duration is known only once it is decoded
        durations.append(int(im.info.get("duration", 0)))
    im.seek(0)
    return durations


def _webp_is_lossless(data: bytes) -> bool:
    """Whether the first frame of a WebP file is VP8L (lossless) rather than VP8."""
    pos = 12  # after "RIFF" <size> "WEBP"
    while pos + 8 <= len(data):
        fourcc = data[pos : pos + 4]
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        if fourcc == b"VP8L":
            return True
        if fourcc in (b"VP8 ", b"ALPH"):
            return False
        if fourcc == b"ANMF":
            # Frame header (16 bytes), then the frame's own ALPH/VP8/VP8L chunks
            return _webp_is_lossless(b"\0" * 12 + data[pos + 24 : pos + 8 + size])
        pos += 8 + size + (size & 1)
    return False
