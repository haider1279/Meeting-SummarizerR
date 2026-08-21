"""
zoom.py — FastAPI Router for Zoom OAuth and Cloud Recordings Integration.

Endpoints:
  GET   /api/zoom/connect                    Start OAuth flow, return auth URL
  GET   /api/zoom/callback                   OAuth redirect callback from Zoom
  GET   /api/zoom/status                     Check user's Zoom connection status
  POST  /api/zoom/disconnect                 Revoke & delete user's Zoom connection
  GET   /api/zoom/recordings                 List user's Zoom cloud recordings
  POST  /api/zoom/recordings/{uuid}/summarize Summarize selected Zoom recording
"""

import logging
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query, status
from fastapi.responses import RedirectResponse

from app.config import settings
from app.dependencies import get_current_user
from app.services import gemini_service, supabase_service, zoom_service

logger = logging.getLogger(__name__)

router = APIRouter(tags=["Zoom Integration"])


# ============================================================
# Background processing for Zoom meetings
# ============================================================

def _process_zoom_transcript_background(
    meeting_id: str,
    user_id: str,
    transcript_text: str,
    title: str,
) -> None:
    """
    Run Gemini transcript analysis in the background.
    Saves analysis results and action items into the database.
    """
    logger.info(f"Background transcript processing started for Zoom meeting {meeting_id}")
    try:
        supabase_service.update_meeting_status(meeting_id, "processing")

        # Analyze clean transcript text with Gemini
        transcript, analysis_dict = gemini_service.analyze_meeting_transcript(
            transcript_text=transcript_text,
            title=title,
        )

        validated = gemini_service.validate_analysis(analysis_dict)

        supabase_service.update_meeting_results(
            meeting_id=meeting_id,
            transcript=transcript,
            analysis=validated.model_dump(),
        )

        supabase_service.create_action_items(
            meeting_id=meeting_id,
            user_id=user_id,
            items=[item.model_dump() for item in validated.action_items],
        )

        logger.info(f"Zoom meeting {meeting_id} transcript processing completed successfully")

    except Exception as e:
        logger.error(f"Zoom meeting {meeting_id} processing failed: {e}", exc_info=True)
        error_msg = str(e)
        if "rate" in error_msg.lower() or "429" in error_msg:
            user_msg = "AI processing rate limit reached. Please try again in a few minutes."
        elif "json" in error_msg.lower() or "parse" in error_msg.lower():
            user_msg = "AI returned an unexpected response format. Please try reprocessing."
        else:
            user_msg = "Processing failed. Please try again or contact support."

        supabase_service.update_meeting_status(meeting_id, "failed", user_msg)


def _process_zoom_audio_background(
    meeting_id: str,
    user_id: str,
    audio_bytes: bytes,
    filename: str,
) -> None:
    """
    Run Gemini audio analysis in the background when only audio is available from Zoom.
    """
    logger.info(f"Background audio processing started for Zoom meeting {meeting_id}")
    try:
        supabase_service.update_meeting_status(meeting_id, "processing")

        transcript, analysis_dict = gemini_service.analyze_meeting_audio(audio_bytes, filename)
        validated = gemini_service.validate_analysis(analysis_dict)

        supabase_service.update_meeting_results(
            meeting_id=meeting_id,
            transcript=transcript,
            analysis=validated.model_dump(),
        )

        supabase_service.create_action_items(
            meeting_id=meeting_id,
            user_id=user_id,
            items=[item.model_dump() for item in validated.action_items],
        )

        logger.info(f"Zoom audio meeting {meeting_id} processing completed successfully")

    except Exception as e:
        logger.error(f"Zoom audio meeting {meeting_id} processing failed: {e}", exc_info=True)
        user_msg = "AI processing encountered an error while analyzing the Zoom audio."
        supabase_service.update_meeting_status(meeting_id, "failed", user_msg)


# ============================================================
# Endpoints
# ============================================================

