import asyncio
import unittest
from unittest.mock import patch, MagicMock

from app.main import app
from app.models.live_schemas import LiveActionItem, LiveInsightsData
from app.services import live_session_service, stt_service, zoom_service


class TestGoogleMeetAndSTT(unittest.TestCase):
    def test_resolve_encoding(self):
        self.assertEqual(stt_service._resolve_encoding("audio/webm"), "WEBM_OPUS")
        self.assertEqual(stt_service._resolve_encoding("audio/webm;codecs=opus"), "WEBM_OPUS")
        self.assertEqual(stt_service._resolve_encoding("audio/ogg;codecs=opus"), "OGG_OPUS")
        self.assertEqual(stt_service._resolve_encoding("audio/wav"), "LINEAR16")
        self.assertEqual(stt_service._resolve_encoding("audio/mp4"), "MP3")

    def test_extract_transcript(self):
        sample_response = {
            "results": [
                {
                    "alternatives": [
                        {"transcript": "Hello everyone, welcome to the meeting.", "confidence": 0.98}
                    ]
                },
                {
                    "alternatives": [
                        {"transcript": "Let's review the Q3 roadmap.", "confidence": 0.95}
                    ]
                }
            ]
        }
        extracted = stt_service._extract_transcript(sample_response)
        self.assertEqual(extracted, "Hello everyone, welcome to the meeting. Let's review the Q3 roadmap.")

    def test_extract_transcript_empty(self):
        self.assertEqual(stt_service._extract_transcript({}), "")
        self.assertEqual(stt_service._extract_transcript({"results": []}), "")

    @patch("app.services.stt_service.httpx.post")
    def test_transcribe_audio_chunk_success(self, mock_post):
        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.json.return_value = {
            "results": [
                {
                    "alternatives": [
                        {"transcript": "Test speech transcription."}
                    ]
                }
            ]
        }
        mock_post.return_value = mock_resp

        with patch("app.config.settings.GOOGLE_SPEECH_API_KEY", "test-key"):
            res = stt_service.transcribe_audio_chunk(b"dummy-audio-bytes", "audio/webm")
            self.assertEqual(res, "Test speech transcription.")

    def test_live_session_deduplication(self):
        runtime = live_session_service.LiveSessionRuntime(
            session_id="test-session-123",
            user_id="test-user-456",
            title="Google Meet Sync",
        )

        async def run_test():
            # Ingest chunk 1
            await live_session_service.ingest_transcript_packet(
                runtime=runtime,
                speaker_id=None,
                speaker_name="Speaker",
                text="Deploying the new update on Monday.",
                timestamp="10:00:00",
                sequence=1,
            )

            # Ingest duplicate chunk 1
            await live_session_service.ingest_transcript_packet(
                runtime=runtime,
                speaker_id=None,
                speaker_name="Speaker",
                text="Deploying the new update on Monday.",
                timestamp="10:00:00",
                sequence=1,
            )

            # Ingest chunk 2
            await live_session_service.ingest_transcript_packet(
                runtime=runtime,
                speaker_id=None,
                speaker_name="Speaker",
                text="Testing the Google Meet live capture.",
                timestamp="10:00:05",
                sequence=2,
            )

            self.assertEqual(len(runtime.full_transcript_chunks), 2)
            self.assertEqual(runtime.full_transcript_chunks[0]["text"], "Deploying the new update on Monday.")
            self.assertEqual(runtime.full_transcript_chunks[1]["text"], "Testing the Google Meet live capture.")

        asyncio.run(run_test())

    def test_live_insights_schema_validation(self):
        sample_ai_response = {
            "summary": "The team discussed the upcoming Monday deployment.",
            "key_points": ["Deployment is on Monday."],
            "decisions": ["Approved the release."],
            "action_items": [
                {
                    "task": "Test Google Meet capture",
                    "owner": "Alex",
                    "deadline": "Monday 9 AM",
                    "priority": "High"
                }
            ],
            "open_questions": [],
            "topics": ["Deployment", "Testing"],
            "risks": []
        }

        insights = LiveInsightsData(**sample_ai_response)
        self.assertEqual(insights.summary, sample_ai_response["summary"])
        self.assertEqual(len(insights.action_items), 1)
        self.assertEqual(insights.action_items[0].owner, "Alex")

    def test_routes_registered_correctly(self):
        openapi_paths = list(app.openapi()["paths"].keys())
        
        # Expected Google Meet Live routes
        self.assertIn("/api/google-meet/session", openapi_paths)
        self.assertIn("/api/google-meet/active", openapi_paths)
        self.assertIn("/api/google-meet/sessions/{session_id}", openapi_paths)
        self.assertIn("/api/google-meet/sessions/{session_id}/transcript", openapi_paths)
        self.assertIn("/api/google-meet/sessions/{session_id}/stop", openapi_paths)

        # Expected Zoom Cloud Recording routes
        self.assertIn("/api/zoom/connect", openapi_paths)
        self.assertIn("/api/zoom/callback", openapi_paths)
        self.assertIn("/api/zoom/status", openapi_paths)
        self.assertIn("/api/zoom/disconnect", openapi_paths)
        self.assertIn("/api/zoom/recordings", openapi_paths)
        self.assertIn("/api/zoom/recordings/{meeting_uuid}/summarize", openapi_paths)

        # Confirm Zoom RTMS routes are REMOVED
        self.assertNotIn("/api/zoom/rtms/webhook", openapi_paths)
        self.assertNotIn("/api/live-zoom/active", openapi_paths)
        self.assertNotIn("/api/live-zoom/session", openapi_paths)


if __name__ == "__main__":
    unittest.main()
