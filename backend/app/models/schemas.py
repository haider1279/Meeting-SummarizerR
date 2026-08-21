"""
schemas.py — Pydantic models for all request and response shapes.

Pydantic automatically validates incoming data and gives helpful
error messages when something doesn't match the expected type.
Every API endpoint uses these models — never raw dicts.
"""

from typing import Optional
from datetime import date
from pydantic import BaseModel, Field


# ============================================================
# Meeting schemas
# ============================================================

class MeetingCreate(BaseModel):
    """Fields the client sends when creating a new meeting (via form data)."""
    title: str = Field(..., min_length=1, max_length=300)
    meeting_date: Optional[date] = None
    participants: Optional[str] = None  # comma-separated names


class MeetingUpdate(BaseModel):
    """
    Fields the client can edit and save back.
    All optional — the client only sends what changed.
    """
    title: Optional[str] = Field(None, min_length=1, max_length=300)
    meeting_date: Optional[date] = None
    participants: Optional[str] = None
    summary: Optional[str] = None
    key_points: Optional[list[str]] = None
    decisions: Optional[list[str]] = None
    unresolved_issues: Optional[list[str]] = None
    important_topics: Optional[list[str]] = None


class MeetingResponse(BaseModel):
    """The shape of a meeting object sent back to the client."""
    id: str
    user_id: str
    title: str
    meeting_date: Optional[str] = None
    participants: Optional[str] = None
    audio_file_path: Optional[str] = None
    status: str
    source: Optional[str] = "upload"
    zoom_meeting_uuid: Optional[str] = None
    transcript: Optional[str] = None
    summary: Optional[str] = None
    key_points: Optional[list] = None
    decisions: Optional[list] = None
    unresolved_issues: Optional[list] = None
    important_topics: Optional[list] = None
    error_message: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class MeetingListItem(BaseModel):
    """Compact meeting summary used in list/history views."""
    id: str
    title: str
    meeting_date: Optional[str] = None
    status: str
    created_at: Optional[str] = None
    action_item_count: Optional[int] = 0


# ============================================================
# Action item schemas
# ============================================================

class ActionItemResponse(BaseModel):
    """The shape of an action item sent to the client."""
    id: str
    meeting_id: str
    user_id: str
    task: str
    assignee: str
    deadline: str
    priority: str
    status: str
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    # These fields are joined in from the meetings table when listing all items
    meeting_title: Optional[str] = None


class ActionItemUpdate(BaseModel):
    """Fields the client can update on an action item."""
    status: Optional[str] = None    # pending | completed
    task: Optional[str] = None
    assignee: Optional[str] = None
    deadline: Optional[str] = None
    priority: Optional[str] = None


# ============================================================
# Gemini response schema
# This is the exact JSON structure we ask Gemini to return.
# We validate the response against this before saving to DB.
# ============================================================

class GeminiActionItem(BaseModel):
    """One action item as returned by Gemini."""
    task: str
    assignee: str = "Not specified"
    deadline: str = "No deadline specified"
    priority: str = "Not specified"


class GeminiAnalysis(BaseModel):
    """
    The full structured analysis Gemini must return.
    We pass this as the response_schema to force Gemini to
    always return exactly this shape of JSON.
    """
    summary: str
    key_points: list[str]
    decisions: list[str]
    action_items: list[GeminiActionItem]
    unresolved_issues: list[str]
    important_topics: list[str]


# ============================================================
# Dashboard stats schema
# ============================================================

class DashboardStats(BaseModel):
    total_meetings: int
    pending_action_items: int
    completed_action_items: int
    recent_meetings: list[dict]


# ============================================================
# Generic response schemas
# ============================================================

class SuccessResponse(BaseModel):
    message: str
    id: Optional[str] = None


class ErrorResponse(BaseModel):
    detail: str


# ============================================================
# Zoom schemas
# ============================================================

class ZoomStatusResponse(BaseModel):
    configured: bool
    connected: bool
    email: Optional[str] = None
    status: str
    connected_at: Optional[str] = None


class ZoomRecordingItem(BaseModel):
    uuid: str
    id: str
    topic: str
    start_time: str
    duration: int
    has_transcript: bool
    has_audio: bool
    can_summarize: bool
    already_imported: bool
    imported_meeting_id: Optional[str] = None
    recording_count: int


class ZoomRecordingsResponse(BaseModel):
    recordings: list[ZoomRecordingItem]
    next_page_token: Optional[str] = ""
    total_records: Optional[int] = 0
    from_date: Optional[str] = Field(None, alias="from")
    to_date: Optional[str] = Field(None, alias="to")