@router.get("/connect", summary="Get Zoom OAuth authorization URL")
async def get_zoom_connect_url(current_user: dict = Depends(get_current_user)):
    """
    Generate Zoom OAuth URL for the currently authenticated user.
    Uses a signed state containing the user ID for CSRF protection.
    """
    if not settings.is_zoom_configured:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Zoom integration is not configured on the server.",
        )

    try:
        auth_url = zoom_service.get_authorization_url(current_user["id"])
        return {"url": auth_url}
    except Exception as e:
        logger.error(f"Error generating Zoom auth URL: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to generate Zoom authorization URL.",
        )


@router.get("/callback", summary="Zoom OAuth Callback")
async def zoom_oauth_callback(
    code: Optional[str] = Query(None),
    state: Optional[str] = Query(None),
    error: Optional[str] = Query(None),
    error_description: Optional[str] = Query(None),
):
    """
    Zoom OAuth redirect handler.
    Redirects user back to frontend with a status query param (?zoom=connected or ?zoom=error).
    """
    frontend_base = settings.FRONTEND_URL.rstrip("/")

    # Handle user cancellation / Zoom error
    if error:
        logger.warning(f"Zoom OAuth error returned from Zoom: {error} - {error_description}")
        error_param = urllib.parse.quote(error_description or error or "authorization_denied")
        return RedirectResponse(
            url=f"{frontend_base}/settings?zoom=error&reason={error_param}",
            status_code=status.HTTP_302_FOUND,
        )

    if not code or not state:
        logger.error("Zoom OAuth callback received without code or state parameter.")
        return RedirectResponse(
            url=f"{frontend_base}/settings?zoom=error&reason=missing_parameters",
            status_code=status.HTTP_302_FOUND,
        )

    # 1. Verify signed OAuth state and recover authenticated user_id
    try:
        user_id = zoom_service.verify_oauth_state(state)
    except ValueError as e:
        logger.error(f"OAuth state verification failed: {e}")
        return RedirectResponse(
            url=f"{frontend_base}/settings?zoom=error&reason=invalid_or_expired_state",
            status_code=status.HTTP_302_FOUND,
        )

    # 2. Exchange authorization code with Zoom
    try:
        token_data = await zoom_service.exchange_code_for_tokens(code)
    except Exception as e:
        logger.error(f"Token exchange failed for user {user_id}: {e}")
        return RedirectResponse(
            url=f"{frontend_base}/settings?zoom=error&reason=token_exchange_failed",
            status_code=status.HTTP_302_FOUND,
        )

    access_token = token_data.get("access_token")
    refresh_token = token_data.get("refresh_token")
    expires_in = token_data.get("expires_in", 3600)
    scopes = token_data.get("scope", "")

    if not access_token or not refresh_token:
        logger.error("Zoom response did not contain access_token or refresh_token.")
        return RedirectResponse(
            url=f"{frontend_base}/settings?zoom=error&reason=invalid_token_response",
            status_code=status.HTTP_302_FOUND,
        )

    # 3. Retrieve Zoom user profile
    zoom_user_id = "unknown"
    zoom_email = None
    try:
        user_profile = await zoom_service.fetch_zoom_user_profile(access_token)
        zoom_user_id = user_profile.get("id", "unknown")
        zoom_email = user_profile.get("email")
    except Exception as e:
        logger.warning(f"Could not fetch Zoom user profile for user {user_id}: {e}")

    # 4. Encrypt tokens and save to zoom_connections table
    try:
        encrypted_access = zoom_service.encrypt_token(access_token)
        encrypted_refresh = zoom_service.encrypt_token(refresh_token)
        expires_at = datetime.now(timezone.utc) + timedelta(seconds=expires_in)

        supabase_service.save_zoom_connection(
            user_id=user_id,
            zoom_user_id=zoom_user_id,
            zoom_email=zoom_email,
            encrypted_access_token=encrypted_access,
            encrypted_refresh_token=encrypted_refresh,
            expires_at=expires_at.isoformat(),
            scopes=scopes,
        )
        logger.info(f"Zoom connection successfully established and encrypted for user {user_id}")
    except Exception as e:
        logger.error(f"Failed to persist Zoom connection in database for user {user_id}: {e}")
        return RedirectResponse(
            url=f"{frontend_base}/settings?zoom=error&reason=database_save_failed",
            status_code=status.HTTP_302_FOUND,
        )

    # 5. Redirect user to frontend settings with success indicator
    return RedirectResponse(
        url=f"{frontend_base}/settings?zoom=connected",
        status_code=status.HTTP_302_FOUND,
    )


