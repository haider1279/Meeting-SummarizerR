"""
live_zoom.py — FastAPI Router for Real-Time Zoom Meeting Summarization (RTMS).

Endpoints:
  POST       /api/zoom/rtms/webhook               Zoom RTMS Webhook handler (URL validation & RTMS lifecycle)
  GET        /api/live-zoom/active                Get current user's active live meeting session
  POST       /api/live-zoom/session               Create or register a live meeting session
  GET        /api/live-zoom/sessions/{session_id} Get specific live session details
  GET        /api/live-zoom/sessions/{session_id}/transcript  Get transcript chunks for session
  POST       /api/live-zoom/sessions/{session_id}/stop        Manually stop and finalize live session
  WebSocket  /api/live-zoom/ws/{session_id}       Duplex real-time streaming WebSocket for live updates
"""

import asyncio
import json
import logging
from typing import Optional

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    HTTPException,
    Header,
    Query,
    Request,
    Response,
    WebSocket,
    WebSocketDisconnect,
    status,
)
from fastapi.responses import JSONResponse

from app.config import settings
from app.dependencies import get_current_user, get_supabase_client
from app.models.rtms_schemas import (
    LiveMeetingSessionResponse,
    LiveSessionStatus,
)
from app.services import rtms_service, supabase_service

logger = logging.getLogger("live_zoom_router")

router = APIRouter(tags=["Live Zoom RTMS"])


# ============================================================
# 1. Zoom RTMS Webhook Receiver
# ============================================================

