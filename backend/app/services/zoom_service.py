"""
zoom_service.py — Zoom OAuth 2.0 and Cloud Recordings Integration Service.

Handles:
1. Symmetric token encryption at rest using Fernet (cryptography).
2. Cryptographic HMAC state signing and expiration validation for OAuth CSRF protection.
3. OAuth token exchange, automatic token refresh, and revocation.
4. Zoom REST API client (User profile, Cloud recordings list, Recording details & file download).
5. WebVTT subtitle/transcript cleaning into readable text for Gemini AI.
"""

import base64
import hashlib
import hmac
import json
import logging
import re
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Optional, Tuple, Dict, Any, List

import httpx
from cryptography.fernet import Fernet

from app.config import settings
from app.services import supabase_service

logger = logging.getLogger(__name__)

# Zoom API Base URLs
ZOOM_OAUTH_AUTHORIZE_URL = "https://zoom.us/oauth/authorize"
ZOOM_OAUTH_TOKEN_URL = "https://zoom.us/oauth/token"
ZOOM_OAUTH_REVOKE_URL = "https://zoom.us/oauth/revoke"
ZOOM_API_BASE_URL = "https://api.zoom.us/v2"


# ============================================================
# 1. Token Encryption & Decryption (Fernet)
# ============================================================

def _get_fernet() -> Fernet:
    """
    Get or derive a 32-byte URL-safe base64 key for Fernet.
    If ZOOM_TOKEN_ENCRYPTION_KEY is provided and valid, uses it.
    Otherwise derives a stable key deterministically from the backend secret key.
    """
    raw_key = settings.ZOOM_TOKEN_ENCRYPTION_KEY.strip() if settings.ZOOM_TOKEN_ENCRYPTION_KEY else ""
    if raw_key:
        try:
            return Fernet(raw_key.encode())
        except Exception:
            logger.warning("Invalid ZOOM_TOKEN_ENCRYPTION_KEY format. Falling back to derived secret key.")

    # Derive a 32-byte key using SHA-256 over STATE_SECRET_KEY
    derived = hashlib.sha256(settings.STATE_SECRET_KEY.encode()).digest()
    b64_key = base64.urlsafe_b64encode(derived)
    return Fernet(b64_key)


def encrypt_token(plain_token: str) -> str:
    """Encrypt a sensitive token for storage in the database."""
    if not plain_token:
        return ""
    f = _get_fernet()
    return f.encrypt(plain_token.encode()).decode()


def decrypt_token(encrypted_token: str) -> str:
    """Decrypt a stored token for backend API use."""
    if not encrypted_token:
        return ""
    f = _get_fernet()
    return f.decrypt(encrypted_token.encode()).decode()


# ============================================================
# 2. OAuth State Signing & Verification (CSRF Protection)
# ============================================================

def generate_oauth_state(user_id: str, expires_in_seconds: int = 600) -> str:
    """
    Generate a signed, short-lived OAuth state token containing user_id and expiry.
    Format: base64url(payload_json) + "." + base64url(hmac_signature)
    """
    payload = {
        "user_id": user_id,
        "exp": int(time.time()) + expires_in_seconds,
        "nonce": hashlib.sha256(f"{user_id}:{time.time()}".encode()).hexdigest()[:16],
    }
    payload_bytes = json.dumps(payload, separators=(',', ':')).encode()
    payload_b64 = base64.urlsafe_b64encode(payload_bytes).decode().rstrip("=")

    signature = hmac.new(
        settings.STATE_SECRET_KEY.encode(),
        payload_b64.encode(),
        hashlib.sha256
    ).digest()
    sig_b64 = base64.urlsafe_b64encode(signature).decode().rstrip("=")

    return f"{payload_b64}.{sig_b64}"


