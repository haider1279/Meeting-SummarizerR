import unittest
from unittest.mock import patch, MagicMock
from app.services import stt_service
from app.main import app


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

    def test_routes_registered(self):
        openapi_paths = list(app.openapi()["paths"].keys())
        self.assertIn("/api/google-meet/session", openapi_paths)
        self.assertIn("/api/google-meet/active", openapi_paths)
        self.assertIn("/api/google-meet/sessions/{session_id}", openapi_paths)
        self.assertIn("/api/google-meet/sessions/{session_id}/transcript", openapi_paths)
        self.assertIn("/api/google-meet/sessions/{session_id}/stop", openapi_paths)


if __name__ == "__main__":
    unittest.main()
