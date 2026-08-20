"""
dependencies.py — FastAPI dependency for authenticating requests.

Every endpoint that touches user data calls get_current_user().
This function:
1. Reads the "Authorization: Bearer <token>" header
2. Sends the token to Supabase to verify it's real
3. Returns the user's ID and email
4. If anything is wrong, returns a 401 Unauthorized error

This means even if someone sends a forged or expired token,
they cannot access any user data.
"""

import logging
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from supabase import create_client

from app.config import settings

logger = logging.getLogger(__name__)

# This tells FastAPI to look for "Authorization: Bearer <token>" in request headers
bearer_scheme = HTTPBearer()


def get_supabase_client():
    """
    Create a Supabase client using the service role key.
    The service role key lets the backend bypass RLS when needed.
    We still manually scope all queries to user_id — defense in depth.

    SECURITY NOTE: This key must NEVER be sent to or used by the frontend.
    It lives only in the backend .env file.
    """
    return create_client(settings.SUPABASE_URL, settings.SUPABASE_SERVICE_ROLE_KEY)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer_scheme),
) -> dict:
    """
    FastAPI dependency — call this in any endpoint to get the logged-in user.

    Usage in a route:
        @router.get("/example")
        async def my_endpoint(current_user: dict = Depends(get_current_user)):
            user_id = current_user["id"]

    Raises HTTPException(401) if the token is missing, invalid, or expired.
    """
    token = credentials.credentials  # the actual JWT string

    try:
        # Ask Supabase to verify the token and return user info.
        # This makes a lightweight call to the Supabase Auth server.
        supabase = get_supabase_client()
        response = supabase.auth.get_user(token)

        if response is None or response.user is None:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Invalid or expired authentication token.",
            )

        user = response.user
        return {
            "id": str(user.id),
            "email": user.email,
        }

    except HTTPException:
        raise  # re-raise our own HTTP exceptions as-is

    except Exception as e:
        # Log the real error on the server, but send a safe message to the client
        logger.error(f"Token verification failed: {e}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication failed. Please log in again.",
        )
