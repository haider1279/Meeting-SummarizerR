"""
supabase_service.py — All Supabase database and storage operations.

This file centralizes every interaction with Supabase so the router files
stay clean (they just call functions here instead of writing raw DB queries).

We use the service role key here, which bypasses RLS.
This is safe because:
1. We only call these functions after verifying the user's JWT in dependencies.py
2. Every query is manually scoped to user_id — so users can't access each other's data
3. RLS at the DB level is a second layer of protection
"""

import logging
import uuid
from typing import Optional

from supabase import create_client, ClientOptions

from app.config import settings

logger = logging.getLogger(__name__)


# The supabase-py storage sub-client uses httpx internally and defaults to a
# 20-second timeout (storage3.constants.DEFAULT_TIMEOUT = 20).  Large audio
# files (tens of megabytes) can take longer than 20 s to transfer to Supabase
# Storage, causing an httpx.ReadTimeout that propagates as a 500 error on the
# upload endpoint.  We override it with 120 s, matching the Axios timeout that
# is already configured on the frontend.
_STORAGE_UPLOAD_TIMEOUT_SECONDS = 120


def get_client():
    """Create and return a fresh Supabase client with an extended storage timeout."""
    options = ClientOptions(storage_client_timeout=_STORAGE_UPLOAD_TIMEOUT_SECONDS)
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY, options)


# ============================================================
# Storage operations
# ============================================================

def upload_audio_to_storage(file_bytes: bytes, user_id: str, filename: str) -> str:
    """
    Upload audio bytes to Supabase Storage under {user_id}/{uuid}-{filename}.
    Returns the storage path string.
    """
    supabase = get_client()
    # Create a unique filename to avoid collisions
    unique_id = str(uuid.uuid4())[:8]
    safe_filename = filename.replace(" ", "_")
    storage_path = f"{user_id}/{unique_id}-{safe_filename}"

    supabase.storage.from_("meeting-audio").upload(
        path=storage_path,
        file=file_bytes,
        file_options={"content-type": "audio/*"},
    )

    logger.info(f"Uploaded audio to storage: {storage_path}")
    return storage_path


def download_audio_from_storage(storage_path: str) -> bytes:
    """Download audio bytes from Supabase Storage."""
    supabase = get_client()
    response = supabase.storage.from_("meeting-audio").download(storage_path)
    return response


def delete_audio_from_storage(storage_path: str) -> None:
    """Delete an audio file from Supabase Storage."""
    supabase = get_client()
    try:
        supabase.storage.from_("meeting-audio").remove([storage_path])
        logger.info(f"Deleted audio from storage: {storage_path}")
    except Exception as e:
        # Log but don't crash — the DB row deletion still matters
        logger.error(f"Failed to delete audio from storage ({storage_path}): {e}")


# ============================================================
# Meeting operations
# ============================================================

def create_meeting(user_id: str, title: str, meeting_date: Optional[str],
                   participants: Optional[str], audio_file_path: Optional[str] = None,
                   source: str = "upload", zoom_meeting_uuid: Optional[str] = None) -> dict:
    """Insert a new meeting row and return it."""
    supabase = get_client()
    data = {
        "user_id": user_id,
        "title": title,
        "meeting_date": meeting_date,
        "participants": participants,
        "audio_file_path": audio_file_path,
        "source": source,
        "zoom_meeting_uuid": zoom_meeting_uuid,
        "status": "pending",
    }
    result = supabase.table("meetings").insert(data).execute()
    return result.data[0]


def get_meeting(meeting_id: str, user_id: str) -> Optional[dict]:
    """Fetch a single meeting by ID, scoped to the current user."""
    supabase = get_client()
    result = (
        supabase.table("meetings")
        .select("*")
        .eq("id", meeting_id)
        .eq("user_id", user_id)  # IMPORTANT: scope to user
        .single()
        .execute()
    )
    return result.data


def list_meetings(user_id: str, search: Optional[str] = None,
                  sort: str = "newest") -> list[dict]:
    """List all meetings for a user, with optional search and sort."""
    supabase = get_client()
    query = (
        supabase.table("meetings")
        .select("id, title, meeting_date, status, created_at, source")
        .eq("user_id", user_id)
    )

    if search:
        # Case-insensitive title search using Supabase's ilike filter
        query = query.ilike("title", f"%{search}%")

    if sort == "oldest":
        query = query.order("created_at", desc=False)
    else:
        query = query.order("created_at", desc=True)

    result = query.execute()
    return result.data or []


