"""
rtms_service.py — Zoom Realtime Media Streams (RTMS) Live Meeting Ingestion & Processing.

Handles:
1. Zoom Webhook validation (CRC handshake challenge + HMAC-SHA256 signature verification).
2. RTMS Signaling WebSocket connection, handshake signature calculation, keep-alives (msg_type 12/13).
3. Transcript packet parsing (msg_type 17), speaker attribution, timestamping, deduplication.
4. Intelligent transcript buffering (batching 20-40s intervals or word limits).
5. Incremental Gemini AI intelligence generation (summary, decisions, action items, topics, questions, risks).
6. Real-time broadcasting to frontend WebSocket clients.
7. Graceful session lifecycle management and finalization into standard meetings.
"""

import asyncio
import base64
import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
import websockets
from fastapi import WebSocket

from app.config import settings
from app.services import gemini_service, supabase_service

logger = logging.getLogger("rtms_service")

# RTMS Protocol Message Types
MSG_TYPE_SIGNALING_HAND_SHAKE_REQ = 1
MSG_TYPE_SIGNALING_HAND_SHAKE_RESP = 2
MSG_TYPE_KEEP_ALIVE_REQ = 12
MSG_TYPE_KEEP_ALIVE_RESP = 13
MSG_TYPE_TRANSCRIPT = 17


# ============================================================
# 1. Zoom Webhook Verification & CRC Handshake
# ============================================================

