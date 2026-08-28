"""
live_session_service.py — Live Meeting Session Runtime, Deduplication, Buffering & Gemini AI Pipeline.

Manages:
1. Active live meeting session runtimes and connected frontend WebSocket subscribers.
2. Transcript packet ingestion, normalization, deduplication, and persistence into Supabase.
3. Intelligent transcript buffering (batching interval or word count thresholds).
4. Incremental Gemini AI intelligence updates (summary, decisions, action items, topics, questions, risks).
5. Real-time broadcasting of status, transcripts, and insights to frontend WebSocket subscribers.
6. Session finalization and meeting consolidation into standard meetings and action items.
"""

import asyncio
import hashlib
import json
import logging
import time
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Set
from fastapi import WebSocket

from app.config import settings
from app.services import gemini_service, supabase_service

logger = logging.getLogger("live_session_service")


# ============================================================
# 1. In-Memory Live Session Manager & WebSocket Pub/Sub Hub
# ============================================================

class LiveSessionRuntime:
    """
    Manages active state, buffers, async tasks, and connected frontend subscribers
    for an individual live meeting session.
    """

    def __init__(self, session_id: str, user_id: str, title: Optional[str] = None):
        self.session_id = session_id
        self.user_id = user_id
        self.status = "waiting"  # waiting | live | capturing | processing | completed | disconnected | failed
        self.title = title or "Google Meet — Live Session"

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

        # Background processing locks & state
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


class LiveSessionManager:
    """
    Global manager for active live sessions and WebSocket streams.
    """

    def __init__(self):
        self.active_sessions: Dict[str, LiveSessionRuntime] = {}
        self.lock = asyncio.Lock()

    async def get_or_create_runtime(
        self,
        session_id: str,
        user_id: str,
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
                title=title,
            )

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
                    # Only restore benign active statuses.
                    # Do NOT restore 'processing', 'completed', or 'failed' into a fresh
                    # runtime — they would cause the frontend to see "Finalizing…" immediately
                    # on the WebSocket init event.
                    db_status = sess_db.get("status")
                    if db_status in ("waiting", "live"):
                        runtime.status = db_status
                    # Any other DB status (processing / completed / failed) → keep 'waiting'
            except Exception as e:
                logger.warning(f"[LIVE_SESSION] Failed to seed existing session state: {e}")

            self.active_sessions[session_id] = runtime
            return runtime

    def get_runtime(self, session_id: str) -> Optional[LiveSessionRuntime]:
        return self.active_sessions.get(session_id)

    def remove_runtime(self, session_id: str):
        self.active_sessions.pop(session_id, None)


# Global singleton manager
live_session_manager = LiveSessionManager()


# ============================================================
# 2. Transcript Ingestion & Incremental AI Processing
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
            logger.debug(f"[LIVE_SESSION] Dropping duplicate transcript chunk: {chunk_hash[:8]}")
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
        logger.info(f"[LIVE_SESSION] Transcript chunk saved for session {runtime.session_id}")
    except Exception as e:
        logger.error(f"[LIVE_SESSION] Failed to persist transcript chunk to Supabase: {e}")

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
    1. Buffer interval >= LIVE_BUFFER_FLUSH_INTERVAL_SECONDS (default 25s), OR
    2. Total words in buffer >= LIVE_MIN_WORDS_PER_CHUNK (default 30 words), OR
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
            or (time_elapsed >= settings.LIVE_BUFFER_FLUSH_INTERVAL_SECONDS and word_count >= 10)
            or (word_count >= settings.LIVE_MIN_WORDS_PER_CHUNK)
        )

        if not should_process:
            return

        # Snapshot and clear buffer
        runtime.transcript_buffer.clear()
        runtime.last_ai_process_time = now

    # Run AI update in background lock so calls never race
    asyncio.create_task(_run_ai_incremental_update(runtime, combined_text))


async def _run_ai_incremental_update(runtime: LiveSessionRuntime, new_transcript_chunk: str):
    """
    Run incremental Gemini analysis in background task and broadcast results.
    """
    async with runtime.ai_lock:
        logger.info(f"[GEMINI] Incremental analysis started for session {runtime.session_id} ({len(new_transcript_chunk)} chars)...")
        try:
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
                logger.info(f"[GEMINI] Incremental analysis completed for session {runtime.session_id}")

        except Exception as e:
            logger.error(f"[GEMINI] Incremental analysis failed for session {runtime.session_id}: {e}", exc_info=True)


# ============================================================
# 3. Meeting Finalization & Persistence
# ============================================================

async def finalize_live_meeting(runtime: LiveSessionRuntime) -> Optional[str]:
    """
    Finalize a live meeting session:
    1. Flush remaining transcript buffer.
    2. Run final Gemini analysis to consolidate the complete meeting intelligence.
    3. Save standard row into public.meetings with source = 'google_meet'.
    4. Save extracted action items into public.action_items.
    5. Update live_meeting_sessions (status = 'completed', final_meeting_id = id).
    6. Broadcast meeting_ended to frontend.
    """
    if runtime.is_finalizing:
        logger.info(f"[LIVE_SESSION] Session {runtime.session_id} is already finalizing.")
        return None

    runtime.is_finalizing = True
    runtime.status = "processing"
    supabase_service.update_live_session(runtime.session_id, {"status": "processing"})
    await runtime.broadcast("status", {"status": "processing"})

    logger.info(f"[LIVE_SESSION] Finalizing live meeting session {runtime.session_id}...")

    # 1. Flush any pending buffered text
    await _check_and_trigger_ai_update(runtime, force=True)
    await asyncio.sleep(1.0)

    # 2. Build full transcript text
    full_transcript_lines = []
    for c in runtime.full_transcript_chunks:
        full_transcript_lines.append(f"{c['speaker_name']}: {c['text']}")
    full_transcript_text = "\n\n".join(full_transcript_lines).strip()

    if not full_transcript_text:
        full_transcript_text = "No live transcript captured during meeting session."

    # 3. Consolidate final analysis with Gemini
    logger.info(f"[GEMINI] Final analysis started for session {runtime.session_id}")
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
        logger.error(f"[GEMINI] Final analysis fallback for session {runtime.session_id}: {e}")
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
            title=runtime.title or "Google Meet — Live Session",
            meeting_date=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            participants="Google Meet Participants",
            audio_file_path=None,
            source="google_meet",
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
            "message": "Google Meet live session ended and summary saved to History.",
        })

        logger.info(f"[LIVE_SESSION] Final meeting saved: {final_meeting_id} (Session: {runtime.session_id})")
        return final_meeting_id

    except Exception as e:
        logger.error(f"[LIVE_SESSION] Failed to persist final meeting for session {runtime.session_id}: {e}", exc_info=True)
        runtime.status = "failed"
        supabase_service.update_live_session(
            session_id=runtime.session_id,
            fields={"status": "failed", "error_message": "Failed to finalize meeting summary in database."},
        )
        await runtime.broadcast("error", {"message": "Failed to finalize meeting summary."})
        return None
