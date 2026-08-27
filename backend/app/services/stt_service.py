"""
stt_service.py — Google Cloud Speech-to-Text v1 REST API integration.

Converts raw WebM/Opus audio chunks (sent from the browser via MediaRecorder)
into text transcripts using Google's Speech-to-Text v1 API.

WHY v1 (not v2):
  - v1 is the stable, widely-documented API with the 60 min/month free tier.
  - v1 supports WEBM_OPUS encoding natively — matching exactly what Chrome's
    MediaRecorder produces by default.
  - v1 uses a simple REST POST with base64-encoded audio — no special SDK needed.

WHY NOT Gemini for live STT:
  - Gemini's generate_content API requires uploading a complete file through the
    Files API and waiting for it to become ACTIVE (3–8 second overhead per chunk).
  - That latency makes it unusable for live 5-second audio chunk transcription.
  - Gemini IS still used for incremental analysis / final meeting summarization.

AUDIO FORMAT:
  - Browser sends: audio/webm;codecs=opus (Chrome/Edge MediaRecorder default)
  - API receives: WEBM_OPUS encoding
  - Sample rate: auto-detected by the API (no need to specify for WEBM_OPUS)

FREE TIER:
  - Google Cloud Speech-to-Text v1: 60 minutes/month FREE on the standard model.
  - Beyond that: $0.006/minute (~$0.36/hour).

SETUP REQUIRED:
  - Enable "Cloud Speech-to-Text API" in Google Cloud Console.
  - Set GOOGLE_SPEECH_API_KEY in Render env vars (or it falls back to GEMINI_API_KEY).

SECURITY:
  - The API key is NEVER logged, even at DEBUG level.
"""

import base64
import json
import logging
from typing import Optional

import httpx

from app.config import settings

logger = logging.getLogger("stt_service")

# Google Speech-to-Text v1 synchronous REST endpoint
_STT_ENDPOINT = "https://speech.googleapis.com/v1/speech:recognize"

# Timeout for each STT call (5s audio chunk should transcribe in < 5s)
_STT_TIMEOUT_SECONDS = 20


def transcribe_audio_chunk(
    audio_bytes: bytes,
    mime_type: str = "audio/webm",
    language_code: str = "en-US",
    sample_rate_hertz: Optional[int] = None,
) -> str:
    """
    Transcribe a raw audio chunk using Google Cloud Speech-to-Text v1 REST API.

    Args:
        audio_bytes:       Raw audio bytes from browser MediaRecorder.
        mime_type:         MIME type from browser ('audio/webm' or 'audio/webm;codecs=opus').
        language_code:     BCP-47 language tag (default: 'en-US').
        sample_rate_hertz: Optional sample rate. If None, STT API auto-detects from WEBM header.

    Returns:
        Transcribed text string. Empty string on failure or silence.
    """
    if not audio_bytes:
        return ""

    api_key = settings.GOOGLE_SPEECH_API_KEY
    if not api_key:
        logger.warning("[STT] GOOGLE_SPEECH_API_KEY not configured. Cannot transcribe audio chunk.")
        return ""

    # Determine encoding from MIME type
    # Chrome MediaRecorder outputs audio/webm;codecs=opus by default
    encoding = _resolve_encoding(mime_type)

    # Build the request payload
    audio_b64 = base64.b64encode(audio_bytes).decode("utf-8")

    config: dict = {
        "encoding": encoding,
        "languageCode": language_code,
        "enableAutomaticPunctuation": True,
        "model": "default",
    }

    # Only set sample rate for encodings that require it
    # WEBM_OPUS does NOT require sample rate — API reads it from the container header
    if sample_rate_hertz and encoding != "WEBM_OPUS":
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
            params={"key": api_key},  # API key in query param — NOT logged below
            json=payload,
            timeout=_STT_TIMEOUT_SECONDS,
        )

        if response.status_code != 200:
            # Log status and error body — but never the URL (which has the API key)
            err_body = response.text[:300] if response.text else "(empty)"
            logger.error(
                f"[STT] Google Speech-to-Text API error {response.status_code}: {err_body}"
            )
            return ""

        result = response.json()
        return _extract_transcript(result)

    except httpx.TimeoutException:
        logger.warning("[STT] Google Speech-to-Text API request timed out.")
        return ""
    except Exception as e:
        logger.error(f"[STT] Unexpected error calling Google Speech-to-Text API: {e}")
        return ""


def _resolve_encoding(mime_type: str) -> str:
    """
    Map MIME type to Google STT v1 encoding string.

    Supported browser MediaRecorder outputs:
      audio/webm              → WEBM_OPUS
      audio/webm;codecs=opus  → WEBM_OPUS
      audio/ogg;codecs=opus   → OGG_OPUS
      audio/mp4               → MP3  (approximate)
    """
    mt = mime_type.lower().split(";")[0].strip()
    mapping = {
        "audio/webm": "WEBM_OPUS",
        "audio/ogg": "OGG_OPUS",
        "audio/mp4": "MP3",
        "audio/mpeg": "MP3",
        "audio/wav": "LINEAR16",
        "audio/x-wav": "LINEAR16",
    }
    encoding = mapping.get(mt, "WEBM_OPUS")
    logger.debug(f"[STT] MIME '{mime_type}' → encoding '{encoding}'")
    return encoding


def _extract_transcript(result: dict) -> str:
    """
    Extract the best transcript from Google STT v1 response structure.

    Response shape:
      {
        "results": [
          {
            "alternatives": [
              { "transcript": "...", "confidence": 0.95 }
            ]
          }
        ]
      }
    """
    results = result.get("results", [])
    if not results:
        logger.debug("[STT] No speech detected in audio chunk.")
        return ""

    parts = []
    for result_item in results:
        alternatives = result_item.get("alternatives", [])
        if alternatives:
            # Take the highest-confidence alternative (first by convention)
            best = alternatives[0].get("transcript", "").strip()
            if best:
                parts.append(best)

    transcript = " ".join(parts).strip()
    if transcript:
        logger.info(f"[STT] Transcript chunk generated ({len(transcript)} chars): {transcript[:80]}...")
    else:
        logger.debug("[STT] STT returned empty transcript (silence or noise).")
    return transcript