def verify_oauth_state(state: str) -> str:
    """
    Verify the signature and timestamp of an OAuth state token.
    Returns the verified user_id.
    Raises ValueError if state is invalid, tampered, or expired.
    """
    if not state or "." not in state:
        raise ValueError("Invalid OAuth state format.")

    payload_b64, sig_b64 = state.split(".", 1)

    # Verify HMAC signature
    expected_sig = hmac.new(
        settings.STATE_SECRET_KEY.encode(),
        payload_b64.encode(),
        hashlib.sha256
    ).digest()
    expected_sig_b64 = base64.urlsafe_b64encode(expected_sig).decode().rstrip("=")

    if not hmac.compare_digest(sig_b64, expected_sig_b64):
        raise ValueError("OAuth state signature verification failed.")

    # Decode payload
    try:
        padding = "=" * ((4 - len(payload_b64) % 4) % 4)
        payload_json = base64.urlsafe_b64decode((payload_b64 + padding).encode()).decode()
        payload = json.loads(payload_json)
    except Exception as e:
        raise ValueError(f"Failed to parse OAuth state payload: {e}")

    # Check expiration
    exp = payload.get("exp", 0)
    if time.time() > exp:
        raise ValueError("OAuth state has expired. Please try connecting again.")

    user_id = payload.get("user_id")
    if not user_id:
        raise ValueError("OAuth state is missing user identity.")

    return user_id


# ============================================================
# 3. Zoom OAuth Core Flow
# ============================================================

def get_basic_auth_header() -> str:
    """Create the Basic Auth header value for Zoom OAuth token requests."""
    credentials = f"{settings.ZOOM_CLIENT_ID}:{settings.ZOOM_CLIENT_SECRET}"
    encoded = base64.b64encode(credentials.encode()).decode()
    return f"Basic {encoded}"


def get_authorization_url(user_id: str) -> str:
    """Build the official Zoom OAuth authorization URL with signed state."""
    if not settings.is_zoom_configured:
        raise RuntimeError("Zoom integration is not configured. Please set ZOOM_CLIENT_ID and ZOOM_CLIENT_SECRET.")

    state = generate_oauth_state(user_id)
    params = {
        "response_type": "code",
        "client_id": settings.ZOOM_CLIENT_ID,
        "redirect_uri": settings.ZOOM_REDIRECT_URI,
        "state": state,
    }
    return f"{ZOOM_OAUTH_AUTHORIZE_URL}?{urllib.parse.urlencode(params)}"


