-- ============================================================
-- Migration: Live Zoom Meeting RTMS Sessions & Transcripts
-- ============================================================

-- 1. Create live_meeting_sessions table
CREATE TABLE IF NOT EXISTS public.live_meeting_sessions (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    zoom_meeting_id     text NOT NULL,
    zoom_meeting_uuid   text,
    rtms_stream_id      text,
    title               text NOT NULL DEFAULT 'Live Zoom Meeting',
    status              text NOT NULL DEFAULT 'waiting', -- 'waiting' | 'live' | 'processing' | 'completed' | 'disconnected' | 'failed'
    started_at          timestamptz DEFAULT now(),
    ended_at            timestamptz,
    last_transcript_at  timestamptz,
    current_summary     text,
    current_insights    jsonb DEFAULT '{"key_points":[],"decisions":[],"action_items":[],"open_questions":[],"topics":[],"risks":[]}'::jsonb,
    final_meeting_id    uuid REFERENCES public.meetings(id) ON DELETE SET NULL,
    error_message       text,
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
);

-- Speed up user and zoom lookups
CREATE INDEX IF NOT EXISTS idx_live_sessions_user_id ON public.live_meeting_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_zoom_uuid ON public.live_meeting_sessions(zoom_meeting_uuid);
CREATE INDEX IF NOT EXISTS idx_live_sessions_rtms_stream_id ON public.live_meeting_sessions(rtms_stream_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_created_at ON public.live_meeting_sessions(created_at DESC);

-- Enable RLS
ALTER TABLE public.live_meeting_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own live sessions"
    ON public.live_meeting_sessions
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own live sessions"
    ON public.live_meeting_sessions
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own live sessions"
    ON public.live_meeting_sessions
    FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own live sessions"
    ON public.live_meeting_sessions
    FOR DELETE
    USING (auth.uid() = user_id);

CREATE OR REPLACE TRIGGER set_live_meeting_sessions_updated_at
    BEFORE UPDATE ON public.live_meeting_sessions
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- 2. Create live_meeting_transcript_chunks table for incremental chunk storage & dedup
CREATE TABLE IF NOT EXISTS public.live_meeting_transcript_chunks (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          uuid NOT NULL REFERENCES public.live_meeting_sessions(id) ON DELETE CASCADE,
    speaker_id          text,
    speaker_name        text NOT NULL DEFAULT 'Speaker',
    start_time          text,
    end_time            text,
    text                text NOT NULL,
    language            text,
    sequence_number     bigint,
    chunk_hash          text,
    created_at          timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_live_transcript_session_id ON public.live_meeting_transcript_chunks(session_id);
CREATE INDEX IF NOT EXISTS idx_live_transcript_chunk_hash ON public.live_meeting_transcript_chunks(session_id, chunk_hash);
CREATE INDEX IF NOT EXISTS idx_live_transcript_seq ON public.live_meeting_transcript_chunks(session_id, sequence_number);

-- Enable RLS on transcript chunks via session ownership
ALTER TABLE public.live_meeting_transcript_chunks ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own transcript chunks"
    ON public.live_meeting_transcript_chunks
    FOR SELECT
    USING (
        EXISTS (
            SELECT 1 FROM public.live_meeting_sessions s
            WHERE s.id = live_meeting_transcript_chunks.session_id
            AND s.user_id = auth.uid()
        )
    );

CREATE POLICY "Users can insert own transcript chunks"
    ON public.live_meeting_transcript_chunks
    FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.live_meeting_sessions s
            WHERE s.id = live_meeting_transcript_chunks.session_id
            AND s.user_id = auth.uid()
        )
    );