@router.get("/status", summary="Get Zoom connection status")
async def get_zoom_status(current_user: dict = Depends(get_current_user)):
    """
    Check if the user currently has an active Zoom connection.
    Never returns secrets, tokens, or encryption keys.
    """
    user_id = current_user["id"]
    configured = settings.is_zoom_configured

    if not configured:
        return {
            "configured": False,
            "connected": False,
            "email": None,
            "status": "not_configured",
        }

    connection = supabase_service.get_zoom_connection(user_id)
    if not connection or connection.get("status") != "connected":
        return {
            "configured": True,
            "connected": False,
            "email": connection.get("zoom_email") if connection else None,
            "status": connection.get("status") if connection else "disconnected",
        }

    return {
        "configured": True,
        "connected": True,
        "email": connection.get("zoom_email"),
        "status": "connected",
        "connected_at": connection.get("created_at"),
    }


@router.post("/disconnect", summary="Disconnect Zoom account")
async def disconnect_zoom(current_user: dict = Depends(get_current_user)):
    """
    Revoke Zoom OAuth authorization and delete stored connection for this user.
    Preserves all previously summarized meetings.
    """
    user_id = current_user["id"]
    try:
        await zoom_service.revoke_zoom_token(user_id)
        return {"message": "Zoom account disconnected successfully."}
    except Exception as e:
        logger.error(f"Error disconnecting Zoom for user {user_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to disconnect Zoom account.",
        )


@router.get("/recordings", summary="List user's Zoom cloud recordings")
async def list_recordings(
    page_size: int = Query(30, ge=1, le=100),
    next_page_token: Optional[str] = Query(None),
    from_date: Optional[str] = Query(None),
    to_date: Optional[str] = Query(None),
    current_user: dict = Depends(get_current_user),
):
    """
    List cloud recordings from the user's authorized Zoom account.
    Indicates whether a transcript is available and whether it has already been imported.
    """
    user_id = current_user["id"]
    try:
        data = await zoom_service.list_user_recordings(
            user_id=user_id,
            page_size=page_size,
            next_page_token=next_page_token,
            from_date=from_date,
            to_date=to_date,
        )
        return data
    except ValueError as e:
        logger.warning(f"Zoom recordings fetch error for user {user_id}: {e}")
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Unexpected error listing Zoom recordings for user {user_id}: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Could not retrieve recordings from Zoom.",
        )