async def exchange_code_for_tokens(code: str) -> Dict[str, Any]:
    """
    Exchange Zoom authorization code for access and refresh tokens.
    """
    if not settings.is_zoom_configured:
        raise RuntimeError("Zoom integration is not configured.")

    headers = {
        "Authorization": get_basic_auth_header(),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": settings.ZOOM_REDIRECT_URI,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(ZOOM_OAUTH_TOKEN_URL, headers=headers, data=data)

    if response.status_code != 200:
        logger.error(f"Zoom token exchange failed ({response.status_code}): {response.text}")
        raise ValueError("Failed to exchange authorization code with Zoom. Please check Zoom app configuration.")

    return response.json()


async def refresh_zoom_tokens(refresh_token: str) -> Dict[str, Any]:
    """
    Refresh an expired Zoom access token using the refresh token.
    """
    headers = {
        "Authorization": get_basic_auth_header(),
        "Content-Type": "application/x-www-form-urlencoded",
    }
    data = {
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(ZOOM_OAUTH_TOKEN_URL, headers=headers, data=data)

    if response.status_code != 200:
        logger.error(f"Zoom token refresh failed ({response.status_code}): {response.text}")
        raise ValueError("Zoom token refresh failed. User must reconnect their Zoom account.")

    return response.json()


async def get_valid_access_token(user_id: str) -> str:
    """
    Retrieve a valid decrypted Zoom access token for the given user.
    Automatically refreshes the token if it is expired or expiring within 5 minutes.
    """
    connection = supabase_service.get_zoom_connection(user_id)
    if not connection or connection.get("status") != "connected":
        raise ValueError("Zoom account is not connected. Please connect Zoom in Settings.")

    encrypted_access_token = connection.get("encrypted_access_token")
    encrypted_refresh_token = connection.get("encrypted_refresh_token")
    expires_at_str = connection.get("expires_at")

    if not encrypted_access_token or not expires_at_str:
        raise ValueError("Incomplete Zoom connection data. Please reconnect Zoom.")

    access_token = decrypt_token(encrypted_access_token)
    refresh_token = decrypt_token(encrypted_refresh_token)

    # Parse expiration time
    try:
        expires_at = datetime.fromisoformat(expires_at_str.replace("Z", "+00:00"))
    except Exception:
        expires_at = datetime.now(timezone.utc)

    # Check if token is expired or expiring in <= 5 minutes
    now_utc = datetime.now(timezone.utc)
    if expires_at <= now_utc + timedelta(minutes=5):
        logger.info(f"Zoom access token for user {user_id} is expired or expiring soon. Refreshing...")
        try:
            token_data = await refresh_zoom_tokens(refresh_token)
            new_access_token = token_data["access_token"]
            new_refresh_token = token_data.get("refresh_token", refresh_token)
            expires_in = token_data.get("expires_in", 3600)
            new_expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

            # Update encrypted tokens in Supabase
            supabase_service.update_zoom_tokens(
                user_id=user_id,
                encrypted_access_token=encrypt_token(new_access_token),
                encrypted_refresh_token=encrypt_token(new_refresh_token),
                expires_at=new_expires_at.isoformat(),
            )
            return new_access_token
        except Exception as e:
            logger.error(f"Error during Zoom token auto-refresh for user {user_id}: {e}")
            supabase_service.update_zoom_connection_status(user_id, "needs_reconnect")
            raise ValueError("Zoom authorization has expired. Please reconnect your Zoom account.")

    return access_token


async def revoke_zoom_token(user_id: str) -> bool:
    """
    Revoke Zoom access/refresh token and delete connection from database.
    """
    connection = supabase_service.get_zoom_connection(user_id)
    if not connection:
        return True

    try:
        encrypted_token = connection.get("encrypted_access_token")
        if encrypted_token and settings.is_zoom_configured:
            access_token = decrypt_token(encrypted_token)
            headers = {
                "Authorization": get_basic_auth_header(),
                "Content-Type": "application/x-www-form-urlencoded",
            }
            data = {"token": access_token}
            async with httpx.AsyncClient(timeout=15.0) as client:
                await client.post(ZOOM_OAUTH_REVOKE_URL, headers=headers, data=data)
    except Exception as e:
        logger.warning(f"Zoom token revocation request failed (continuing local disconnect): {e}")

    # Remove connection record from DB
    supabase_service.delete_zoom_connection(user_id)
    return True


async def fetch_zoom_user_profile(access_token: str) -> Dict[str, Any]:
    """Fetch current user's profile from Zoom API."""
    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.get(f"{ZOOM_API_BASE_URL}/users/me", headers=headers)

    if response.status_code != 200:
        logger.error(f"Failed to fetch Zoom user profile ({response.status_code}): {response.text}")
        raise ValueError("Could not retrieve Zoom user profile information.")

    return response.json()


# ============================================================
# 4. Zoom Cloud Recordings API
# ============================================================

def encode_meeting_uuid(meeting_uuid: str) -> str:
    """
    Properly double-encode a Zoom meeting UUID if required.
    Per Zoom documentation: If a meeting UUID begins with '/' or contains '//',
    it must be double URL-encoded when used in a path parameter.
    Double URL encoding is also safe for general UUID path parameters.
    """
    if meeting_uuid.startswith("/") or "//" in meeting_uuid:
        return urllib.parse.quote(urllib.parse.quote(meeting_uuid, safe=''), safe='')
    return urllib.parse.quote(meeting_uuid, safe='')


async def list_user_recordings(
    user_id: str,
    page_size: int = 30,
    next_page_token: Optional[str] = None,
    from_date: Optional[str] = None,
    to_date: Optional[str] = None,
) -> Dict[str, Any]:
    """
    List cloud recordings for the authenticated user's Zoom account.
    Enriches each recording with transcript availability, audio availability,
    and whether it has already been imported into Meeting Summarizer.
    """
    access_token = await get_valid_access_token(user_id)

    headers = {"Authorization": f"Bearer {access_token}"}
    params: Dict[str, Any] = {"page_size": min(page_size, 100)}

    if next_page_token:
        params["next_page_token"] = next_page_token
    if from_date:
        params["from"] = from_date
    if to_date:
        params["to"] = to_date

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{ZOOM_API_BASE_URL}/users/me/recordings",
            headers=headers,
            params=params,
        )

    if response.status_code == 401:
        supabase_service.update_zoom_connection_status(user_id, "needs_reconnect")
        raise ValueError("Zoom session expired. Please reconnect Zoom in Settings.")
    elif response.status_code != 200:
        logger.error(f"Zoom list recordings failed ({response.status_code}): {response.text}")
        raise ValueError(f"Failed to fetch Zoom recordings: {response.json().get('message', 'Unknown error')}")

    data = response.json()
    raw_meetings = data.get("meetings", [])

    # Normalize recordings for frontend
    normalized_meetings = []
    for m in raw_meetings:
        uuid = m.get("uuid", "")
        meeting_id = str(m.get("id", ""))
        topic = m.get("topic", "Untitled Zoom Meeting")
        start_time = m.get("start_time", "")
        duration = m.get("duration", 0)  # minutes
        recording_files = m.get("recording_files", [])

        # Check available files
        has_transcript = False
        has_audio = False
        for f in recording_files:
            file_type = (f.get("file_type") or "").upper()
            recording_type = (f.get("recording_type") or "").lower()
            file_extension = (f.get("file_extension") or "").upper()

            if file_type == "TRANSCRIPT" or "transcript" in recording_type or file_extension == "VTT":
                has_transcript = True
            elif file_type in ["AUDIO", "M4A"] or "audio" in recording_type:
                has_audio = True

        # Check if already imported
        existing_meeting = supabase_service.get_meeting_by_zoom_uuid(user_id, uuid)
        already_imported = existing_meeting is not None
        imported_meeting_id = existing_meeting["id"] if existing_meeting else None

        normalized_meetings.append({
            "uuid": uuid,
            "id": meeting_id,
            "topic": topic,
            "start_time": start_time,
            "duration": duration,
            "has_transcript": has_transcript,
            "has_audio": has_audio,
            "can_summarize": has_transcript or has_audio,
            "already_imported": already_imported,
            "imported_meeting_id": imported_meeting_id,
            "recording_count": len(recording_files),
        })

    return {
        "recordings": normalized_meetings,
        "next_page_token": data.get("next_page_token", ""),
        "total_records": data.get("total_records", len(normalized_meetings)),
        "from": data.get("from"),
        "to": data.get("to"),
    }


async def get_recording_files(user_id: str, meeting_uuid: str) -> Dict[str, Any]:
    """
    Fetch recording details and file list for a specific Zoom meeting UUID.
    """
    access_token = await get_valid_access_token(user_id)
    encoded_uuid = encode_meeting_uuid(meeting_uuid)

    headers = {"Authorization": f"Bearer {access_token}"}
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{ZOOM_API_BASE_URL}/meetings/{encoded_uuid}/recordings",
            headers=headers,
        )

    if response.status_code == 404:
        raise ValueError("Zoom recording not found. It may have been deleted from Zoom Cloud.")
    elif response.status_code != 200:
        logger.error(f"Failed to fetch Zoom recording details ({response.status_code}): {response.text}")
        raise ValueError("Failed to retrieve Zoom recording information.")

    return response.json()


