import asyncio
import unittest
from unittest.mock import patch, MagicMock

from app.main import app
from app.models.live_schemas import LiveActionItem, LiveInsightsData
from app.services import live_session_service, stt_service


class TestGoogleMeetAndGeminiSTT(unittest.TestCase):
    def test_normalize_mime_type(self):
        self.assertEqual(stt_service._normalize_mime_type("audio/webm;codecs=opus"), "audio/webm")
        self.assertEqual(stt_service._normalize_mime_type("audio/webm"), "audio/webm")
        self.assertEqual(stt_service._normalize_mime_type("audio/ogg;codecs=opus"), "audio/ogg")
        self.assertEqual(stt_service._normalize_mime_type("audio/mp4"), "audio/mp4")
        self.assertEqual(stt_service._normalize_mime_type("audio/wav"), "audio/wav")
        self.assertEqual(stt_service._normalize_mime_type(""), "audio/webm")

    def test_transcribe_empty_or_tiny_audio(self):
        res1 = stt_service.transcribe_audio_chunk(b"")
        self.assertEqual(res1, "")
        res2 = stt_service.transcribe_audio_chunk(b"tiny")
        self.assertEqual(res2, "")

    @patch("app.services.stt_service.genai.Client")
    def test_transcribe_audio_chunk_success(self, mock_client_cls):
        mock_client = MagicMock()
        mock_resp = MagicMock()
        mock_resp.text = "Hello everyone, welcome to the Google Meet."
        mock_client.models.generate_content.return_value = mock_resp
        mock_client_cls.return_value = mock_client

        with patch("app.config.settings.GEMINI_API_KEY", "test-gemini-key"):
            res = stt_service.transcribe_audio_chunk(b"dummy-audio-bytes" * 20, "audio/webm;codecs=opus")
            self.assertEqual(res, "Hello everyone, welcome to the Google Meet.")
            mock_client.models.generate_content.assert_called_once()

    @patch("app.services.stt_service.genai.Client")
    def test_transcribe_audio_chunk_silence_or_noise(self, mock_client_cls):
        mock_client = MagicMock()
        mock_resp = MagicMock()
        mock_resp.text = "NO_SPEECH"
        mock_client.models.generate_content.return_value = mock_resp
        mock_client_cls.return_value = mock_client

        with patch("app.config.settings.GEMINI_API_KEY", "test-gemini-key"):
            res = stt_service.transcribe_audio_chunk(b"dummy-audio-bytes" * 20, "audio/webm")
            self.assertEqual(res, "")

    @patch("app.services.stt_service.genai.Client")
    def test_transcribe_audio_chunk_api_error_handled(self, mock_client_cls):
        mock_client = MagicMock()
        mock_client.models.generate_content.side_effect = RuntimeError("Gemini 429 quota exceeded")
        mock_client_cls.return_value = mock_client

        with patch("app.config.settings.GEMINI_API_KEY", "test-gemini-key"):
            res = stt_service.transcribe_audio_chunk(b"dummy-audio-bytes" * 20, "audio/webm")
            self.assertEqual(res, "")

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
