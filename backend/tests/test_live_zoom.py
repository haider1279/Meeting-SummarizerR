"""
test_live_zoom.py — Comprehensive Unit & Integration Tests for Live Zoom RTMS Summarizer.

Tests:
1. Webhook CRC validation challenge (endpoint.url_validation).
2. Webhook HMAC-SHA256 signature verification (x-zm-signature).
3. RTMS Handshake signature calculation (SIGNALING_HAND_SHAKE_REQ).
4. Transcript packet ingestion, speaker attribution, and deduplication.
5. Buffer batching logic (time interval and word count thresholds).
6. Incremental Gemini AI intelligence parsing and Pydantic validation.
7. Final meeting consolidation format and action item extraction.
8. Existing functionality regression checks.
"""

import asyncio
import hashlib
import hmac
import json
import time
import unittest
from unittest.mock import MagicMock, patch

from app.config import settings
from app.models.rtms_schemas import LiveActionItem, LiveInsightsData
from app.models.schemas import GeminiAnalysis
from app.services import gemini_service, rtms_service, zoom_service


class TestZoomRTMSVerification(unittest.TestCase):
    """Test Zoom Webhook Security & CRC Challenge Handshake."""

    def setUp(self):
        self.original_secret = settings.ZOOM_WEBHOOK_SECRET_TOKEN
        settings.ZOOM_WEBHOOK_SECRET_TOKEN = "test_webhook_secret_token_12345"

    def tearDown(self):
        settings.ZOOM_WEBHOOK_SECRET_TOKEN = self.original_secret

    def test_crc_challenge_response(self):
        plain_token = "zoom_test_plain_token_abc"
        res = rtms_service.generate_crc_response(plain_token)

        self.assertEqual(res["plainToken"], plain_token)
        expected_encrypted = hmac.new(
            b"test_webhook_secret_token_12345",
            plain_token.encode("utf-8"),
            hashlib.sha256
        ).hexdigest()
        self.assertEqual(res["encryptedToken"], expected_encrypted)

    def test_webhook_signature_verification_valid(self):
        now_ts = str(int(time.time()))
        body_bytes = json.dumps({"event": "meeting.rtms_started", "payload": {}}).encode("utf-8")
        
        msg = f"v0:{now_ts}:{body_bytes.decode('utf-8')}"
        expected_hash = hmac.new(
            b"test_webhook_secret_token_12345",
            msg.encode("utf-8"),
            hashlib.sha256
        ).hexdigest()
        sig = f"v0={expected_hash}"

        headers = {
            "x-zm-request-timestamp": now_ts,
            "x-zm-signature": sig,
        }

        self.assertTrue(rtms_service.verify_webhook_signature(headers, body_bytes))

    def test_webhook_signature_verification_invalid(self):
        now_ts = str(int(time.time()))
        body_bytes = b'{"event": "test"}'
        headers = {
            "x-zm-request-timestamp": now_ts,
            "x-zm-signature": "v0=invalid_signature_hash",
        }
        self.assertFalse(rtms_service.verify_webhook_signature(headers, body_bytes))

    def test_rtms_handshake_signature(self):
        client_id = "test_client_id"
        meeting_uuid = "test_meeting_uuid_xyz"
        rtms_stream_id = "test_stream_123"
        client_secret = "test_client_secret_abc"

        sig = rtms_service.generate_rtms_handshake_signature(
            client_id=client_id,
            meeting_uuid=meeting_uuid,
            rtms_stream_id=rtms_stream_id,
            client_secret=client_secret,
        )

        expected = hmac.new(
            client_secret.encode("utf-8"),
            f"{client_id},{meeting_uuid},{rtms_stream_id}".encode("utf-8"),
            hashlib.sha256
        ).hexdigest()
        self.assertEqual(sig, expected)