async def download_recording_content(user_id: str, download_url: str) -> bytes:
    """
    Download a recording file (WebVTT transcript or audio) using the user's access token.
    Validates the host to prevent arbitrary SSRF attacks.
    """
    parsed_url = urllib.parse.urlparse(download_url)
    if not parsed_url.netloc.endswith("zoom.us"):
        raise ValueError("Security check failed: Invalid download host.")

    access_token = await get_valid_access_token(user_id)

    # Append access_token query param to download_url
    delimiter = "&" if "?" in download_url else "?"
    authenticated_url = f"{download_url}{delimiter}access_token={access_token}"

    headers = {
        "Authorization": f"Bearer {access_token}",
        "User-Agent": "Meeting-Summarizer-App",
    }

    async with httpx.AsyncClient(timeout=180.0, follow_redirects=True) as client:
        response = await client.get(authenticated_url, headers=headers)

    if response.status_code != 200:
        logger.error(f"Zoom file download failed ({response.status_code}): {response.text[:300]}")
        raise ValueError("Could not download recording file from Zoom.")

    return response.content


# ============================================================
# 5. WebVTT Transcript Parser & Cleaner
# ============================================================

def parse_webvtt_to_text(vtt_content: str) -> str:
    """
    Parse a WebVTT transcript file into clean, readable text.
    
    Removes:
    - WEBVTT headers and metadata (X-TIMESTAMP-MAP, NOTE, etc.)
    - Numeric cue identifiers (1, 2, 3...)
    - Timestamps (00:00:01.000 --> 00:00:04.500)
    - Formatting tags (<v Speaker Name>, </v>, <i>, </i>, etc.)
    
    Preserves:
    - Speaker attribution (e.g., "John Doe: Hello everyone")
    - Spoken conversation text
    - Deduplicates identical consecutive subtitle lines
    """
    if not vtt_content:
        return ""

    lines = vtt_content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    cleaned_dialogue: List[str] = []
    current_speaker: Optional[str] = None
    last_text: Optional[str] = None

    timestamp_pattern = re.compile(
        r'^\d{1,2}:?\d{2}:\d{2}[\.,]\d{3}\s*-->\s*\d{1,2}:?\d{2}:\d{2}[\.,]\d{3}'
    )
    cue_number_pattern = re.compile(r'^\d+$')
    voice_tag_pattern = re.compile(r'<v(?:\s+([^>]+))?>([^<]*)</v>')
    html_tag_pattern = re.compile(r'<[^>]+>')

    for line in lines:
        line_str = line.strip()

        # Skip empty lines
        if not line_str:
            continue

        # Skip WebVTT header lines and notes
        if (
            line_str.startswith("WEBVTT")
            or line_str.startswith("X-TIMESTAMP-MAP")
            or line_str.startswith("NOTE")
            or line_str.startswith("STYLE")
            or line_str.startswith("REGION")
        ):
            continue

        # Skip cue numbers and timestamps
        if cue_number_pattern.match(line_str) or timestamp_pattern.match(line_str):
            continue

        # Check for <v Speaker Name>Speech text</v> tags
        voice_matches = voice_tag_pattern.findall(line_str)
        if voice_matches:
            for speaker, text in voice_matches:
                speaker_clean = speaker.strip() if speaker else "Speaker"
                text_clean = html_tag_pattern.sub("", text).strip()
                if text_clean and text_clean != last_text:
                    cleaned_dialogue.append(f"{speaker_clean}: {text_clean}")
                    last_text = text_clean
            continue

        # Check for plain speaker tags like "Speaker Name: Speech text"
        clean_line = html_tag_pattern.sub("", line_str).strip()
        if not clean_line:
            continue

        # Avoid duplicate consecutive lines (frequent in scrolling subtitles)
        if clean_line == last_text:
            continue

        cleaned_dialogue.append(clean_line)
        last_text = clean_line

    return "\n".join(cleaned_dialogue).strip()