@router.post("/api/zoom/rtms/webhook", summary="Zoom RTMS Webhook Endpoint")
async def zoom_rtms_webhook(
    request: Request,
    background_tasks: BackgroundTasks,
):
    """
    Handle Zoom RTMS lifecycle webhook events:
    - endpoint.url_validation (CRC handshake check)
    - meeting.rtms_started (Start receiving live stream)
    - meeting.rtms_stopped / meeting.ended (Finalize meeting summary)
    """
    raw_body = await request.body()
    headers = dict(request.headers)

    # 1. Parse JSON body
    try:
        body = json.loads(raw_body.decode("utf-8"))
    except Exception as e:
        logger.error(f"[RTMS Webhook] Invalid JSON received: {e}")
        return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"detail": "Invalid JSON"})

    event_type = body.get("event")
    logger.info(f"[RTMS] Webhook received: {event_type}")

    # 2. Handle Zoom CRC URL validation challenge
    if event_type == "endpoint.url_validation":
        plain_token = body.get("payload", {}).get("plainToken")
        if not plain_token:
            logger.warning("[RTMS] Missing plainToken in url_validation event.")
            return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"detail": "Missing plainToken"})

        crc_resp = rtms_service.generate_crc_response(plain_token)
        logger.info("[RTMS] Successfully generated CRC validation response for Zoom.")
        return JSONResponse(status_code=status.HTTP_200_OK, content=crc_resp)

    # 3. Verify HMAC-SHA256 signature for all regular events
    is_valid = rtms_service.verify_webhook_signature(headers, raw_body)
    if not is_valid:
        logger.warning("[RTMS] Webhook signature verification failed. Unauthorized request rejected.")
        return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"detail": "Invalid signature"})

    payload = body.get("payload", {})
    obj = payload.get("object", {})

    # Extract meeting and stream identifiers
    meeting_id = str(obj.get("meeting_id") or obj.get("id") or payload.get("meeting_id") or "")
    meeting_uuid = obj.get("meeting_uuid") or obj.get("uuid") or payload.get("meeting_uuid") or ""
    host_id = obj.get("host_id") or payload.get("host_id") or obj.get("host_user_id") or ""
    host_email = obj.get("host_email") or payload.get("host_email") or payload.get("operator") or ""
    topic = obj.get("topic") or "Live Zoom Meeting"
    rtms_stream_id = obj.get("rtms_stream_id") or payload.get("rtms_stream_id") or ""
    server_urls = obj.get("server_urls") or payload.get("server_urls") or obj.get("rtms_server_urls") or payload.get("rtms_server_urls")

    logger.info(
        f"[RTMS] Webhook parsed: Event={event_type} | MeetingID={meeting_id} | "
        f"UUID={meeting_uuid} | Host={host_id} | Email={host_email} | Stream={rtms_stream_id}"
    )

    # 4. Handle RTMS Started
    if event_type in ["meeting.rtms_started", "meeting.rtms_broadcasting_started", "meeting.started"]:
        logger.info(f"[RTMS] Meeting detected: {meeting_id} (Topic: {topic})")

        # Find user from Zoom connection (by host_id, email, or single connected account)
        zoom_conn = supabase_service.find_zoom_connection_for_webhook(
            zoom_user_id=host_id,
            zoom_email=host_email,
        )
        user_id = zoom_conn.get("user_id") if zoom_conn else None

        # Search for existing active live session with matching meeting info or for user
        session_db = supabase_service.find_live_session_by_zoom_info(
            zoom_meeting_id=meeting_id,
            zoom_meeting_uuid=meeting_uuid,
            rtms_stream_id=rtms_stream_id,
        )

        if not session_db and user_id:
            # Check if user has an active session in 'waiting' state
            session_db = supabase_service.get_active_live_session(user_id)

        if session_db:
            session_id = session_db["id"]
            user_id = session_db["user_id"]
            # Update session with stream info
            supabase_service.update_live_session(session_id, {
                "zoom_meeting_id": meeting_id or session_db.get("zoom_meeting_id"),
                "zoom_meeting_uuid": meeting_uuid or session_db.get("zoom_meeting_uuid"),
                "rtms_stream_id": rtms_stream_id or session_db.get("rtms_stream_id"),
                "title": topic or session_db.get("title"),
                "status": "live",
            })
            logger.info(f"[RTMS] Session updated to live: {session_id}")
        elif user_id:
            # Auto-create session for the authenticated Zoom user
            session_db = supabase_service.create_live_session(
                user_id=user_id,
                zoom_meeting_id=meeting_id,
                zoom_meeting_uuid=meeting_uuid,
                rtms_stream_id=rtms_stream_id,
                title=topic,
            )
            session_id = session_db["id"]
            logger.info(f"[RTMS] Session created: {session_id} (User: {user_id})")
        else:
            logger.warning(
                f"[RTMS] Could not match Zoom host ({host_id} / {host_email}) to any registered user. "
                "Ensure user has connected Zoom in Meeting Summarizer Settings."
            )
            return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "user_not_found_ignored"})

        # Initialize session runtime
        runtime = await rtms_service.rtms_manager.get_or_create_runtime(
            session_id=session_id,
            user_id=user_id,
            zoom_meeting_id=meeting_id,
            zoom_meeting_uuid=meeting_uuid,
            title=topic,
        )

        # Launch RTMS WebSocket client in background if server URLs are present
        if server_urls:
            background_tasks.add_task(
                rtms_service.connect_and_stream_rtms,
                server_urls=server_urls,
                meeting_uuid=meeting_uuid,
                rtms_stream_id=rtms_stream_id,
                session_id=session_id,
                runtime=runtime,
            )

        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "rtms_started_processed"})

    # 5. Handle RTMS Stopped / Meeting Ended
    elif event_type in ["meeting.rtms_stopped", "meeting.ended", "meeting.rtms_broadcasting_stopped"]:
        logger.info(f"[RTMS] Meeting ended event received: {event_type} for meeting {meeting_id}")
        runtime = rtms_service.rtms_manager.find_runtime_by_zoom(meeting_uuid, rtms_stream_id)
        if not runtime and meeting_id:
            sess_db = supabase_service.find_live_session_by_zoom_info(zoom_meeting_id=meeting_id)
            if sess_db:
                runtime = await rtms_service.rtms_manager.get_or_create_runtime(
                    session_id=sess_db["id"],
                    user_id=sess_db["user_id"],
                    zoom_meeting_id=sess_db["zoom_meeting_id"],
                    zoom_meeting_uuid=sess_db.get("zoom_meeting_uuid"),
                    title=sess_db.get("title"),
                )

        if runtime:
            background_tasks.add_task(rtms_service.finalize_live_meeting, runtime=runtime)
            logger.info(f"[RTMS] Finalization task queued for meeting {meeting_id} ({runtime.session_id})")

        return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "rtms_stopped_processed"})

    return JSONResponse(status_code=status.HTTP_200_OK, content={"status": "event_received"})


