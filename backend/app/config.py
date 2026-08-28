"""
config.py — Load and validate all environment variables.

All secrets live in a .env file (never in code).
This module reads them once at startup so every other file
can just import `settings` and use settings.GEMINI_API_KEY etc.
"""

import os
from dotenv import load_dotenv

# Load variables from .env file (only used locally; in production,
# these are set directly in the hosting platform's environment).
load_dotenv()


class Settings:
    """
    Holds all configuration values for the application.
    Raises a clear error at startup if any required value is missing,
    so you don't get mysterious failures later.
    """

    def __init__(self):
        self.GEMINI_API_KEY = self._require("GEMINI_API_KEY")
        self.SUPABASE_URL = self._require("SUPABASE_URL")
        self.SUPABASE_SERVICE_ROLE_KEY = self._require("SUPABASE_SERVICE_ROLE_KEY")
        self.FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")
        self.PORT = int(os.getenv("PORT", "8000"))

        # Gemini model to use (Gemini 3.x Flash)
        self.GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-3.6-flash")

        # Maximum audio file size the backend will accept (100 MB in bytes)
        self.MAX_AUDIO_SIZE_BYTES = 100 * 1024 * 1024  # 100 MB

        # Zoom Integration (OAuth & Cloud Recordings)
        self.ZOOM_CLIENT_ID = os.getenv("ZOOM_CLIENT_ID", "")
        self.ZOOM_CLIENT_SECRET = os.getenv("ZOOM_CLIENT_SECRET", "")
        self.ZOOM_REDIRECT_URI = os.getenv(
            "ZOOM_REDIRECT_URI",
            "https://meeting-summarizer-rfrr.onrender.com/api/zoom/callback"
        )
        self.ZOOM_TOKEN_ENCRYPTION_KEY = os.getenv("ZOOM_TOKEN_ENCRYPTION_KEY", "")

        # Live meeting transcript buffering configuration (for Google Meet live capture)
        self.LIVE_BUFFER_FLUSH_INTERVAL_SECONDS = int(
            os.getenv("LIVE_BUFFER_FLUSH_INTERVAL_SECONDS")
            or os.getenv("RTMS_BUFFER_FLUSH_INTERVAL_SECONDS")
            or "25"
        )
        self.LIVE_MIN_WORDS_PER_CHUNK = int(
            os.getenv("LIVE_MIN_WORDS_PER_CHUNK")
            or os.getenv("RTMS_MIN_WORDS_PER_CHUNK")
            or "30"
        )

        # State signing secret (falls back to Supabase service role key or Zoom secret if not set)
        self.STATE_SECRET_KEY = os.getenv(
            "STATE_SECRET_KEY",
            self.SUPABASE_SERVICE_ROLE_KEY or "fallback-secret-for-state-signing"
        )

    @property
    def is_zoom_configured(self) -> bool:
        """Check if minimum required Zoom OAuth configuration is present."""
        return bool(self.ZOOM_CLIENT_ID and self.ZOOM_CLIENT_SECRET)

    @property
    def is_gemini_configured(self) -> bool:
        """Check if Gemini API key is configured."""
        return bool(self.GEMINI_API_KEY)


    @staticmethod
    def _require(key: str) -> str:
        """Read an env var; crash immediately with a helpful message if missing."""
        value = os.getenv(key)
        if not value:
            raise RuntimeError(
                f"Missing required environment variable: {key}\n"
                f"Add it to your .env file. See .env.example for guidance."
            )
        return value


# One shared settings object imported by every other module
settings = Settings()
