"""
gemini_service.py — All Google Gemini AI interactions.

This module does two things:
1. Uploads the audio file to Gemini's File API (required for files > a few MB)
2. Calls Gemini with a detailed prompt and a structured response schema
   so the model returns well-formed JSON every time (not freeform text)

Why we use response_schema:
  Without a schema, Gemini returns free-form text that we'd need to regex-parse.
  With a schema (+ response_mime_type="application/json"), Gemini is constrained
  to return valid JSON matching exactly the structure we specify. Much more reliable.

Why we retry on 429s:
  Gemini's free tier has rate limits. If we hit one (HTTP 429), we wait briefly
  and try again rather than failing immediately. The tenacity library handles this.

Error recovery:
  If Gemini's JSON still can't be parsed, we return None and the caller
  marks the meeting as "failed" with a clear error message.
"""

import json
import logging
import tempfile
import os
import time

from google import genai
from google.genai import types
from tenacity import (
    retry,
    stop_after_attempt,
    wait_exponential,
    retry_if_exception_type,
)

from app.config import settings
from app.models.schemas import GeminiAnalysis

logger = logging.getLogger(__name__)

# ============================================================
# The prompt we send to Gemini along with the audio.
# Being very explicit about what to do (and not do) leads to
# much better, more consistent results.
# ============================================================
MEETING_ANALYSIS_PROMPT = """
You are a professional meeting analyst. You will receive an audio recording of a business meeting.

Your job is to:
1. Listen carefully to the entire recording
2. Extract a verbatim or near-verbatim transcript
3. Analyze the meeting and extract structured information

CRITICAL RULES — follow these exactly:
- NEVER invent, assume, or hallucinate any people, names, deadlines, decisions, or tasks not explicitly mentioned in the audio.
- If you cannot identify who is responsible for an action item, use exactly: "Not specified"
- If no deadline is mentioned for an action item, use exactly: "No deadline specified"
- If you cannot determine speaker identity reliably, label them generically: "Speaker 1", "Speaker 2", etc.
- If a section has nothing (e.g., no decisions were made), return an empty list [] for that field.
- Priority must be one of: "High", "Medium", "Low", or "Not specified" — nothing else.

Your response must be a JSON object matching exactly the schema provided. No extra commentary, no markdown fences.
"""


def _get_client() -> genai.Client:
    """Create a Gemini client using the API key from environment."""
    return genai.Client(api_key=settings.GEMINI_API_KEY)


def _strip_json_fences(text: str) -> str:
    """
    Strip markdown code fences if Gemini wraps JSON in them.
    Example input: ```json\n{...}\n```
    Output: {...}
    This is a fallback recovery step — with response_mime_type="application/json",
    this shouldn't happen, but it's defensive programming.
    """
    text = text.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        # Remove first line (```json or ```) and last line (```)
        lines = lines[1:] if lines[0].startswith("```") else lines
        lines = lines[:-1] if lines and lines[-1].strip() == "```" else lines
        text = "\n".join(lines)
    return text.strip()


def analyze_meeting_audio(audio_bytes: bytes, filename: str) -> tuple[str, dict]:
    """
    Main entry point: send audio to Gemini, get back transcript + analysis.

    Returns:
        (transcript: str, analysis: dict)
        analysis matches the GeminiAnalysis schema.

    Raises:
        ValueError: if the response can't be parsed after recovery attempts.
        Exception: for API errors that can't be retried.
    """
    client = _get_client()

    # Step 1: Upload the audio file to Gemini's File API.
    # We write to a temp file because the SDK's upload() accepts a file path.
    # The temp file is deleted right after upload.
    logger.info(f"Uploading audio to Gemini File API: {filename} ({len(audio_bytes)/1024:.1f} KB)")

    uploaded_file = None
    tmp_path = None

    try:
        # Write audio bytes to a temporary file
        suffix = "." + filename.rsplit(".", 1)[-1].lower() if "." in filename else ".mp3"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        # Upload to Gemini
        uploaded_file = client.files.upload(file=tmp_path)
        logger.info(f"Gemini file uploaded: {uploaded_file.name}, state: {uploaded_file.state}")

        # Wait for Gemini to finish processing the file (it becomes ACTIVE)
        # This usually takes a few seconds for audio files
        _wait_for_file_active(client, uploaded_file)

    finally:
        # Always clean up the temp file
        if tmp_path and os.path.exists(tmp_path):
            os.remove(tmp_path)

    # Step 2: Call generate_content with the audio + our prompt + response schema
    logger.info(f"Calling Gemini model: {settings.GEMINI_MODEL}")

    analysis_dict = _call_gemini_with_retry(client, uploaded_file)

    # Step 3: Extract transcript (stored separately from the structured analysis)
    # The transcript is inside the structured response or we request it alongside
    transcript = analysis_dict.pop("transcript", "") or ""

    # Step 4: Clean up the uploaded file from Gemini's File API
    try:
        client.files.delete(name=uploaded_file.name)
    except Exception as e:
        logger.warning(f"Could not delete Gemini file {uploaded_file.name}: {e}")

    return transcript, analysis_dict