def update_meeting_status(meeting_id: str, status: str,
                           error_message: Optional[str] = None) -> None:
    """Update just the status (and optionally error_message) of a meeting."""
    supabase = get_client()
    data = {"status": status}
    if error_message is not None:
        data["error_message"] = error_message
    supabase.table("meetings").update(data).eq("id", meeting_id).execute()


def update_meeting_results(meeting_id: str, transcript: str, analysis: dict) -> None:
    """
    Save the Gemini analysis results to the meeting row.
    Called after successful AI processing.
    """
    supabase = get_client()
    data = {
        "status": "completed",
        "transcript": transcript,
        "summary": analysis.get("summary"),
        "key_points": analysis.get("key_points"),
        "decisions": analysis.get("decisions"),
        "unresolved_issues": analysis.get("unresolved_issues"),
        "important_topics": analysis.get("important_topics"),
        "error_message": None,  # Clear any previous error
    }
    supabase.table("meetings").update(data).eq("id", meeting_id).execute()


def update_meeting_fields(meeting_id: str, user_id: str, fields: dict) -> Optional[dict]:
    """
    Update user-editable meeting fields.
    Returns the updated row, or None if meeting not found.
    """
    supabase = get_client()
    result = (
        supabase.table("meetings")
        .update(fields)
        .eq("id", meeting_id)
        .eq("user_id", user_id)  # scope to user
        .execute()
    )
    if result.data:
        return result.data[0]
    return None


def delete_meeting(meeting_id: str, user_id: str) -> bool:
    """
    Delete a meeting row (cascades to action_items automatically via FK).
    Returns True if something was deleted, False if not found.
    """
    supabase = get_client()
    result = (
        supabase.table("meetings")
        .delete()
        .eq("id", meeting_id)
        .eq("user_id", user_id)
        .execute()
    )
    return len(result.data) > 0


def get_dashboard_stats(user_id: str) -> dict:
    """Get the counts needed for the dashboard summary cards."""
    supabase = get_client()

    # Count total meetings
    meetings_result = (
        supabase.table("meetings")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .execute()
    )
    total_meetings = meetings_result.count or 0

    # Count pending action items
    pending_result = (
        supabase.table("action_items")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .eq("status", "pending")
        .execute()
    )
    pending_count = pending_result.count or 0

    # Count completed action items
    completed_result = (
        supabase.table("action_items")
        .select("id", count="exact")
        .eq("user_id", user_id)
        .eq("status", "completed")
        .execute()
    )
    completed_count = completed_result.count or 0

    # Get 5 most recent meetings
    recent_result = (
        supabase.table("meetings")
        .select("id, title, meeting_date, status, created_at")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
        .limit(5)
        .execute()
    )

    return {
        "total_meetings": total_meetings,
        "pending_action_items": pending_count,
        "completed_action_items": completed_count,
        "recent_meetings": recent_result.data or [],
    }


# ============================================================
# Action item operations
# ============================================================

def create_action_items(meeting_id: str, user_id: str, items: list[dict]) -> None:
    """Bulk insert action items extracted from a meeting."""
    if not items:
        return
    supabase = get_client()
    rows = [
        {
            "meeting_id": meeting_id,
            "user_id": user_id,
            "task": item.get("task", ""),
            "assignee": item.get("assignee", "Not specified"),
            "deadline": item.get("deadline", "No deadline specified"),
            "priority": item.get("priority", "Not specified"),
            "status": "pending",
        }
        for item in items
    ]
    supabase.table("action_items").insert(rows).execute()


def list_action_items(user_id: str, meeting_id: Optional[str] = None,
                      status_filter: Optional[str] = None) -> list[dict]:
    """List action items for a user, optionally filtered by meeting or status."""
    supabase = get_client()
    # Join meeting title for display in the all-items view
    query = (
        supabase.table("action_items")
        .select("*, meetings(title)")
        .eq("user_id", user_id)
        .order("created_at", desc=True)
    )

    if meeting_id:
        query = query.eq("meeting_id", meeting_id)
    if status_filter:
        query = query.eq("status", status_filter)

    result = query.execute()
    items = result.data or []

    # Flatten the joined meeting title into each item
    for item in items:
        if item.get("meetings"):
            item["meeting_title"] = item["meetings"].get("title")
        else:
            item["meeting_title"] = None
        item.pop("meetings", None)  # Remove nested object

    return items


def get_action_item(item_id: str, user_id: str) -> Optional[dict]:
    """Fetch a single action item scoped to the current user."""
    supabase = get_client()
    result = (
        supabase.table("action_items")
        .select("*")
        .eq("id", item_id)
        .eq("user_id", user_id)
        .single()
        .execute()
    )
    return result.data


