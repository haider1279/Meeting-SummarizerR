"""
stt_service.py — Audio Transcription Service for Google Meet Live Capture using Gemini.

Transcribes raw audio chunks (WebM/Opus, Ogg, MP4, WAV) recorded from the browser tab
directly into text using the Google Gemini API (google-genai SDK) with GEMINI_API_KEY.

No Google Cloud project, Cloud Speech-to-Text API, or credit card required.
"""

import logging
from typing import Optional

from google import genai
from google.genai import types

from app.config import settings

logger = logging.getLogger("stt_service")

# Prompt given to Gemini for verbatim meeting transcription
_TRANSCRIPTION_PROMPT = (
    "You are an exact verbatim speech-to-text transcriber for a live meeting. "
    "Listen to this audio chunk and transcribe ONLY the exact spoken words in English with standard punctuation. "
    "If there is no clear human speech, or if the audio contains only silence, music, or background noise, "
    "respond with EXACTLY: NO_SPEECH. "
    "Do NOT summarize, do NOT add commentary, do NOT add speaker labels, and do NOT invent words."
)


def transcribe_audio_chunk(
    audio_bytes: bytes,
    mime_type: str = "audio/webm",
    language_code: str = "en-US",
    sample_rate_hertz: Optional[int] = None,
) -> str:
    """
    Transcribe a raw audio segment directly into text using Gemini.

    Args:
        audio_bytes:       Raw audio bytes from browser MediaRecorder.
        mime_type:         MIME type from browser ('audio/webm', 'audio/webm;codecs=opus', etc.).
        language_code:     BCP-47 language tag (default: 'en-US').
        sample_rate_hertz: Optional sample rate.

    Returns:
        Transcribed text string. Empty string on silence, noise, or error.
    """
    if not audio_bytes or len(audio_bytes) < 100:
        logger.debug("[STT] Audio chunk is empty or too small (<100 bytes). Skipping.")
        return ""

    if not settings.GEMINI_API_KEY:
        logger.error("[STT] GEMINI_API_KEY is not configured. Cannot transcribe audio.")
        return ""

    clean_mime = _normalize_mime_type(mime_type)

    logger.info(
        f"[STT] Transcribing audio chunk ({len(audio_bytes)} bytes, MIME={clean_mime}, model={settings.GEMINI_MODEL})..."
    )

    try:
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        response = client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type=clean_mime),
                _TRANSCRIPTION_PROMPT,
            ],
        )

        raw_text = (response.text or "").strip()

        if not raw_text or "NO_SPEECH" in raw_text.upper():
            logger.info("[STT] No speech detected in audio chunk (silence or noise).")
            return ""

        # Clean any surrounding quotes
        if (raw_text.startswith('"') and raw_text.endswith('"')) or (raw_text.startswith("'") and raw_text.endswith("'")):
            raw_text = raw_text[1:-1].strip()

        logger.info(f"[STT] Transcript generated ({len(raw_text)} chars): {raw_text[:80]}...")
        return raw_text

    except Exception as e:
        logger.error(f"[STT] Error during Gemini audio transcription: {e}")
        return ""


def _normalize_mime_type(mime_type: str) -> str:
    """
    Normalize browser MIME types for Gemini.
    Strips codec parameters e.g. 'audio/webm;codecs=opus' -> 'audio/webm'.
    """
    if not mime_type:
        return "audio/webm"
    base = mime_type.lower().split(";")[0].strip()
    valid_mimes = {
        "audio/webm": "audio/webm",
        "audio/ogg": "audio/ogg",
        "audio/mp4": "audio/mp4",
        "audio/mpeg": "audio/mpeg",
        "audio/mp3": "audio/mp3",
        "audio/wav": "audio/wav",
        "audio/x-wav": "audio/wav",
        "audio/aac": "audio/aac",
        "audio/flac": "audio/flac",
    }
    return valid_mimes.get(base, "audio/webm")
