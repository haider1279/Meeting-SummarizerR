"""
main.py — FastAPI Application Entry Point for Meeting Summarizer.

Features:
- CORS middleware configuration allowing frontend origins (local Vite & production Vercel)
- Router registration for /meetings and /action-items
- /health endpoint for server liveness checks
- Structured error handling to ensure secrets and stack traces are never leaked
"""

import logging
import sys
from fastapi import FastAPI, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.config import settings
from app.routers import meetings, action_items

# Configure server-side logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("meeting_summarizer")

app = FastAPI(
    title="Meeting Summarizer API",
    description="Backend API for AI-powered meeting transcription, summarization, action item extraction, and PDF generation.",
    version="1.0.0",
)

# Configure CORS origins
# Allow configured frontend URL as well as standard local development ports
origins = [
    settings.FRONTEND_URL,
    "http://localhost:5173",
    "http://localhost:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:3000",
]
# Remove duplicates while preserving order
allowed_origins = list(dict.fromkeys([origin.rstrip("/") for origin in origins if origin]))

app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
async def startup_event():
    logger.info("Meeting Summarizer API starting up...")
    logger.info(f"Using Gemini Model: {settings.GEMINI_MODEL}")
    logger.info(f"Allowed CORS Origins: {allowed_origins}")


@app.get("/", tags=["Health"], summary="Root endpoint")
@app.head("/", tags=["Health"], summary="Root HEAD endpoint")
async def root():
    return {"status": "healthy", "service": "Meeting Summarizer API"}


@app.get("/health", tags=["Health"], summary="Liveness & health check")
async def health_check():
    """
    Public health check endpoint.
    Used by hosting platforms (like Render) and monitoring tools to confirm backend is running.
    """
    return {
        "status": "healthy",
        "service": "Meeting Summarizer API",
        "version": "1.0.0"
    }


# Include sub-routers
app.include_router(meetings.router)
app.include_router(action_items.router)


@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    """
    Catch-all exception handler to guarantee that internal errors,
    stack traces, or API keys are NEVER exposed to the frontend client.
    """
    logger.error(f"Unhandled server error on {request.method} {request.url.path}: {exc}", exc_info=True)
    return JSONResponse(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        content={"detail": "An unexpected internal server error occurred. Please try again later."},
    )


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("app.main:app", host="0.0.0.0", port=settings.PORT, reload=True)
