"""
meetings.py — All meeting-related API endpoints.

Routes:
  POST   /meetings/upload          Upload audio and create meeting
  POST   /meetings/{id}/process    (internal) Trigger Gemini processing
  GET    /meetings                 List user's meetings
  GET    /meetings/dashboard       Get dashboard stats
  GET    /meetings/{id}            Get full meeting detail
  PUT    /meetings/{id}            Update meeting fields (user edits)
  DELETE /meetings/{id}            Delete meeting + audio file
  POST   /meetings/{id}/pdf        Generate and download PDF report
"""

import logging
from typing import Optional

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, HTTPException, UploadFile, status
from fastapi.responses import Response

from app.dependencies import get_current_user
from app.models.schemas import MeetingUpdate, SuccessResponse
from app.services import supabase_service, gemini_service, pdf_service
from app.services.audio_validation import validate_audio_file

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/meetings", tags=["Meetings"])


# ============================================================
# Background processing: Gemini analysis
# ============================================================

def _process_meeting_background(meeting_id: str, audio_bytes: bytes, filename: str) -> None:
    """
    Run Gemini analysis in the background (called via FastAPI BackgroundTasks).
    Updates the meeting row with results when done, or marks it 'failed' on error.

    This runs AFTER the upload endpoint has already returned a response to the client.
    The client polls GET /meetings/{id} to see when status changes from 'processing'.
    """
    logger.info(f"Background processing started for meeting {meeting_id}")

    try:
        # Mark the meeting as currently being processed
        supabase_service.update_meeting_status(meeting_id, "processing")

        # Call Gemini with the audio (this can take 30-120 seconds for long recordings)
        transcript, analysis_dict = gemini_service.analyze_meeting_audio(audio_bytes, filename)

        # Validate the response shape with Pydantic
        validated = gemini_service.validate_analysis(analysis_dict)

        # Save results to the database
        supabase_service.update_meeting_results(
            meeting_id=meeting_id,
            transcript=transcript,
            analysis=validated.model_dump(),
        )

        # Save action items as separate rows
        supabase_service.create_action_items(
            meeting_id=meeting_id,
            user_id=_get_user_id_for_meeting(meeting_id),
            items=[item.model_dump() for item in validated.action_items],
        )

        logger.info(f"Meeting {meeting_id} processing completed successfully")

    except Exception as e:
        # Something went wrong — mark meeting as failed with a safe error message
        # We log the full error server-side but only send a generic message to DB
        logger.error(f"Meeting {meeting_id} processing failed: {e}", exc_info=True)

        # Determine a user-friendly error message
        error_msg = str(e)
        if "rate" in error_msg.lower() or "429" in error_msg:
            user_msg = "AI processing rate limit reached. Please try again in a few minutes."
        elif "json" in error_msg.lower() or "parse" in error_msg.lower():
            user_msg = "AI returned an unexpected response format. Please try reprocessing."
        elif "file" in error_msg.lower() and "upload" in error_msg.lower():
            user_msg = "Could not upload audio to AI service. Check file format and try again."
        else:
            user_msg = "Processing failed. Please try again or contact support."

        supabase_service.update_meeting_status(meeting_id, "failed", user_msg)


def _get_user_id_for_meeting(meeting_id: str) -> str:
    """Helper to look up the user_id for a meeting during background processing."""
    # We need to fetch without user scoping since we don't have the user in background context
    from supabase import create_client
    from app.config import settings
    supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)
    result = supabase.table("meetings").select("user_id").eq("id", meeting_id).single().execute()
    return result.data["user_id"] if result.data else ""


# ============================================================
# Endpoints
# ============================================================

@router.get("/dashboard")
async def get_dashboard(current_user: dict = Depends(get_current_user)):
    """
    Get dashboard statistics for the current user.
    Returns: total meetings, pending/completed action item counts, recent meetings.
    """
    try:
        stats = supabase_service.get_dashboard_stats(current_user["id"])
        return stats
    except Exception as e:
        logger.error(f"Dashboard stats error for user {current_user['id']}: {e}")
        raise HTTPException(status_code=500, detail="Failed to load dashboard data.")


@router.post("/upload", status_code=status.HTTP_201_CREATED)
async def upload_meeting(
    background_tasks: BackgroundTasks,
    title: str = Form(..., min_length=1, max_length=300),
    meeting_date: Optional[str] = Form(None),
    participants: Optional[str] = Form(None),
    audio_file: UploadFile = File(...),
    current_user: dict = Depends(get_current_user),
):
    """
    Upload a meeting audio file and start AI analysis in the background.

    Steps:
    1. Validate the audio file (type, size, not empty)
    2. Upload audio to Supabase Storage
    3. Create a 'meetings' row with status='pending'
    4. Start Gemini processing in the background
    5. Return the meeting ID immediately

    The client should then poll GET /meetings/{id} to watch the status change.
    Status flow: pending → processing → completed (or failed)
    """
    user_id = current_user["id"]

    # 1. Validate audio
    audio_bytes = await validate_audio_file(audio_file)
    filename = audio_file.filename or "recording.mp3"

    # 2. Upload to storage
    try:
        storage_path = supabase_service.upload_audio_to_storage(audio_bytes, user_id, filename)
    except Exception as e:
        logger.error(f"Storage upload failed for user {user_id}: {e}")
        raise HTTPException(status_code=500, detail="Failed to store audio file. Please try again.")

    # 3. Create meeting row in database
    try:
        meeting = supabase_service.create_meeting(
            user_id=user_id,
            title=title,
            meeting_date=meeting_date,
            participants=participants,
            audio_file_path=storage_path,
        )
        meeting_id = meeting["id"]
    except Exception as e:
        logger.error(f"Failed to create meeting row: {e}")
        # Clean up the uploaded file if DB insert fails
        supabase_service.delete_audio_from_storage(storage_path)
        raise HTTPException(status_code=500, detail="Failed to save meeting. Please try again.")

    # 4. Queue background processing (Gemini AI analysis)
    background_tasks.add_task(
        _process_meeting_background,
        meeting_id=meeting_id,
        audio_bytes=audio_bytes,
        filename=filename,
    )

    logger.info(f"Meeting {meeting_id} created for user {user_id}, processing queued")
    return {"id": meeting_id, "status": "pending", "message": "Meeting uploaded. AI analysis started."}