def _wait_for_file_active(client: genai.Client, uploaded_file, max_wait_seconds: int = 60) -> None:
    """
    Poll until the uploaded file's state is ACTIVE.
    Gemini needs a moment to process the file before we can use it.
    """
    from google.genai.types import FileState
    start = time.time()
    while True:
        file_info = client.files.get(name=uploaded_file.name)
        if file_info.state == FileState.ACTIVE:
            logger.info(f"Gemini file is ACTIVE: {uploaded_file.name}")
            return
        if file_info.state == FileState.FAILED:
            raise ValueError(f"Gemini file processing failed for {uploaded_file.name}")
        if time.time() - start > max_wait_seconds:
            raise TimeoutError(f"Gemini file did not become ACTIVE within {max_wait_seconds}s")
        logger.debug("Waiting for Gemini file to become ACTIVE...")
        time.sleep(3)


@retry(
    # Retry up to 3 times on rate limit (429) or transient server errors (500, 503)
    retry=retry_if_exception_type(Exception),
    wait=wait_exponential(multiplier=2, min=4, max=30),
    stop=stop_after_attempt(3),
    reraise=True,
)
def _call_gemini_with_retry(client: genai.Client, uploaded_file) -> dict:
    """
    Call Gemini generate_content with retry on rate limit errors.
    Uses structured JSON output (response_schema) for reliable parsing.
    """
    # We ask Gemini for BOTH the transcript and the structured analysis in one call.
    # The schema includes all fields including a "transcript" field.
    full_schema = {
        "type": "object",
        "properties": {
            "transcript": {
                "type": "string",
                "description": "Verbatim or near-verbatim transcript of the entire meeting audio"
            },
            "summary": {
                "type": "string",
                "description": "A concise executive summary of the meeting (2-4 sentences)"
            },
            "key_points": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Main discussion points from the meeting"
            },
            "decisions": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Decisions that were made during the meeting"
            },
            "action_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "task": {"type": "string"},
                        "assignee": {"type": "string"},
                        "deadline": {"type": "string"},
                        "priority": {"type": "string"}
                    },
                    "required": ["task", "assignee", "deadline", "priority"]
                },
                "description": "Action items with owner, deadline, and priority"
            },
            "unresolved_issues": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Topics or issues that were raised but not resolved"
            },
            "important_topics": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Important topics or themes discussed in the meeting"
            }
        },
        "required": ["transcript", "summary", "key_points", "decisions",
                     "action_items", "unresolved_issues", "important_topics"]
    }

    response = client.models.generate_content(
        model=settings.GEMINI_MODEL,
        contents=[
            types.Part.from_uri(
                file_uri=uploaded_file.uri,
                mime_type=uploaded_file.mime_type or "audio/mpeg",
            ),
            MEETING_ANALYSIS_PROMPT,
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=full_schema,
        ),
    )

    raw_text = response.text or ""
    logger.info(f"Gemini response received ({len(raw_text)} chars)")

    # Parse the JSON response
    try:
        return json.loads(raw_text)
    except json.JSONDecodeError:
        # Recovery attempt: strip markdown fences and try again
        logger.warning("Gemini returned invalid JSON. Attempting recovery (strip fences)...")
        cleaned = _strip_json_fences(raw_text)
        try:
            return json.loads(cleaned)
        except json.JSONDecodeError as e:
            logger.error(f"Gemini JSON recovery failed. Raw response: {raw_text[:500]}")
            raise ValueError(f"Could not parse Gemini response as JSON: {e}")


