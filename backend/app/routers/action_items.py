"""
action_items.py — Action items API endpoints.

Routes:
  GET /action-items         List user's action items across all meetings (with optional filters)
  PUT /action-items/{id}    Update an action item's status (pending/completed) or content
"""

import logging
from typing import Optional
from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.dependencies import get_current_user
from app.models.schemas import ActionItemResponse, ActionItemUpdate
from app.services import supabase_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/action-items", tags=["Action Items"])


@router.get("", response_model=list[dict])
async def list_action_items(
    meeting_id: Optional[str] = Query(None, description="Filter by specific meeting ID"),
    status: Optional[str] = Query(None, description="Filter by status: pending | completed"),
    current_user: dict = Depends(get_current_user),
):
    """
    List action items for the current user.
    Optionally filter by meeting_id or status (pending/completed).
    Returns list of action items with joined meeting titles.
    """
    try:
        items = supabase_service.list_action_items(
            user_id=current_user["id"],
            meeting_id=meeting_id,
            status_filter=status,
        )
        return items
    except Exception as e:
        logger.error(f"Error listing action items for user {current_user['id']}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to load action items."
        )


@router.put("/{item_id}")
async def update_action_item(
    item_id: str,
    update_data: ActionItemUpdate,
    current_user: dict = Depends(get_current_user),
):
    """
    Update an action item's status, task, assignee, deadline, or priority.
    Only provided fields are updated.
    Scoped strictly to the current user.
    """
    fields = update_data.model_dump(exclude_none=True)
    if not fields:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields provided to update."
        )

    # Validate status value if provided
    if "status" in fields and fields["status"] not in ("pending", "completed"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Status must be 'pending' or 'completed'."
        )

    try:
        updated = supabase_service.update_action_item(
            item_id=item_id,
            user_id=current_user["id"],
            fields=fields
        )
        if not updated:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Action item not found."
            )
        return updated
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Error updating action item {item_id}: {e}")
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to update action item."
        )