@router.get("")
async def list_meetings(
    search: Optional[str] = None,
    sort: str = "newest",
    current_user: dict = Depends(get_current_user),
):
    """
    List all meetings for the current user.
    Optional query params: ?search=keyword, ?sort=newest (default) or oldest.
    """
    try:
        meetings = supabase_service.list_meetings(current_user["id"], search=search, sort=sort)

        # For each meeting, count its action items
        from supabase import create_client
        from app.config import settings
        supabase = create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)

        enriched = []
        for m in meetings:
            count_result = (
                supabase.table("action_items")
                .select("id", count="exact")
                .eq("meeting_id", m["id"])
                .execute()
            )
            m["action_item_count"] = count_result.count or 0
            enriched.append(m)

        return enriched
    except Exception as e:
        logger.error(f"List meetings error: {e}")
        raise HTTPException(status_code=500, detail="Failed to load meetings.")


@router.get("/{meeting_id}")
async def get_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Get full meeting detail including transcript and AI analysis."""
    meeting = supabase_service.get_meeting(meeting_id, current_user["id"])
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found.")

    # Also load action items for this meeting
    action_items = supabase_service.list_action_items(
        user_id=current_user["id"],
        meeting_id=meeting_id,
    )
    meeting["action_items"] = action_items
    return meeting


@router.put("/{meeting_id}")
async def update_meeting(
    meeting_id: str,
    update_data: MeetingUpdate,
    current_user: dict = Depends(get_current_user),
):
    """
    Update user-editable meeting fields.
    Only fields included in the request body are updated.
    These edits are persisted and will NOT be overwritten by future AI processing.
    """
    # Only include fields that were actually provided (not None)
    fields = update_data.model_dump(exclude_none=True)

    if not fields:
        raise HTTPException(status_code=400, detail="No fields provided to update.")

    # Convert meeting_date from date object to string for storage
    if "meeting_date" in fields and fields["meeting_date"] is not None:
        fields["meeting_date"] = str(fields["meeting_date"])

    updated = supabase_service.update_meeting_fields(meeting_id, current_user["id"], fields)
    if not updated:
        raise HTTPException(status_code=404, detail="Meeting not found.")

    return updated


@router.delete("/{meeting_id}")
async def delete_meeting(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Delete a meeting and its audio file.
    Action items are deleted automatically by the database cascade constraint.
    """
    # First get the meeting to find the audio file path
    meeting = supabase_service.get_meeting(meeting_id, current_user["id"])
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found.")

    # Delete audio from storage (best effort — don't fail if file already gone)
    if meeting.get("audio_file_path"):
        supabase_service.delete_audio_from_storage(meeting["audio_file_path"])

    # Delete the meeting row (cascades to action_items)
    deleted = supabase_service.delete_meeting(meeting_id, current_user["id"])
    if not deleted:
        raise HTTPException(status_code=404, detail="Meeting not found.")

    return {"message": "Meeting deleted successfully."}


@router.post("/{meeting_id}/pdf")
async def generate_pdf(
    meeting_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Generate and return a PDF report for the specified meeting.
    The PDF is built from the CURRENTLY SAVED data (respects user edits).
    """
    # Load full meeting data
    meeting = supabase_service.get_meeting(meeting_id, current_user["id"])
    if not meeting:
        raise HTTPException(status_code=404, detail="Meeting not found.")

    if meeting.get("status") != "completed":
        raise HTTPException(
            status_code=400,
            detail="PDF can only be generated for completed meetings.",
        )

    # Load action items to include in PDF
    action_items = supabase_service.list_action_items(
        user_id=current_user["id"],
        meeting_id=meeting_id,
    )
    meeting["action_items"] = action_items

    try:
        pdf_bytes = pdf_service.generate_meeting_pdf(meeting)
    except Exception as e:
        logger.error(f"PDF generation failed for meeting {meeting_id}: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail="Failed to generate PDF. Please try again.")

    # Build a safe filename for the download
    safe_title = "".join(c for c in meeting.get("title", "meeting") if c.isalnum() or c in " -_")
    safe_title = safe_title.strip().replace(" ", "_")[:50]
    filename = f"meeting_report_{safe_title}.pdf"

    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