TRANSCRIPT_ANALYSIS_PROMPT = """
You are a professional meeting analyst. You will receive the full transcript of a business meeting.

Your job is to:
1. Review the entire transcript carefully
2. Analyze the meeting content and extract structured information

CRITICAL RULES — follow these exactly:
- NEVER invent, assume, or hallucinate any people, names, deadlines, decisions, or tasks not explicitly mentioned in the text.
- If you cannot identify who is responsible for an action item, use exactly: "Not specified"
- If no deadline is mentioned for an action item, use exactly: "No deadline specified"
- If a section has nothing (e.g., no decisions were made), return an empty list [] for that field.
- Priority must be one of: "High", "Medium", "Low", or "Not specified" — nothing else.

Your response must be a JSON object matching exactly the schema provided. No extra commentary, no markdown fences.
"""


def analyze_meeting_transcript(transcript_text: str, title: Optional[str] = None) -> tuple[str, dict]:
    """
    Analyze a meeting from its text transcript (e.g. Zoom WebVTT transcript) with Gemini AI.
    Reuses the exact same structured schema, prompt rules, and Pydantic validation.

    Returns:
        (transcript: str, analysis: dict)
    """
    if not transcript_text or not transcript_text.strip():
        raise ValueError("Cannot analyze an empty meeting transcript.")

    client = _get_client()
    logger.info(f"Calling Gemini model for transcript analysis ({len(transcript_text)} chars): {settings.GEMINI_MODEL}")

    # Prompt with transcript
    title_prefix = f"Meeting Title: {title}\n\n" if title else ""
    full_prompt = f"{TRANSCRIPT_ANALYSIS_PROMPT}\n\n{title_prefix}--- TRANSCRIPT START ---\n{transcript_text}\n--- TRANSCRIPT END ---"

    schema = {
        "type": "object",
        "properties": {
            "summary": {
                "type": "string",
                "description": "A concise executive summary of the meeting (2-4 sentences)"
            },
            "key_points": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Main discussion points from the meeting"
            },
            "decisions": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Decisions that were made during the meeting"
            },
            "action_items": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "task": {"type": "string"},
                        "assignee": {"type": "string"},
                        "deadline": {"type": "string"},
                        "priority": {"type": "string"}
                    },
                    "required": ["task", "assignee", "deadline", "priority"]
                },
                "description": "Action items with owner, deadline, and priority"
            },
            "unresolved_issues": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Topics or issues that were raised but not resolved"
            },
            "important_topics": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Important topics or themes discussed in the meeting"
            }
        },
        "required": ["summary", "key_points", "decisions", "action_items", "unresolved_issues", "important_topics"]
    }

    @retry(
        retry=retry_if_exception_type(Exception),
        wait=wait_exponential(multiplier=2, min=4, max=30),
        stop=stop_after_attempt(3),
        reraise=True,
    )
    def _call_text_gemini():
        response = client.models.generate_content(
            model=settings.GEMINI_MODEL,
            contents=[full_prompt],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_schema=schema,
            ),
        )
        raw_text = response.text or ""
        try:
            return json.loads(raw_text)
        except json.JSONDecodeError:
            logger.warning("Gemini returned wrapped JSON. Attempting recovery...")
            cleaned = _strip_json_fences(raw_text)
            return json.loads(cleaned)

    analysis_dict = _call_text_gemini()
    return transcript_text, analysis_dict


def validate_analysis(raw_dict: dict) -> GeminiAnalysis:
    """
    Validate that Gemini's response matches our expected schema using Pydantic.
    If fields are missing or wrong type, Pydantic will raise a ValidationError.
    """
    return GeminiAnalysis(**raw_dict)
