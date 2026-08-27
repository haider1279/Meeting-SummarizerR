"""
google_meet.py — FastAPI Router for Google Meet Live Meeting Summarization.

This router implements the $0 browser-tab audio capture pipeline:

  Google Meet browser tab
       │
       │ audio (WebM/Opus via MediaRecorder, 5s chunks)
       ▼
  React frontend → authenticated WebSocket
       │
       │ {"action": "audio_chunk", "data": "<base64>", "mime_type": "audio/webm"}
       ▼
  FastAPI (/api/google-meet/ws/{session_id})
       │
       ├── stt_service.transcribe_audio_chunk() → Google STT v1 REST → transcript text
       ├── ingest_transcript_packet() → Supabase + incremental Gemini update
       └── broadcast() → frontend WebSocket (transcript, insights, status)

Endpoints:
  POST       /api/google-meet/session                           Create live session
  GET        /api/google-meet/active                            Get active session for user
  GET        /api/google-meet/sessions/{session_id}             Get session details
  GET        /api/google-meet/sessions/{session_id}/transcript  Get transcript chunks
  POST       /api/google-meet/sessions/{session_id}/stop        Stop and finalize
  WebSocket  /api/google-meet/ws/{session_id}                   Audio input + event output

SECURITY NOTES:
  - JWT token is passed as ?token= query param for WebSocket authentication
  - The token is NEVER logged — only the session_id and user_id are logged
  - GOOGLE_SPEECH_API_KEY is never included in any log output
  - Base64 audio payload is not logged (too large and contains raw user audio)
"""

import asyncio
import base64
import json
import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import (
    APIRouter,
    Depends,
    HTTPException,
    Query,
    Request,
    WebSocket,
    WebSocketDisconnect,
    status,
)

from app.config import settings
from app.dependencies import get_current_user, get_supabase_client
from app.services import live_session_service, stt_service, supabase_service

logger = logging.getLogger("google_meet_router")

router = APIRouter(tags=["Google Meet Live Capture"])


# ============================================================
# 1. REST Endpoints
# ============================================================

@router.get(
    "/api/google-meet/active",
    summary="Get active Google Meet session for the current user",
)
async def get_active_google_meet_session(
    current_user: dict = Depends(get_current_user),
):
    """Return the currently active (waiting/live/processing) Google Meet session."""
    user_id = current_user["id"]
    session = supabase_service.get_active_google_meet_session(user_id)
    if session:
        return {"is_active": True, "session": session}
    return {"is_active": False, "session": None}


@router.post(
    "/api/google-meet/session",
    summary="Create a new Google Meet live session",
    status_code=status.HTTP_201_CREATED,
)
async def create_google_meet_session(
    request: Request,
    current_user: dict = Depends(get_current_user),
):
    """
    Create a new live meeting session with source='google_meet'.
    The frontend calls this before opening the audio WebSocket.
    """
    user_id = current_user["id"]

    body = {}
    try:
        body = await request.json()
    except Exception:
        pass

    title = body.get("title") or "Google Meet — Live Session"

    # Only one active session per user at a time
    existing = supabase_service.get_active_google_meet_session(user_id)
    if existing and existing.get("status") in ("waiting", "live", "processing"):
        logger.info(
            f"[GOOGLE_MEET] Returning existing active session {existing['id']} for user {user_id}"
        )
        return existing

    session = None
    try:
        session = supabase_service.create_live_session(
            user_id=user_id,
            zoom_meeting_id="google_meet_capture",
            title=title,
            source="google_meet",
        )
    except RuntimeError as exc:
        logger.error(f"[GOOGLE_MEET] Failed to create live session for user {user_id}: {exc}")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(exc),
        )
    logger.info(f"[GOOGLE_MEET] Session created: {session['id']} (User: {user_id})")
    return session


