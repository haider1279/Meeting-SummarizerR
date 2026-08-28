"""
stt_service.py — Speech-to-Text Integration for Google Meet Live Capture.

Transcribes WebM/Opus audio chunks sent from the browser tab capture.
Primary engine: Google Cloud Speech-to-Text v1 REST API (when GOOGLE_SPEECH_API_KEY is configured).
Fallback engine: Gemini Flash inline audio transcription via google-genai SDK (using GEMINI_API_KEY).

SECURITY:
  - API keys and tokens are NEVER logged under any circumstances.
"""

import base64
import json
import logging
from typing import Optional

import httpx
from google import genai
from google.genai import types

from app.config import settings

logger = logging.getLogger("stt_service")

# Google Speech-to-Text v1 synchronous REST endpoint
_STT_ENDPOINT = "https://speech.googleapis.com/v1/speech:recognize"

# Timeout for each STT call (5s audio chunk should transcribe in < 10s)
_STT_TIMEOUT_SECONDS = 15


def transcribe_audio_chunk(
    audio_bytes: bytes,
    mime_type: str = "audio/webm",
    language_code: str = "en-US",
    sample_rate_hertz: Optional[int] = None,
) -> str:
    """
    Transcribe a raw audio chunk into text.

    Tries Google Cloud Speech-to-Text v1 REST API first.
    If Google Cloud STT is unconfigured or returns 401/403 (e.g. AI Studio key),
    seamlessly falls back to Gemini Flash direct audio transcription.

    Args:
        audio_bytes:       Raw audio bytes from browser MediaRecorder.
        mime_type:         MIME type from browser ('audio/webm', 'audio/webm;codecs=opus', etc.).
        language_code:     BCP-47 language tag (default: 'en-US').
        sample_rate_hertz: Optional sample rate.

    Returns:
        Transcribed text string. Empty string on silence or unrecoverable error.
    """
    if not audio_bytes or len(audio_bytes) < 100:
        logger.debug("[STT] Audio chunk is empty or too small (<100 bytes). Skipping.")
        return ""

    encoding = _resolve_encoding(mime_type)
    explicit_stt_key = settings.is_google_stt_configured

    logger.info(
        f"[STT] STT request started | audio byte length: {len(audio_bytes)} | "
        f"encoding: {encoding} | sample rate: {sample_rate_hertz or 'auto'} | "
        f"language code: {language_code} | Google Speech API key configured: {'YES' if explicit_stt_key else 'NO'}"
    )

    # 1. Attempt Google Cloud Speech-to-Text v1 if key configured
    if settings.GOOGLE_SPEECH_API_KEY:
        transcript = _call_google_cloud_stt(
            audio_bytes=audio_bytes,
            encoding=encoding,
            language_code=language_code,
            sample_rate_hertz=sample_rate_hertz,
        )
        if transcript is not None:
            return transcript

    # 2. Fallback to Gemini Flash inline audio transcription
    logger.info("[STT] Utilizing Gemini audio transcription engine...")
    return _call_gemini_audio_stt(audio_bytes, mime_type)