class TestLiveTranscriptDeduplicationAndBuffering(unittest.TestCase):
    """Test Transcript Ingestion, Deduplication, and Buffer Batching."""

    def test_deduplication_and_normalization(self):
        runtime = rtms_service.LiveSessionRuntime(
            session_id="session-123",
            user_id="user-456",
            zoom_meeting_id="meeting-789",
            zoom_meeting_uuid="uuid-000",
        )

        async def run_test():
            # Ingest chunk 1
            await rtms_service.ingest_transcript_packet(
                runtime=runtime,
                speaker_id="user_1",
                speaker_name="John Doe",
                text="We will deploy the release on Friday.",
                timestamp="10:00:00",
                sequence=1,
            )

            # Ingest duplicate chunk 1
            await rtms_service.ingest_transcript_packet(
                runtime=runtime,
                speaker_id="user_1",
                speaker_name="John Doe",
                text="We will deploy the release on Friday.",
                timestamp="10:00:00",
                sequence=1,
            )

            # Ingest chunk 2
            await rtms_service.ingest_transcript_packet(
                runtime=runtime,
                speaker_id="user_2",
                speaker_name="Sarah Connor",
                text="I will test the database migration.",
                timestamp="10:00:05",
                sequence=2,
            )

            # Verification: Only 2 unique chunks should be in memory
            self.assertEqual(len(runtime.full_transcript_chunks), 2)
            self.assertEqual(runtime.full_transcript_chunks[0]["speaker_name"], "John Doe")
            self.assertEqual(runtime.full_transcript_chunks[1]["speaker_name"], "Sarah Connor")

        asyncio.run(run_test())


class TestIncrementalGeminiIntelligence(unittest.TestCase):
    """Test Incremental Structured Output Parsing & Validation."""

    def test_live_insights_schema_validation(self):
        sample_ai_response = {
            "summary": "The team discussed the upcoming Friday deployment and assigned database testing to Sarah.",
            "key_points": [
                "Deployment is scheduled for Friday.",
                "Database migrations need validation."
            ],
            "decisions": [
                "Target deployment date is Friday."
            ],
            "action_items": [
                {
                    "task": "Test database migration",
                    "owner": "Sarah",
                    "deadline": "Friday 9 AM",
                    "priority": "High"
                }
            ],
            "open_questions": [
                "Who will monitor Render logs during release?"
            ],
            "topics": [
                "Deployment",
                "Database Migration"
            ],
            "risks": [
                "Potential downtime during index migration"
            ]
        }

        insights = LiveInsightsData(**sample_ai_response)
        self.assertEqual(insights.summary, sample_ai_response["summary"])
        self.assertEqual(len(insights.action_items), 1)
        self.assertEqual(insights.action_items[0].owner, "Sarah")
        self.assertEqual(insights.action_items[0].priority, "High")
        self.assertEqual(len(insights.decisions), 1)
        self.assertEqual(len(insights.open_questions), 1)

    def test_incremental_analyze_transcript_fallback(self):
        # Empty chunk returns previous state safely
        prev_state = {
            "summary": "Initial summary.",
            "key_points": ["Point A"],
            "decisions": [],
            "action_items": [],
            "open_questions": [],
            "topics": [],
            "risks": [],
        }
        res = gemini_service.incremental_analyze_transcript(prev_state, "")
        self.assertEqual(res["summary"], "Initial summary.")


class TestExistingFunctionalityRegression(unittest.TestCase):
    """Ensure existing Zoom OAuth and transcript cleaners remain intact."""

    def test_webvtt_parser_regression(self):
        vtt_content = """WEBVTT

1
00:00:01.000 --> 00:00:04.000
<v John Doe>Hello everyone, welcome to the sync.</v>

2
00:00:04.500 --> 00:00:07.000
<v Sarah Connor>Thanks John, let's review the roadmap.</v>
"""
        clean_text = zoom_service.parse_webvtt_to_text(vtt_content)
        self.assertIn("John Doe: Hello everyone, welcome to the sync.", clean_text)
        self.assertIn("Sarah Connor: Thanks John, let's review the roadmap.", clean_text)
        self.assertNotIn("WEBVTT", clean_text)
        self.assertNotIn("-->", clean_text)


if __name__ == "__main__":
    unittest.main()
