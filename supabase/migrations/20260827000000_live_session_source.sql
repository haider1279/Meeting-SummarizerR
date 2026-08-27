-- ============================================================
-- Migration: Add source column to live_meeting_sessions
-- ============================================================
-- This column distinguishes Google Meet browser-capture sessions
-- from Zoom RTMS sessions in the same table.
--
-- Values:
--   'zoom_rtms'    — Zoom RTMS live meeting stream (existing behavior)
--   'google_meet'  — Browser tab audio capture via getDisplayMedia()
--
-- HOW TO RUN:
--   1. Open Supabase Dashboard → SQL Editor
--   2. Paste and run this file
--   3. Verify: SELECT column_name FROM information_schema.columns
--              WHERE table_name='live_meeting_sessions' AND column_name='source';
-- ============================================================

ALTER TABLE public.live_meeting_sessions
    ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'google_meet';

-- Index for filtering by source (used by get_active_google_meet_session)
CREATE INDEX IF NOT EXISTS idx_live_sessions_source
    ON public.live_meeting_sessions(user_id, source);

-- Backfill any existing rows
UPDATE public.live_meeting_sessions
SET source = 'google_meet'
WHERE source IS NULL OR source = '';