# ============================================================
# 2. Live Session REST Endpoints (Authenticated with Supabase JWT)
# ============================================================

@router.get("/api/live-zoom/active", summary="Get user's active live meeting session")
async def get_active_live_session(current_user: dict = Depends(get_current_user)):
    """
    Check if the authenticated user has an active or waiting live meeting session.
    """
    user_id = current_user["id"]
    sess = supabase_service.get_active_live_session(user_id)
    if not sess:
        return {"is_active": False, "session": None}

    # Enrich with in-memory state if available
    runtime = rtms_service.rtms_manager.get_runtime(sess["id"])
    if runtime:
        sess["status"] = runtime.status
        sess["current_insights"] = runtime.current_insights
        sess["current_summary"] = runtime.current_insights.get("summary", sess.get("current_summary"))

    return {"is_active": True, "session": sess}


@router.post("/api/live-zoom/session", summary="Initialize or create a live meeting session")
async def create_live_meeting_session(
    payload: Optional[dict] = None,
    current_user: dict = Depends(get_current_user),
):
    """
    Explicitly create or prepare a live meeting session.
    If an active session already exists, returns the existing session.
    """
    user_id = current_user["id"]
    zoom_meeting_id = (payload or {}).get("zoom_meeting_id") or "live_meeting"
    title = (payload or {}).get("title") or "Live Zoom Meeting"

    # Check for existing active session
    existing = supabase_service.get_active_live_session(user_id)
    if existing:
        return existing

    new_sess = supabase_service.create_live_session(
        user_id=user_id,
        zoom_meeting_id=zoom_meeting_id,
        title=title,
    )

    await rtms_service.rtms_manager.get_or_create_runtime(
        session_id=new_sess["id"],
        user_id=user_id,
        zoom_meeting_id=zoom_meeting_id,
        title=title,
    )

    return new_sess


