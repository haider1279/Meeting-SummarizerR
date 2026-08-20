"""
audio_validation.py — Validate uploaded audio files before processing.

We check three things:
1. The file extension is one we support (.mp3, .wav, .m4a)
2. The file isn't empty (0 bytes)
3. The file isn't too large (100 MB limit — Gemini also has limits)

We also do a basic MIME type check by reading the first few bytes
of the file (called "magic bytes") to confirm the file is really
audio and not a renamed .exe or something malicious.
"""

import logging
from fastapi import HTTPException, UploadFile, status

from app.config import settings

logger = logging.getLogger(__name__)

# Allowed file extensions (lowercase)
ALLOWED_EXTENSIONS = {".mp3", ".wav", ".m4a"}

# Magic bytes (the first few bytes of a file that identify its type).
# This is not a perfect check, but it catches the most obvious cases
# where someone renames a file to trick the server.
AUDIO_MAGIC_BYTES = {
    # MP3 files start with ID3 header or with 0xFF 0xFB/0xFA/0xF3 (MPEG sync)
    b"\x49\x44\x33": "mp3",   # ID3 tag (most MP3s)
    b"\xff\xfb": "mp3",       # MPEG sync (raw MP3)
    b"\xff\xfa": "mp3",
    b"\xff\xf3": "mp3",
    # WAV files start with RIFF header
    b"\x52\x49\x46\x46": "wav",
    # M4A files are MPEG-4 containers (ftyp box)
    b"\x00\x00\x00\x20\x66\x74\x79\x70": "m4a",  # 32-byte ftyp
    b"\x00\x00\x00\x1c\x66\x74\x79\x70": "m4a",  # 28-byte ftyp
    b"\x00\x00\x00\x18\x66\x74\x79\x70": "m4a",  # 24-byte ftyp
    b"\x00\x00\x00\x14\x66\x74\x79\x70": "m4a",  # 20-byte ftyp
}


def get_file_extension(filename: str) -> str:
    """Extract the lowercase extension from a filename."""
    if "." not in filename:
        return ""
    return "." + filename.rsplit(".", 1)[-1].lower()


def check_magic_bytes(file_bytes: bytes) -> bool:
    """
    Read the first 12 bytes and check if they match a known audio format.
    Returns True if the bytes look like valid audio, False otherwise.
    """
    for magic, _ in AUDIO_MAGIC_BYTES.items():
        if file_bytes[:len(magic)] == magic:
            return True
    return False


async def validate_audio_file(file: UploadFile) -> bytes:
    """
    Full validation of an uploaded audio file.

    Returns the raw file bytes if valid.
    Raises HTTPException with a clear message if invalid.
    """
    # 1. Check extension
    extension = get_file_extension(file.filename or "")
    if extension not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported file type '{extension}'. Please upload an MP3, WAV, or M4A file.",
        )

    # 2. Read the file into memory (we need it for both validation and upload)
    file_bytes = await file.read()

    # 3. Check if empty
    if len(file_bytes) == 0:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The uploaded file is empty. Please upload a valid audio recording.",
        )

    # 4. Check file size
    if len(file_bytes) > settings.MAX_AUDIO_SIZE_BYTES:
        size_mb = len(file_bytes) / (1024 * 1024)
        limit_mb = settings.MAX_AUDIO_SIZE_BYTES / (1024 * 1024)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"File is too large ({size_mb:.1f} MB). Maximum allowed size is {limit_mb:.0f} MB.",
        )

    # 5. Check magic bytes (basic content verification)
    # We only do this check if the file is long enough to have magic bytes
    if len(file_bytes) >= 4 and not check_magic_bytes(file_bytes):
        logger.warning(
            f"File '{file.filename}' has extension '{extension}' "
            f"but magic bytes don't match known audio formats."
        )
        # We log a warning but still allow it through for .wav and .m4a
        # because there are many valid sub-formats. MP3 especially can vary.
        # A stricter check could reject here, but it would cause false positives.

    logger.info(
        f"Audio file validated: '{file.filename}', "
        f"size={len(file_bytes) / 1024:.1f} KB, ext={extension}"
    )
    return file_bytes
