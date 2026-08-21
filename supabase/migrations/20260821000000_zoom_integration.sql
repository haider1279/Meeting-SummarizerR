-- ============================================================
-- Migration: 20260821000000_zoom_integration.sql
-- Purpose: Add Zoom OAuth connections table and Zoom meeting metadata
-- ============================================================

-- 1. Create zoom_connections table
-- Stores encrypted OAuth tokens and status per user
CREATE TABLE IF NOT EXISTS public.zoom_connections (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id                 uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    zoom_user_id            text NOT NULL,
    zoom_email              text,
    encrypted_access_token  text NOT NULL,
    encrypted_refresh_token text NOT NULL,
    expires_at              timestamptz NOT NULL,
    scopes                  text,
    status                  text NOT NULL DEFAULT 'connected', -- 'connected' | 'needs_reconnect' | 'disconnected'
    created_at              timestamptz DEFAULT now(),
    updated_at              timestamptz DEFAULT now()
);

-- Index for fast user lookup
CREATE INDEX IF NOT EXISTS idx_zoom_connections_user_id ON public.zoom_connections(user_id);

-- Enable RLS
ALTER TABLE public.zoom_connections ENABLE ROW LEVEL SECURITY;

-- Note: The backend uses the service role key to manage Zoom tokens securely.
-- RLS policy allows users to view only their non-sensitive connection status if queried directly.
CREATE POLICY "Users can read own zoom connection"
    ON public.zoom_connections
    FOR SELECT
    USING (auth.uid() = user_id);

-- Trigger to auto-update updated_at on zoom_connections
CREATE OR REPLACE TRIGGER set_zoom_connections_updated_at
    BEFORE UPDATE ON public.zoom_connections
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Add Zoom source and Zoom meeting UUID columns to meetings table
ALTER TABLE public.meetings 
    ADD COLUMN IF NOT EXISTS source text DEFAULT 'upload';

ALTER TABLE public.meetings 
    ADD COLUMN IF NOT EXISTS zoom_meeting_uuid text;

-- Index to quickly check if a user has already summarized a specific Zoom recording
CREATE INDEX IF NOT EXISTS idx_meetings_user_zoom_uuid 
    ON public.meetings(user_id, zoom_meeting_uuid);