@router.get("/api/live-zoom/sessions/{session_id}", summary="Get live meeting session details")
async def get_live_session_details(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Retrieve live meeting session details scoped to the authenticated user.
    """
    user_id = current_user["id"]
    sess = supabase_service.get_live_session(session_id, user_id=user_id)
    if not sess:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Live meeting session not found or access denied.",
        )

    runtime = rtms_service.rtms_manager.get_runtime(session_id)
    if runtime:
        sess["status"] = runtime.status
        sess["current_insights"] = runtime.current_insights
        sess["current_summary"] = runtime.current_insights.get("summary", sess.get("current_summary"))

    return sess


@router.get("/api/live-zoom/sessions/{session_id}/transcript", summary="Get transcript chunks for live session")
async def get_live_transcript_chunks(
    session_id: str,
    current_user: dict = Depends(get_current_user),
):
    """
    Retrieve all accumulated transcript chunks for a live session.
    """
    user_id = current_user["id"]
    sess = supabase_service.get_live_session(session_id, user_id=user_id)
    if not sess:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Live meeting session not found or access denied.",
        )

    chunks = supabase_service.get_live_transcript_chunks(session_id)
    return {"session_id": session_id, "chunks": chunks, "total_chunks": len(chunks)}


@router.post("/api/live-zoom/sessions/{session_id}/stop", summary="Stop and finalize a live meeting session")
async def stop_live_session(
    session_id: str,
    background_tasks: BackgroundTasks,
    current_user: dict = Depends(get_current_user),
):
    """
    Manually stop/end a live meeting session, triggering final Gemini summarization
    and saving the record into standard Meeting History.
    """
    user_id = current_user["id"]
    sess = supabase_service.get_live_session(session_id, user_id=user_id)
    if not sess:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Live meeting session not found or access denied.",
        )

    runtime = await rtms_service.rtms_manager.get_or_create_runtime(
        session_id=session_id,
        user_id=user_id,
        zoom_meeting_id=sess["zoom_meeting_id"],
        zoom_meeting_uuid=sess.get("zoom_meeting_uuid"),
        title=sess.get("title"),
    )

    # Trigger finalization
    background_tasks.add_task(rtms_service.finalize_live_meeting, runtime=runtime)

    return {
        "message": "Live meeting finalization initiated. Results will be saved to Meeting History.",
        "session_id": session_id,
        "status": "processing",
    }


# ============================================================
# 3. Real-Time Frontend WebSocket Endpoint
# ============================================================

@router.websocket("/api/live-zoom/ws/{session_id}")
async def live_zoom_websocket(
    websocket: WebSocket,
    session_id: str,
    token: Optional[str] = Query(None),
):
    """
    Duplex WebSocket connection for real-time frontend streaming.
    Authenticates via Supabase JWT token query parameter.
    Streams transcript chunks, incremental AI updates, and status changes.
    """
    await websocket.accept()

    # Authenticate token with Supabase
    if not token:
        await websocket.send_text(json.dumps({"type": "error", "data": {"message": "Missing authentication token."}}))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    try:
        supabase = get_supabase_client()
        auth_resp = supabase.auth.get_user(token)
        if not auth_resp or not auth_resp.user:
            await websocket.send_text(json.dumps({"type": "error", "data": {"message": "Invalid auth token."}}))
            await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
            return
        user_id = str(auth_resp.user.id)
    except Exception as e:
        logger.error(f"[Live WS] Authentication error: {e}")
        await websocket.send_text(json.dumps({"type": "error", "data": {"message": "Authentication failed."}}))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # Verify session ownership
    sess_db = supabase_service.get_live_session(session_id, user_id=user_id)
    if not sess_db:
        await websocket.send_text(json.dumps({"type": "error", "data": {"message": "Session not found or access denied."}}))
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return

    # Register with runtime
    runtime = await rtms_service.rtms_manager.get_or_create_runtime(
        session_id=session_id,
        user_id=user_id,
        zoom_meeting_id=sess_db["zoom_meeting_id"],
        zoom_meeting_uuid=sess_db.get("zoom_meeting_uuid"),
        title=sess_db.get("title"),
    )
    runtime.add_subscriber(websocket)
    logger.info(f"[Live WS] Frontend connected to live session {session_id} (User: {user_id})")

    # Send initial synchronization state
    try:
        initial_payload = {
            "type": "init",
            "session_id": session_id,
            "data": {
                "status": runtime.status,
                "title": runtime.title,
                "insights": runtime.current_insights,
                "chunks": runtime.full_transcript_chunks,
                "final_meeting_id": sess_db.get("final_meeting_id"),
            }
        }
        await websocket.send_text(json.dumps(initial_payload))
    except Exception as e:
        logger.error(f"[Live WS] Error sending initial payload: {e}")

    # Listen for incoming client messages (heartbeats or commands)
    try:
        while True:
            client_msg = await websocket.receive_text()
            try:
                data = json.loads(client_msg)
                action = data.get("action")
                if action == "ping":
                    await websocket.send_text(json.dumps({"type": "pong"}))
                elif action == "stop":
                    asyncio.create_task(rtms_service.finalize_live_meeting(runtime))
            except Exception:
                pass
    except WebSocketDisconnect:
        logger.info(f"[Live WS] Frontend client disconnected from session {session_id}")
    finally:
        runtime.remove_subscriber(websocket)