def verify_webhook_signature(headers: Dict[str, str], raw_body: bytes) -> bool:
    """
    Verify Zoom Webhook HMAC-SHA256 signature against ZOOM_WEBHOOK_SECRET_TOKEN.
    Format: v0={HMAC-SHA256(v0:{timestamp}:{raw_body}, secret_token)}
    """
    secret = settings.ZOOM_WEBHOOK_SECRET_TOKEN.strip()
    if not secret:
        logger.warning("[RTMS] ZOOM_WEBHOOK_SECRET_TOKEN is not set; rejecting webhook for security.")
        return False

    timestamp = headers.get("x-zm-request-timestamp") or headers.get("X-Zm-Request-Timestamp")
    signature = headers.get("x-zm-signature") or headers.get("X-Zm-Signature")

    if not timestamp or not signature:
        logger.warning("[RTMS] Missing x-zm-request-timestamp or x-zm-signature headers in webhook.")
        return False

    # Prevent replay attacks (> 5 minutes old)
    try:
        now_ts = int(time.time())
        req_ts = int(timestamp)
        if abs(now_ts - req_ts) > 300:
            logger.warning("[RTMS] Webhook timestamp expired or clock skew too large.")
            return False
    except Exception:
        return False

    message = f"v0:{timestamp}:{raw_body.decode('utf-8', errors='replace')}"
    expected_hash = hmac.new(
        secret.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    expected_signature = f"v0={expected_hash}"

    return hmac.compare_digest(signature, expected_signature)


def generate_crc_response(plain_token: str) -> Dict[str, str]:
    """
    Handle Zoom endpoint.url_validation CRC challenge response.
    Returns plainToken and encryptedToken.
    """
    secret = settings.ZOOM_WEBHOOK_SECRET_TOKEN.strip()
    encrypted_token = hmac.new(
        secret.encode("utf-8"),
        plain_token.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()

    return {
        "plainToken": plain_token,
        "encryptedToken": encrypted_token
    }


# ============================================================
# 2. RTMS Handshake & Security Signature
# ============================================================

def generate_rtms_handshake_signature(
    client_id: str,
    meeting_uuid: str,
    rtms_stream_id: str,
    client_secret: str,
) -> str:
    """
    Calculate HMAC-SHA256 signature for RTMS SIGNALING_HAND_SHAKE_REQ.
    Signature string: client_id + "," + meeting_uuid + "," + rtms_stream_id
    """
    message = f"{client_id},{meeting_uuid},{rtms_stream_id}"
    signature = hmac.new(
        client_secret.encode("utf-8"),
        message.encode("utf-8"),
        hashlib.sha256
    ).hexdigest()
    return signature


# ============================================================
# 3. In-Memory Live Session Manager & WebSocket Pub/Sub Hub
# ============================================================

class LiveSessionRuntime:
    """
    Manages active state, buffers, async tasks, and connected frontend subscribers
    for an individual live meeting session.
    """

    def __init__(self, session_id: str, user_id: str, zoom_meeting_id: str, zoom_meeting_uuid: Optional[str]):
        self.session_id = session_id
        self.user_id = user_id
        self.zoom_meeting_id = zoom_meeting_id
        self.zoom_meeting_uuid = zoom_meeting_uuid
        self.status = "waiting" # waiting | live | processing | completed | disconnected | failed
        self.title = "Live Zoom Meeting"

        # Transcript storage & deduplication tracking
        self.seen_chunk_hashes: Set[str] = set()
        self.transcript_buffer: List[Dict[str, Any]] = []
        self.full_transcript_chunks: List[Dict[str, Any]] = []

        # Intelligence State
        self.current_insights: Dict[str, Any] = {
            "summary": "",
            "key_points": [],
            "decisions": [],
            "action_items": [],
            "open_questions": [],
            "topics": [],
            "risks": [],
        }

        # Subscribed frontend WebSockets
        self.subscribers: Set[WebSocket] = set()

        # Background processing locks & tasks
        self.rtms_task: Optional[asyncio.Task] = None
        self.buffer_lock = asyncio.Lock()
        self.ai_lock = asyncio.Lock()
        self.last_ai_process_time = time.time()
        self.is_finalizing = False

    async def broadcast(self, event_type: str, data: Dict[str, Any]):
        """Broadcast real-time event to all active frontend subscribers."""
        payload = {
            "type": event_type,
            "session_id": self.session_id,
            "data": data,
            "timestamp": datetime.now(timezone.utc).isoformat(),
        }
        text_data = json.dumps(payload)
        dead_subscribers = set()

        for ws in list(self.subscribers):
            try:
                await ws.send_text(text_data)
            except Exception:
                dead_subscribers.add(ws)

        for ws in dead_subscribers:
            self.subscribers.discard(ws)

    def add_subscriber(self, ws: WebSocket):
        self.subscribers.add(ws)

    def remove_subscriber(self, ws: WebSocket):
        self.subscribers.discard(ws)


class RTMSSessionManager:
    """
    Global manager for active RTMS live sessions and WebSocket streams.
    """

    def __init__(self):
        self.active_sessions: Dict[str, LiveSessionRuntime] = {}
        # Mapping from (zoom_meeting_uuid or rtms_stream_id) -> session_id
        self.stream_lookup: Dict[str, str] = {}
        self.lock = asyncio.Lock()

    async def get_or_create_runtime(
        self,
        session_id: str,
        user_id: str,
        zoom_meeting_id: str,
        zoom_meeting_uuid: Optional[str] = None,
        title: Optional[str] = None,
    ) -> LiveSessionRuntime:
        async with self.lock:
            if session_id in self.active_sessions:
                runtime = self.active_sessions[session_id]
                if title:
                    runtime.title = title
                return runtime

            runtime = LiveSessionRuntime(
                session_id=session_id,
                user_id=user_id,
                zoom_meeting_id=zoom_meeting_id,
                zoom_meeting_uuid=zoom_meeting_uuid,
            )
            if title:
                runtime.title = title

            # Seed existing chunks from database if any
            try:
                existing_chunks = supabase_service.get_live_transcript_chunks(session_id)
                for chunk in existing_chunks:
                    runtime.full_transcript_chunks.append(chunk)
                    if chunk.get("chunk_hash"):
                        runtime.seen_chunk_hashes.add(chunk["chunk_hash"])

                # Seed existing insights
                sess_db = supabase_service.get_live_session(session_id)
                if sess_db and sess_db.get("current_insights"):
                    runtime.current_insights = sess_db["current_insights"]
                    if sess_db.get("status"):
                        runtime.status = sess_db["status"]
            except Exception as e:
                logger.warning(f"[RTMS] Failed to seed existing session state: {e}")

            self.active_sessions[session_id] = runtime
            if zoom_meeting_uuid:
                self.stream_lookup[zoom_meeting_uuid] = session_id

            return runtime

    def get_runtime(self, session_id: str) -> Optional[LiveSessionRuntime]:
        return self.active_sessions.get(session_id)

    def find_runtime_by_zoom(self, zoom_meeting_uuid: Optional[str], rtms_stream_id: Optional[str]) -> Optional[LiveSessionRuntime]:
        if zoom_meeting_uuid and zoom_meeting_uuid in self.stream_lookup:
            return self.get_runtime(self.stream_lookup[zoom_meeting_uuid])
        if rtms_stream_id and rtms_stream_id in self.stream_lookup:
            return self.get_runtime(self.stream_lookup[rtms_stream_id])
        return None

    def remove_runtime(self, session_id: str):
        if session_id in self.active_sessions:
            runtime = self.active_sessions.pop(session_id)
            if runtime.zoom_meeting_uuid and runtime.zoom_meeting_uuid in self.stream_lookup:
                self.stream_lookup.pop(runtime.zoom_meeting_uuid, None)


# Global singleton manager
rtms_manager = RTMSSessionManager()


# ============================================================
# 4. Transcript Ingestion & Incremental AI Processing
# ============================================================

async def ingest_transcript_packet(
    runtime: LiveSessionRuntime,
    speaker_id: Optional[str],
    speaker_name: str,
    text: str,
    timestamp: Optional[str] = None,
    sequence: Optional[int] = None,
    language: str = "en",
):
    """
    Ingest, deduplicate, normalize, persist, and broadcast an incoming transcript chunk.
    """
    clean_text = text.strip()
    if not clean_text:
        return

    # Idempotent deduplication hash: speaker + text + rough timestamp/sequence
    hash_material = f"{speaker_name}:{clean_text}:{timestamp or ''}:{sequence or ''}"
    chunk_hash = hashlib.sha256(hash_material.encode("utf-8")).hexdigest()

    async with runtime.buffer_lock:
        if chunk_hash in runtime.seen_chunk_hashes:
            logger.debug(f"[RTMS] Dropping duplicate transcript chunk: {chunk_hash[:8]}")
            return

        runtime.seen_chunk_hashes.add(chunk_hash)

        chunk_data = {
            "speaker_id": speaker_id,
            "speaker_name": speaker_name or "Speaker",
            "text": clean_text,
            "start_time": timestamp or datetime.now(timezone.utc).strftime("%H:%M:%S"),
            "end_time": timestamp or datetime.now(timezone.utc).strftime("%H:%M:%S"),
            "language": language,
            "sequence_number": sequence,
            "chunk_hash": chunk_hash,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }

        # Store in session memory
        runtime.full_transcript_chunks.append(chunk_data)
        runtime.transcript_buffer.append(chunk_data)

    # Persist chunk to Supabase in background
    try:
        supabase_service.save_transcript_chunk(
            session_id=runtime.session_id,
            speaker_id=speaker_id,
            speaker_name=speaker_name,
            text=clean_text,
            start_time=timestamp,
            end_time=timestamp,
            language=language,
            sequence_number=sequence,
            chunk_hash=chunk_hash,
        )
        logger.info(f"[RTMS] Transcript chunk saved for session {runtime.session_id} (Speaker: {speaker_name})")
    except Exception as e:
        logger.error(f"[RTMS] Failed to persist transcript chunk to Supabase: {e}")

    # Broadcast new chunk to connected frontend subscribers
    await runtime.broadcast("transcript", {
        "chunk": chunk_data,
        "total_chunks": len(runtime.full_transcript_chunks),
    })

    # Check if buffer is ready for incremental Gemini AI summarization
    await _check_and_trigger_ai_update(runtime)


async def _check_and_trigger_ai_update(runtime: LiveSessionRuntime, force: bool = False):
    """
    Check batching conditions and dispatch incremental Gemini summarization if criteria are met.
    Conditions:
    1. Buffer interval >= RTMS_BUFFER_FLUSH_INTERVAL_SECONDS (default 25s), OR
    2. Total words in buffer >= RTMS_MIN_WORDS_PER_CHUNK (default 30 words), OR
    3. force = True (e.g. meeting finalization).
    """
    now = time.time()
    time_elapsed = now - runtime.last_ai_process_time

    async with runtime.buffer_lock:
        if not runtime.transcript_buffer:
            return

        buffered_text_list = [f"{c['speaker_name']}: {c['text']}" for c in runtime.transcript_buffer]
        combined_text = "\n".join(buffered_text_list)
        word_count = len(combined_text.split())

        should_process = (
            force
            or (time_elapsed >= settings.RTMS_BUFFER_FLUSH_INTERVAL_SECONDS and word_count >= 10)
            or (word_count >= settings.RTMS_MIN_WORDS_PER_CHUNK)
        )

        if not should_process:
            return

        # Snapshot and clear buffer
        chunks_to_process = list(runtime.transcript_buffer)
        runtime.transcript_buffer.clear()
        runtime.last_ai_process_time = now

    # Run AI update in background lock so calls never race
    asyncio.create_task(_run_ai_incremental_update(runtime, combined_text))


async def _run_ai_incremental_update(runtime: LiveSessionRuntime, new_transcript_chunk: str):
    """
    Run incremental Gemini analysis in background task and broadcast results.
    """
    async with runtime.ai_lock:
        logger.info(f"[RTMS] Gemini incremental update started for session {runtime.session_id} ({len(new_transcript_chunk)} chars)...")
        try:
            # Call Gemini incremental model
            loop = asyncio.get_running_loop()
            updated_insights = await loop.run_in_executor(
                None,
                gemini_service.incremental_analyze_transcript,
                runtime.current_insights,
                new_transcript_chunk,
                runtime.title,
            )

            if updated_insights:
                runtime.current_insights = updated_insights

                # Update Supabase database
                supabase_service.update_live_session(
                    session_id=runtime.session_id,
                    fields={
                        "current_summary": updated_insights.get("summary", ""),
                        "current_insights": updated_insights,
                        "last_transcript_at": datetime.now(timezone.utc).isoformat(),
                    }
                )

                # Broadcast updated insights to all frontend clients
                await runtime.broadcast("insights", {
                    "insights": updated_insights,
                })
                logger.info(f"[RTMS] Gemini incremental update completed for session {runtime.session_id}")

        except Exception as e:
            logger.error(f"[RTMS] Incremental Gemini AI update failed for session {runtime.session_id}: {e}", exc_info=True)



# ============================================================
# 5. RTMS WebSocket Client Connection Handler
# ============================================================

async def connect_and_stream_rtms(
    server_urls: Any,
    meeting_uuid: str,
    rtms_stream_id: str,
    session_id: str,
    runtime: LiveSessionRuntime,
):
    """
    Connect to Zoom's RTMS signaling server via WebSocket.
    Sends SIGNALING_HAND_SHAKE_REQ, responds to KEEP_ALIVE_REQ, receives live transcripts.
    """
    urls_to_try: List[str] = []
    if isinstance(server_urls, str):
        urls_to_try = [server_urls]
    elif isinstance(server_urls, list):
        urls_to_try = [str(u) for u in server_urls]
    else:
        logger.error(f"[RTMS] Invalid server_urls format: {server_urls}")
        return

    if not urls_to_try:
        logger.error("[RTMS] No server_urls provided for RTMS connection.")
        return

    client_id = settings.ZOOM_CLIENT_ID
    client_secret = settings.ZOOM_CLIENT_SECRET

    if not client_id or not client_secret:
        logger.error("[RTMS] ZOOM_CLIENT_ID or ZOOM_CLIENT_SECRET missing; cannot connect to RTMS.")
        runtime.status = "failed"
        await runtime.broadcast("error", {"message": "Zoom credentials missing on server."})
        return

    signature = generate_rtms_handshake_signature(
        client_id=client_id,
        meeting_uuid=meeting_uuid,
        rtms_stream_id=rtms_stream_id,
        client_secret=client_secret,
    )

    handshake_payload = {
        "msg_type": MSG_TYPE_SIGNALING_HAND_SHAKE_REQ,
        "protocol_version": 1,
        "meeting_uuid": meeting_uuid,
        "rtms_stream_id": rtms_stream_id,
        "signature": signature,
        "sequence": 0,
    }

    connected = False
    for target_url in urls_to_try:
        logger.info(f"[RTMS] Connecting to RTMS: {target_url}")
        try:
            async with websockets.connect(target_url, ping_interval=20, ping_timeout=20) as ws:
                # 1. Send Handshake
                await ws.send(json.dumps(handshake_payload))
                logger.info(f"[RTMS] Handshake sent to {target_url}")

                # Update session status to LIVE
                runtime.status = "live"
                supabase_service.update_live_session(runtime.session_id, {"status": "live"})
                await runtime.broadcast("status", {"status": "live"})

                connected = True

                # 2. Message Loop
                async for raw_message in ws:
                    try:
                        if isinstance(raw_message, bytes):
                            msg_str = raw_message.decode("utf-8", errors="replace")
                        else:
                            msg_str = raw_message

                        msg_json = json.loads(msg_str)
                        msg_type = msg_json.get("msg_type")

                        # Handshake response
                        if msg_type == MSG_TYPE_SIGNALING_HAND_SHAKE_RESP:
                            logger.info(f"[RTMS] Handshake accepted for session {session_id}")

                        # Keep-alive ping from Zoom
                        elif msg_type == MSG_TYPE_KEEP_ALIVE_REQ:
                            seq = msg_json.get("sequence", 0)
                            keep_alive_resp = {
                                "msg_type": MSG_TYPE_KEEP_ALIVE_RESP,
                                "sequence": seq,
                            }
                            await ws.send(json.dumps(keep_alive_resp))
                            logger.debug(f"[RTMS] Responded to KEEP_ALIVE_REQ seq {seq}")

                        # Live Transcript Packet
                        elif msg_type == MSG_TYPE_TRANSCRIPT:
                            # Zoom RTMS transcript structure
                            payload = msg_json.get("payload", msg_json)
                            speaker_id = str(payload.get("user_id", payload.get("speaker_id", "")))
                            speaker_name = payload.get("user_name", payload.get("speaker_name", "Speaker"))
                            text = payload.get("text", payload.get("content", ""))
                            timestamp = payload.get("timestamp", datetime.now(timezone.utc).strftime("%H:%M:%S"))
                            sequence = payload.get("sequence", msg_json.get("sequence", 0))
                            lang = payload.get("language", "en")

                            logger.info(f"[RTMS] Transcript packet received for session {session_id} from {speaker_name}")

                            await ingest_transcript_packet(
                                runtime=runtime,
                                speaker_id=speaker_id,
                                speaker_name=speaker_name,
                                text=text,
                                timestamp=timestamp,
                                sequence=sequence,
                                language=lang,
                            )

                        else:
                            logger.debug(f"[RTMS] Received message type {msg_type}: {msg_str[:120]}")

                    except json.JSONDecodeError:
                        logger.warning(f"[RTMS] Non-JSON message from RTMS WebSocket: {raw_message[:100]}")
                    except Exception as e:
                        logger.error(f"[RTMS] Error processing RTMS WebSocket message: {e}", exc_info=True)

                break # Completed normally
        except Exception as e:
            logger.warning(f"[RTMS] Connection to {target_url} closed or failed: {e}")

    if not connected:
        logger.error(f"[RTMS] Could not establish connection to any Zoom RTMS server URLs for session {session_id}")
        runtime.status = "disconnected"
        supabase_service.update_live_session(runtime.session_id, {"status": "disconnected"})
        await runtime.broadcast("status", {"status": "disconnected"})


# ============================================================
# 6. Meeting Finalization & Persistence
# ============================================================

async def finalize_live_meeting(runtime: LiveSessionRuntime) -> Optional[str]:
    """
    Finalize a live Zoom session:
    1. Stop receiving RTMS data and cancel background task.
    2. Flush remaining transcript buffer.
    3. Run final Gemini analysis to consolidate the complete meeting intelligence.
    4. Save standard row into public.meetings with source = 'zoom_live'.
    5. Save extracted action items into public.action_items.
    6. Update live_meeting_sessions (status = 'completed', final_meeting_id = id).
    7. Broadcast meeting_ended to frontend.
    """
    if runtime.is_finalizing:
        logger.info(f"[RTMS] Session {runtime.session_id} is already finalizing.")
        return None

    runtime.is_finalizing = True
    runtime.status = "processing"
    supabase_service.update_live_session(runtime.session_id, {"status": "processing"})
    await runtime.broadcast("status", {"status": "processing"})

    logger.info(f"[RTMS] Meeting ended: finalizing live meeting session {runtime.session_id}...")

    # 1. Flush any pending buffered text
    await _check_and_trigger_ai_update(runtime, force=True)
    # Give brief moment for active AI task to finish
    await asyncio.sleep(1.0)

    # 2. Build full transcript text
    full_transcript_lines = []
    for c in runtime.full_transcript_chunks:
        full_transcript_lines.append(f"{c['speaker_name']}: {c['text']}")
    full_transcript_text = "\n\n".join(full_transcript_lines).strip()

    if not full_transcript_text:
        full_transcript_text = "No live transcript received during meeting session."

    # 3. Consolidate final analysis with Gemini
    logger.info(f"[RTMS] Final analysis started for session {runtime.session_id}")
    try:
        loop = asyncio.get_running_loop()
        clean_transcript, analysis_dict = await loop.run_in_executor(
            None,
            gemini_service.analyze_meeting_transcript,
            full_transcript_text,
            runtime.title,
        )
        validated = gemini_service.validate_analysis(analysis_dict)
        final_analysis = validated.model_dump()
    except Exception as e:
        logger.error(f"[RTMS] Final Gemini analysis fallback for session {runtime.session_id}: {e}")
        # Fallback to current insights
        final_analysis = {
            "summary": runtime.current_insights.get("summary") or "Meeting completed.",
            "key_points": runtime.current_insights.get("key_points") or [],
            "decisions": runtime.current_insights.get("decisions") or [],
            "action_items": [
                {
                    "task": item.get("task", ""),
                    "assignee": item.get("owner") or item.get("assignee") or "Not specified",
                    "deadline": item.get("deadline") or "No deadline specified",
                    "priority": item.get("priority") or "Not specified",
                }
                for item in runtime.current_insights.get("action_items", [])
            ],
            "unresolved_issues": runtime.current_insights.get("open_questions") or [],
            "important_topics": runtime.current_insights.get("topics") or [],
        }

    # 4. Insert standard meeting row into public.meetings
    try:
        meeting_row = supabase_service.create_meeting(
            user_id=runtime.user_id,
            title=runtime.title or "Live Zoom Meeting",
            meeting_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            participants="Zoom Meeting Participants",
            audio_file_path=None,
            source="zoom_live",
            zoom_meeting_uuid=runtime.zoom_meeting_uuid,
        )
        final_meeting_id = meeting_row["id"]

        # Update meeting results
        supabase_service.update_meeting_results(
            meeting_id=final_meeting_id,
            transcript=full_transcript_text,
            analysis=final_analysis,
        )

        # 5. Insert action items
        action_items_list = final_analysis.get("action_items", [])
        if action_items_list:
            formatted_items = []
            for item in action_items_list:
                formatted_items.append({
                    "task": item.get("task", "Action item"),
                    "assignee": item.get("assignee") or item.get("owner") or "Not specified",
                    "deadline": item.get("deadline") or "No deadline specified",
                    "priority": item.get("priority") or "Not specified",
                })
            supabase_service.create_action_items(
                meeting_id=final_meeting_id,
                user_id=runtime.user_id,
                items=formatted_items,
            )

        # 6. Update live meeting session
        runtime.status = "completed"
        supabase_service.update_live_session(
            session_id=runtime.session_id,
            fields={
                "status": "completed",
                "ended_at": datetime.now(timezone.utc).isoformat(),
                "final_meeting_id": final_meeting_id,
                "current_summary": final_analysis.get("summary", ""),
            }
        )

        # 7. Broadcast completion to frontend
        await runtime.broadcast("meeting_ended", {
            "final_meeting_id": final_meeting_id,
            "status": "completed",
            "message": "Live meeting ended and summary saved to History.",
        })

        logger.info(f"[RTMS] Final meeting saved: {final_meeting_id} (Session: {runtime.session_id})")
        return final_meeting_id


    except Exception as e:
        logger.error(f"[RTMS] Failed to persist final meeting for session {runtime.session_id}: {e}", exc_info=True)
        runtime.status = "failed"
        supabase_service.update_live_session(
            session_id=runtime.session_id,
            fields={"status": "failed", "error_message": "Failed to finalize meeting summary in database."},
        )
        await runtime.broadcast("error", {"message": "Failed to finalize meeting summary."})
        return None
