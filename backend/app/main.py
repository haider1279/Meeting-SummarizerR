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
from app.routers import meetings, action_items, zoom, live_zoom

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
# Allow configured frontend URL as well as standard local development ports and production Vercel domain
origins = [
    settings.FRONTEND_URL,
    "https://meeting-summarizer-r.vercel.app",
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
    if settings.is_zoom_configured:
        logger.info(f"Zoom OAuth Configured (Redirect URI: {settings.ZOOM_REDIRECT_URI})")
    else:
        logger.info("Zoom OAuth not configured yet (ZOOM_CLIENT_ID / ZOOM_CLIENT_SECRET empty).")

    if settings.is_rtms_configured:
        logger.info("Zoom RTMS Live Meeting Summarization: Active & Configured.")
    else:
        logger.info("Zoom RTMS Webhook Secret Token not set (ZOOM_WEBHOOK_SECRET_TOKEN).")

    # Safe route diagnostic logging
    registered_paths = sorted(set([
        getattr(route, "path", str(route)) 
        for route in app.routes 
        if hasattr(route, "path")
    ]))
    logger.info(f"[Startup] Total registered route endpoints: {len(registered_paths)}")
    for path in registered_paths:
        logger.info(f"  -> Route: {path}")



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
# Exact OAuth redirect URI: /api/zoom/callback
app.include_router(zoom.router, prefix="/api/zoom")
# Live Zoom RTMS Router
app.include_router(live_zoom.router)



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