def _call_google_cloud_stt(
    audio_bytes: bytes,
    encoding: str,
    language_code: str,
    sample_rate_hertz: Optional[int],
) -> Optional[str]:
    """
    Call Google Cloud Speech-to-Text v1 REST API.
    Returns transcript string on success, or None if fallback should be used.
    """
    api_key = settings.GOOGLE_SPEECH_API_KEY
    if not api_key:
        return None

    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    config: dict = {
        "encoding": encoding,
        "languageCode": language_code,
        "enableAutomaticPunctuation": True,
        "model": "default",
    }

    if sample_rate_hertz and encoding not in ("WEBM_OPUS", "OGG_OPUS"):
        config["sampleRateHertz"] = sample_rate_hertz

    payload = {
        "config": config,
        "audio": {
            "content": audio_b64,
        },
    }

    try:
        response = httpx.post(
            url=_STT_ENDPOINT,
            params={"key": api_key},
            json=payload,
            timeout=_STT_TIMEOUT_SECONDS,
        )

        status_code = response.status_code

        if status_code == 200:
            result = response.json()
            logger.info("[STT] HTTP 200 received from Google Cloud STT v1.")
            return _extract_transcript(result)

        err_body = response.text[:300] if response.text else "(empty)"
        if status_code == 400:
            logger.warning(
                f"[STT] STT ERROR 400: Invalid audio encoding or corrupt container. "
                f"Falling back to Gemini audio model. Details: {err_body}"
            )
        elif status_code in (401, 403):
            logger.warning(
                f"[STT] STT ERROR {status_code}: Google Cloud Speech API key rejected or Cloud Speech API not enabled. "
                f"Falling back to Gemini audio model."
            )
        elif status_code == 429:
            logger.warning(f"[STT] STT ERROR 429: Quota exceeded on Google Cloud STT. Falling back to Gemini.")
        elif status_code >= 500:
            logger.warning(f"[STT] STT ERROR {status_code}: Google Cloud STT server error. Falling back to Gemini.")
        else:
            logger.warning(f"[STT] STT ERROR {status_code}: {err_body}. Falling back to Gemini.")

        return None

    except httpx.TimeoutException:
        logger.warning(f"[STT] Google Speech-to-Text API request timed out (>{_STT_TIMEOUT_SECONDS}s). Falling back.")
        return None
    except Exception as e:
        logger.warning(f"[STT] Error calling Google Speech-to-Text API: {e}. Falling back.")
        return None


def _call_gemini_audio_stt(audio_bytes: bytes, mime_type: str) -> str:
    """
    Transcribe raw audio chunk using Gemini Flash inline audio capabilities.
    Works directly with GEMINI_API_KEY.
    """
    if not settings.GEMINI_API_KEY:
        logger.error("[STT] GEMINI_API_KEY is not configured. Cannot transcribe audio.")
        return ""

    clean_mime = mime_type.split(";")[0].strip() or "audio/webm"

    try:
        client = genai.Client(api_key=settings.GEMINI_API_KEY)
        prompt = (
            "You are a verbatim speech-to-text transcriber for a live meeting. "
            "Listen to this audio chunk and transcribe ONLY the exact spoken words in English with proper punctuation. "
            "If there is no clear human speech, or if the audio is only silence, breathing, background clicks, or noise, "
            "respond with EXACTLY: NO_SPEECH. "
            "Do NOT add any notes, speaker tags, timestamps, or markdown formatting."
        )

        response = client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=audio_bytes, mime_type=clean_mime),
                prompt,
            ],
        )

        text = (response.text or "").strip()
        if not text or "NO_SPEECH" in text.upper():
            logger.info("[STT] STT returned no transcript for audio chunk (silence or noise).")
            return ""

        # Strip any accidental wrapping quotes
        if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
            text = text[1:-1].strip()

        logger.info(f"[STT] Transcript chunk generated ({len(text)} chars): {text[:80]}...")
        return text

    except Exception as e:
        logger.error(f"[STT] Gemini audio transcription error: {e}")
        return ""


def _resolve_encoding(mime_type: str) -> str:
    """Map MIME type to Google STT v1 encoding string."""
    mt = mime_type.lower().split(";")[0].strip()
    mapping = {
        "audio/webm": "WEBM_OPUS",
        "audio/ogg": "OGG_OPUS",
        "audio/mp4": "MP3",
        "audio/mpeg": "MP3",
        "audio/wav": "LINEAR16",
        "audio/x-wav": "LINEAR16",
    }
    return mapping.get(mt, "WEBM_OPUS")


def _extract_transcript(result: dict) -> str:
    """Extract best transcript from Google STT v1 response structure."""
    results = result.get("results", [])
    if not results:
        logger.info("[STT] STT returned no transcript for audio chunk (silence or noise).")
        return ""

    parts = []
    for result_item in results:
        alternatives = result_item.get("alternatives", [])
        if alternatives:
            best = alternatives[0].get("transcript", "").strip()
            if best:
                parts.append(best)

    transcript = " ".join(parts).strip()
    if transcript:
        logger.info(f"[STT] Transcript chunk generated ({len(transcript)} chars): {transcript[:80]}...")
    else:
        logger.info("[STT] STT returned no transcript for audio chunk (silence or noise).")
    return transcript