@router.post("/recordings/{meeting_uuid}/summarize", status_code=status.HTTP_201_CREATED, summary="Summarize a Zoom recording")
async def summarize_recording(
    meeting_uuid: str,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """
    Summarize a specific Zoom cloud recording.
    
    Priority:
    1. WebVTT Transcript (Fastest & direct text analysis)
    2. Audio-only recording (Downloaded and processed via audio Gemini pipeline)
    3. Unsupported (Clear error if neither is available)
    """
    user_id = current_user["id"]

    # 1. Duplicate check: has this recording already been imported?
    existing = supabase_service.get_meeting_by_zoom_uuid(user_id, meeting_uuid)
    if existing:
        return {
            "id": existing["id"],
            "status": existing.get("status", "completed"),
            "already_summarized": True,
            "message": "This Zoom recording has already been imported and summarized.",
        }

    # 2. Fetch recording details and file list from Zoom
    try:
        recording_details = await zoom_service.get_recording_files(user_id, meeting_uuid)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))
    except Exception as e:
        logger.error(f"Failed to fetch Zoom recording details: {e}")
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to fetch Zoom recording.")

    topic = recording_details.get("topic", "Zoom Meeting")
    start_time = recording_details.get("start_time", "")
    meeting_date = start_time.split("T")[0] if "T" in start_time else None
    recording_files = recording_details.get("recording_files", [])

    # 3. Inspect recording files according to priority
    transcript_file = None
    audio_file = None

    for f in recording_files:
        file_type = (f.get("file_type") or "").upper()
        recording_type = (f.get("recording_type") or "").lower()
        file_extension = (f.get("file_extension") or "").upper()

        if file_type == "TRANSCRIPT" or "transcript" in recording_type or file_extension == "VTT":
            transcript_file = f
            break
        elif file_type in ["AUDIO", "M4A"] or "audio" in recording_type:
            if not audio_file:
                audio_file = f

    # Case A: Transcript is available (Preferred)
    if transcript_file and transcript_file.get("download_url"):
        logger.info(f"Transcript found for Zoom recording {meeting_uuid}. Downloading transcript...")
        try:
            raw_vtt_bytes = await zoom_service.download_recording_content(
                user_id=user_id,
                download_url=transcript_file["download_url"],
            )
            vtt_text = raw_vtt_bytes.decode("utf-8", errors="replace")
            clean_transcript = zoom_service.parse_webvtt_to_text(vtt_text)
        except Exception as e:
            logger.error(f"Failed to download or parse Zoom transcript: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Could not download transcript from Zoom.",
            )

        if not clean_transcript.strip():
            clean_transcript = "Transcript content was empty."

        # Create meeting row
        try:
            meeting = supabase_service.create_meeting(
                user_id=user_id,
                title=topic,
                meeting_date=meeting_date,
                participants="Zoom Meeting Participants",
                audio_file_path=None,
                source="zoom",
                zoom_meeting_uuid=meeting_uuid,
            )
            meeting_id = meeting["id"]
        except Exception as e:
            logger.error(f"Failed to create database meeting row: {e}")
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save meeting.")

        # Queue background AI summarization
        background_tasks.add_task(
            _process_zoom_transcript_background,
            meeting_id=meeting_id,
            user_id=user_id,
            transcript_text=clean_transcript,
            title=topic,
        )

        return {
            "id": meeting_id,
            "status": "pending",
            "already_summarized": False,
            "message": "Zoom transcript downloaded. AI summarization started.",
        }

    # Case B: Audio-only recording is available
    elif audio_file and audio_file.get("download_url"):
        logger.info(f"Audio file found for Zoom recording {meeting_uuid}. Downloading audio...")
        try:
            audio_bytes = await zoom_service.download_recording_content(
                user_id=user_id,
                download_url=audio_file["download_url"],
            )
            filename = f"zoom_{meeting_uuid[:8]}.m4a"
            storage_path = supabase_service.upload_audio_to_storage(audio_bytes, user_id, filename)
        except Exception as e:
            logger.error(f"Failed to download audio from Zoom or upload to storage: {e}")
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="Failed to retrieve audio recording from Zoom.",
            )

        # Create meeting row
        try:
            meeting = supabase_service.create_meeting(
                user_id=user_id,
                title=topic,
                meeting_date=meeting_date,
                participants="Zoom Meeting Participants",
                audio_file_path=storage_path,
                source="zoom",
                zoom_meeting_uuid=meeting_uuid,
            )
            meeting_id = meeting["id"]
        except Exception as e:
            logger.error(f"Failed to create database meeting row: {e}")
            supabase_service.delete_audio_from_storage(storage_path)
            raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail="Failed to save meeting.")

        # Queue background AI audio summarization
        background_tasks.add_task(
            _process_zoom_audio_background,
            meeting_id=meeting_id,
            user_id=user_id,
            audio_bytes=audio_bytes,
            filename=filename,
        )

        return {
            "id": meeting_id,
            "status": "pending",
            "already_summarized": False,
            "message": "Zoom audio recording downloaded. AI summarization started.",
        }

    # Case C: Neither transcript nor audio is available
    else:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This Zoom recording does not have a transcript or supported audio recording available for summarization.",
        )