def update_action_item(item_id: str, user_id: str, fields: dict) -> Optional[dict]:
    """Update an action item. Returns the updated row or None."""
    supabase = get_client()
    result = (
        supabase.table("action_items")
        .update(fields)
        .eq("id", item_id)
        .eq("user_id", user_id)
        .execute()
    )
    if result.data:
        return result.data[0]
    return None


# ============================================================
# Zoom connection & integration operations
# ============================================================

def get_meeting_by_zoom_uuid(user_id: str, zoom_meeting_uuid: str) -> Optional[dict]:
    """Fetch an existing meeting by Zoom UUID for duplicate checking."""
    if not zoom_meeting_uuid:
        return None
    supabase = get_client()
    result = (
        supabase.table("meetings")
        .select("id, title, status, created_at, zoom_meeting_uuid")
        .eq("user_id", user_id)
        .eq("zoom_meeting_uuid", zoom_meeting_uuid)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def get_zoom_connection(user_id: str) -> Optional[dict]:
    """Fetch Zoom connection record for a user (scoped to user_id)."""
    supabase = get_client()
    result = (
        supabase.table("zoom_connections")
        .select("*")
        .eq("user_id", user_id)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def save_zoom_connection(
    user_id: str,
    zoom_user_id: str,
    zoom_email: Optional[str],
    encrypted_access_token: str,
    encrypted_refresh_token: str,
    expires_at: str,
    scopes: Optional[str] = None,
) -> dict:
    """
    Insert or update (upsert) a user's Zoom connection.
    Guarantees one Zoom connection row per user.
    """
    supabase = get_client()
    data = {
        "user_id": user_id,
        "zoom_user_id": zoom_user_id,
        "zoom_email": zoom_email,
        "encrypted_access_token": encrypted_access_token,
        "encrypted_refresh_token": encrypted_refresh_token,
        "expires_at": expires_at,
        "scopes": scopes,
        "status": "connected",
    }
    result = supabase.table("zoom_connections").upsert(data, on_conflict="user_id").execute()
    return result.data[0] if result.data else data


def update_zoom_tokens(
    user_id: str,
    encrypted_access_token: str,
    encrypted_refresh_token: str,
    expires_at: str,
) -> None:
    """Update refreshed Zoom tokens and expiry in database."""
    supabase = get_client()
    data = {
        "encrypted_access_token": encrypted_access_token,
        "encrypted_refresh_token": encrypted_refresh_token,
        "expires_at": expires_at,
        "status": "connected",
    }
    supabase.table("zoom_connections").update(data).eq("user_id", user_id).execute()


def update_zoom_connection_status(user_id: str, status: str) -> None:
    """Update Zoom connection status (e.g. 'needs_reconnect' or 'disconnected')."""
    supabase = get_client()
    supabase.table("zoom_connections").update({"status": status}).eq("user_id", user_id).execute()


def delete_zoom_connection(user_id: str) -> bool:
    """Delete a user's Zoom connection upon disconnect."""
    supabase = get_client()
    result = supabase.table("zoom_connections").delete().eq("user_id", user_id).execute()
    return len(result.data) > 0


def get_zoom_connection_by_zoom_user_id(zoom_user_id: str) -> Optional[dict]:
    """
    Find Zoom connection by Zoom's internal user ID.
    Used by Webhooks to map an incoming RTMS event to the appropriate Supabase user.
    """
    if not zoom_user_id:
        return None
    supabase = get_client()
    result = (
        supabase.table("zoom_connections")
        .select("*")
        .eq("zoom_user_id", zoom_user_id)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def find_zoom_connection_for_webhook(
    zoom_user_id: Optional[str] = None,
    zoom_email: Optional[str] = None,
) -> Optional[dict]:
    """
    Find Zoom connection for webhook mapping by zoom_user_id or zoom_email.
    If no direct match is found and there is exactly one connected Zoom user in the database,
    falls back to that user.
    """
    supabase = get_client()

    if zoom_user_id:
        res = (
            supabase.table("zoom_connections")
            .select("*")
            .eq("zoom_user_id", zoom_user_id)
            .eq("status", "connected")
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]

    if zoom_email:
        res = (
            supabase.table("zoom_connections")
            .select("*")
            .ilike("zoom_email", zoom_email.strip())
            .eq("status", "connected")
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]

    # Fallback: if single connected account exists
    res = (
        supabase.table("zoom_connections")
        .select("*")
        .eq("status", "connected")
        .limit(2)
        .execute()
    )
    if res.data and len(res.data) == 1:
        return res.data[0]

    return None



# ============================================================
# Live Zoom RTMS session & transcript operations
# ============================================================

def create_live_session(
    user_id: str,
    zoom_meeting_id: str,
    zoom_meeting_uuid: Optional[str] = None,
    rtms_stream_id: Optional[str] = None,
    title: str = "Live Zoom Meeting",
) -> dict:
    """Create a new live meeting session row."""
    supabase = get_client()
    data = {
        "user_id": user_id,
        "zoom_meeting_id": zoom_meeting_id,
        "zoom_meeting_uuid": zoom_meeting_uuid,
        "rtms_stream_id": rtms_stream_id,
        "title": title,
        "status": "waiting",
        "current_insights": {
            "key_points": [],
            "decisions": [],
            "action_items": [],
            "open_questions": [],
            "topics": [],
            "risks": [],
        },
    }
    result = supabase.table("live_meeting_sessions").insert(data).execute()
    return result.data[0]


def get_live_session(session_id: str, user_id: Optional[str] = None) -> Optional[dict]:
    """Fetch a live session by ID, optionally scoping to a specific user."""
    supabase = get_client()
    query = supabase.table("live_meeting_sessions").select("*").eq("id", session_id)
    if user_id:
        query = query.eq("user_id", user_id)
    result = query.limit(1).execute()
    return result.data[0] if result.data else None


def get_active_live_session(user_id: str) -> Optional[dict]:
    """
    Fetch the currently active (waiting, live, or processing) live meeting session for a user.
    """
    supabase = get_client()
    result = (
        supabase.table("live_meeting_sessions")
        .select("*")
        .eq("user_id", user_id)
        .in_("status", ["waiting", "live", "processing"])
        .order("created_at", desc=True)
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def find_live_session_by_zoom_info(
    zoom_meeting_id: Optional[str] = None,
    zoom_meeting_uuid: Optional[str] = None,
    rtms_stream_id: Optional[str] = None,
) -> Optional[dict]:
    """
    Find an active live session matching Zoom identifiers.
    """
    supabase = get_client()
    if zoom_meeting_uuid:
        res = (
            supabase.table("live_meeting_sessions")
            .select("*")
            .eq("zoom_meeting_uuid", zoom_meeting_uuid)
            .in_("status", ["waiting", "live", "processing"])
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]

    if rtms_stream_id:
        res = (
            supabase.table("live_meeting_sessions")
            .select("*")
            .eq("rtms_stream_id", rtms_stream_id)
            .in_("status", ["waiting", "live", "processing"])
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]

    if zoom_meeting_id:
        res = (
            supabase.table("live_meeting_sessions")
            .select("*")
            .eq("zoom_meeting_id", zoom_meeting_id)
            .in_("status", ["waiting", "live", "processing"])
            .order("created_at", desc=True)
            .limit(1)
            .execute()
        )
        if res.data:
            return res.data[0]

    return None


def update_live_session(session_id: str, fields: dict) -> Optional[dict]:
    """Update live session fields in database."""
    supabase = get_client()
    result = (
        supabase.table("live_meeting_sessions")
        .update(fields)
        .eq("id", session_id)
        .execute()
    )
    return result.data[0] if result.data else None


def save_transcript_chunk(
    session_id: str,
    speaker_id: Optional[str],
    speaker_name: str,
    text: str,
    start_time: Optional[str] = None,
    end_time: Optional[str] = None,
    language: Optional[str] = "en",
    sequence_number: Optional[int] = None,
    chunk_hash: Optional[str] = None,
) -> Optional[dict]:
    """
    Save a single transcript chunk with idempotency / duplicate check.
    """
    supabase = get_client()

    # Deduplication check if hash provided
    if chunk_hash:
        existing = (
            supabase.table("live_meeting_transcript_chunks")
            .select("id")
            .eq("session_id", session_id)
            .eq("chunk_hash", chunk_hash)
            .limit(1)
            .execute()
        )
        if existing.data:
            return existing.data[0]

    data = {
        "session_id": session_id,
        "speaker_id": speaker_id,
        "speaker_name": speaker_name or "Speaker",
        "text": text,
        "start_time": str(start_time) if start_time is not None else None,
        "end_time": str(end_time) if end_time is not None else None,
        "language": language,
        "sequence_number": sequence_number,
        "chunk_hash": chunk_hash,
    }
    result = supabase.table("live_meeting_transcript_chunks").insert(data).execute()
    return result.data[0] if result.data else None


def get_live_transcript_chunks(session_id: str) -> list[dict]:
    """Fetch all transcript chunks for a session ordered by creation / sequence."""
    supabase = get_client()
    result = (
        supabase.table("live_meeting_transcript_chunks")
        .select("*")
        .eq("session_id", session_id)
        .order("created_at", desc=False)
        .execute()
    )
    return result.data or []