@router.get(
    "/api/google-meet/sessions/{session_id}",
    summary="Get details of a specific Google Meet session",
)
async def get_google_meet_session(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Return session details. Scoped to the authenticated user."""
    session = supabase_service.get_live_session(session_id, user_id=current_user["id"])
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or access denied.",
        )
    return session


@router.get(
    "/api/google-meet/sessions/{session_id}/transcript",
    summary="Get all transcript chunks for a Google Meet session",
)
async def get_google_meet_transcript(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """Return all stored transcript chunks for a session."""
    session = supabase_service.get_live_session(session_id, user_id=current_user["id"])
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or access denied.",
        )
    chunks = supabase_service.get_live_transcript_chunks(session_id)
    return {"session_id": session_id, "chunks": chunks}


@router.post(
    "/api/google-meet/sessions/{session_id}/stop",
    summary="Stop and finalize a Google Meet live session",
)
async def stop_google_meet_session(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Manually stop audio capture and trigger final Gemini analysis + meeting persistence.
    The frontend calls this when the user clicks 'End & Finalize Meeting'.
    """
    user_id = current_user["id"]
    session = supabase_service.get_live_session(session_id, user_id=user_id)
    if not session:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Session not found or access denied.",
        )

    runtime = live_session_service.live_session_manager.get_runtime(session_id)
    if runtime and not runtime.is_finalizing:
        asyncio.create_task(live_session_service.finalize_live_meeting(runtime))
        logger.info(f"[GOOGLE_MEET] Finalization triggered for session {session_id}")
        return {"message": "Meeting finalization started. Summary will appear in History shortly."}

    if session.get("status") == "completed":
        return {"message": "Session already completed.", "final_meeting_id": session.get("final_meeting_id")}

    # Fallback: update status directly if no in-memory runtime
    supabase_service.update_live_session(session_id, {"status": "processing"})
    return {"message": "Session marked for processing."}


# ============================================================
# 2. Audio + Event WebSocket
# ============================================================

@router.websocket("/api/google-meet/ws/{session_id}")
async def google_meet_websocket(
    websocket: WebSocket,
    session_id: str,
    token: Optional[str] = Query(None),
):
    """
    Duplex WebSocket for Google Meet browser-tab audio capture.

    Authenticates via Supabase JWT token in ?token= query param.

    Receives from browser:
      {"action": "ping"}                                     → responds {"type": "pong"}
      {"action": "audio_chunk", "data": "<b64>", "mime_type": "audio/webm"} → STT → ingest
      {"action": "stop"}                                     → triggers finalization

    Sends to browser:
      {"type": "init", ...}                                  → initial session state
      {"type": "status", "data": {"status": "..."}}
      {"type": "transcript", "data": {"chunk": {...}}}
      {"type": "insights", "data": {"insights": {...}}}
      {"type": "meeting_ended", "data": {"final_meeting_id": "..."}}
      {"type": "pong"}
      {"type": "error", "data": {"message": "..."}}
    """
    await websocket.accept()

    # 1. Authenticate JWT
    if not token:
        await websocket.send_text(json.dumps({
            "type": "error",
            "data": {"message": "Missing authentication token."}
        }))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        supabase = get_supabase_client()
        auth_resp = supabase.auth.get_user(token)
        if not auth_resp or not auth_resp.user:
            await websocket.send_text(json.dumps({
                "type": "error",
                "data": {"message": "Invalid or expired auth token."}
            }))
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        user_id = str(auth_resp.user.id)
    except Exception as e:
        logger.error(f"[GOOGLE_MEET WS] Authentication error: {e}")
        await websocket.send_text(json.dumps({
            "type": "error",
            "data": {"message": "Authentication failed."}
        }))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # 2. Verify session ownership
    sess_db = supabase_service.get_live_session(session_id, user_id=user_id)
    if not sess_db:
        await websocket.send_text(json.dumps({
            "type": "error",
            "data": {"message": "Session not found or access denied."}
        }))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # 3. Get or create in-memory runtime
    runtime = await live_session_service.live_session_manager.get_or_create_runtime(
        session_id=session_id,
        user_id=user_id,
        title=sess_db.get("title") or "Google Meet — Live Session",
    )
    runtime.add_subscriber(websocket)
    logger.info(f"[GOOGLE_MEET WS] Frontend connected to session {session_id} (User: {user_id})")

    # 4. Send initial synchronization state
    try:
        await websocket.send_text(json.dumps({
            "type": "init",
            "session_id": session_id,
            "data": {
                "status": runtime.status,
                "title": runtime.title,
                "insights": runtime.current_insights,
                "chunks": runtime.full_transcript_chunks,
                "final_meeting_id": sess_db.get("final_meeting_id"),
                "stt_configured": settings.is_google_stt_configured,
            },
        }))
    except Exception as e:
        logger.error(f"[GOOGLE_MEET WS] Error sending initial payload: {e}")

    # 5. Audio chunk sequence counter
    chunk_sequence = [0]

    # 6. Message receive loop
    try:
        while True:
            raw_msg = await websocket.receive_text()

            try:
                msg = json.loads(raw_msg)
            except json.JSONDecodeError:
                logger.warning("[GOOGLE_MEET WS] Received non-JSON message, ignoring.")
                continue

            action = msg.get("action")

            # --- Heartbeat ---
            if action == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

            # --- Audio chunk from browser MediaRecorder ---
            elif action == "audio_chunk":
                b64_data = msg.get("data", "")
                mime_type = msg.get("mime_type", "audio/webm")

                if not b64_data:
                    continue

                # Decode base64 audio
                try:
                    audio_bytes = base64.b64decode(b64_data)
                except Exception as e:
                    logger.warning(f"[GOOGLE_MEET WS] Failed to decode audio base64: {e}")
                    continue

                if len(audio_bytes) < 512:
                    # Skip trivially small chunks (e.g. headers with no audio content)
                    logger.debug(f"[GOOGLE_MEET WS] Skipping small audio chunk: {len(audio_bytes)} bytes")
                    continue

                logger.info(
                    f"[GOOGLE_MEET] Audio chunk received: {len(audio_bytes)} bytes "
                    f"(MIME: {mime_type}, session: {session_id})"
                )

                # Transition session status to 'live' on first audio
                if runtime.status == "waiting":
                    runtime.status = "live"
                    supabase_service.update_live_session(session_id, {"status": "live"})
                    await runtime.broadcast("status", {"status": "live"})
                    logger.info(f"[GOOGLE_MEET] Session {session_id} is now LIVE")

                # Run STT in a thread executor (blocking HTTP call)
                chunk_sequence[0] += 1
                seq_num = chunk_sequence[0]

                async def _process_audio_chunk(ab: bytes, mt: str, seq: int):
                    """Run STT and ingest the resulting transcript chunk."""
                    logger.info(f"[STT] Processing audio chunk #{seq} ({len(ab)} bytes)")

                    loop = asyncio.get_running_loop()
                    transcript_text = await loop.run_in_executor(
                        None,
                        stt_service.transcribe_audio_chunk,
                        ab,
                        mt,
                    )

                    if not transcript_text or not transcript_text.strip():
                        logger.debug(f"[STT] Chunk #{seq}: no speech detected or silence.")
                        return

                    logger.info(
                        f"[STT] Transcript chunk generated (#{seq}): "
                        f"{transcript_text[:60]}..."
                    )

                    timestamp_str = datetime.now(timezone.utc).strftime("%H:%M:%S")
                    await live_session_service.ingest_transcript_packet(
                        runtime=runtime,
                        speaker_id=None,
                        speaker_name="Speaker",
                        text=transcript_text,
                        timestamp=timestamp_str,
                        sequence=seq,
                        language="en",
                    )

                # Fire-and-forget so the WebSocket loop isn't blocked
                asyncio.create_task(_process_audio_chunk(audio_bytes, mime_type, seq_num))

            # --- Manual stop from frontend ---
            elif action == "stop":
                logger.info(f"[GOOGLE_MEET WS] Stop signal received for session {session_id}")
                asyncio.create_task(live_session_service.finalize_live_meeting(runtime))

            else:
                logger.debug(f"[GOOGLE_MEET WS] Unknown action: {action}")

    except WebSocketDisconnect:
        logger.info(f"[GOOGLE_MEET WS] Frontend client disconnected from session {session_id}")
    except Exception as e:
        logger.error(f"[GOOGLE_MEET WS] Unexpected error in session {session_id}: {e}", exc_info=True)
    finally:
        runtime.remove_subscriber(websocket)
        logger.info(f"[GOOGLE_MEET WS] Subscriber removed from session {session_id}")
