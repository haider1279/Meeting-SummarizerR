-- ============================================================
-- Meeting Summarizer — Full Database Schema for Supabase
-- ============================================================
-- HOW TO USE:
-- 1. Open your Supabase project dashboard at https://supabase.com
-- 2. Go to: SQL Editor (left sidebar)
-- 3. Click "New Query"
-- 4. Paste this ENTIRE file into the editor
-- 5. Click "Run" (green button, top right)
-- That's it! All tables, policies, and triggers will be created.
-- ============================================================


-- ============================================================
-- STEP 1: profiles table
-- This mirrors Supabase's built-in auth.users table.
-- Every time a user signs up, a row is automatically added here
-- via the trigger at the bottom of this file.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.profiles (
    id          uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email       text,
    full_name   text,
    created_at  timestamptz DEFAULT now()
);

-- Enable Row Level Security (RLS) so users can only see their own profile
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- A user can read only their own profile row
CREATE POLICY "Users can read own profile"
    ON public.profiles
    FOR SELECT
    USING (auth.uid() = id);

-- A user can update only their own profile row
CREATE POLICY "Users can update own profile"
    ON public.profiles
    FOR UPDATE
    USING (auth.uid() = id);


-- ============================================================
-- STEP 2: meetings table
-- Stores meeting metadata + AI-generated analysis results.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.meetings (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    title               text NOT NULL,
    meeting_date        date,
    participants        text,                    -- simple comma-separated text
    audio_file_path     text,                    -- path inside Supabase Storage bucket
    status              text NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
    transcript          text,
    summary             text,
    key_points          jsonb,                   -- array of strings
    decisions           jsonb,                   -- array of strings
    unresolved_issues   jsonb,                   -- array of strings
    important_topics    jsonb,                   -- array of strings
    error_message       text,                    -- set only if status = 'failed'
    created_at          timestamptz DEFAULT now(),
    updated_at          timestamptz DEFAULT now()
);

-- Speed up queries that filter by user (very common operation)
CREATE INDEX IF NOT EXISTS idx_meetings_user_id ON public.meetings(user_id);
CREATE INDEX IF NOT EXISTS idx_meetings_created_at ON public.meetings(created_at DESC);

-- Enable RLS
ALTER TABLE public.meetings ENABLE ROW LEVEL SECURITY;

-- Users can only select their own meetings
CREATE POLICY "Users can select own meetings"
    ON public.meetings
    FOR SELECT
    USING (auth.uid() = user_id);

-- Users can only insert meetings for themselves
CREATE POLICY "Users can insert own meetings"
    ON public.meetings
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

-- Users can only update their own meetings
CREATE POLICY "Users can update own meetings"
    ON public.meetings
    FOR UPDATE
    USING (auth.uid() = user_id);

-- Users can only delete their own meetings
CREATE POLICY "Users can delete own meetings"
    ON public.meetings
    FOR DELETE
    USING (auth.uid() = user_id);


-- ============================================================
-- STEP 3: action_items table
-- Stores action items extracted from each meeting.
-- Linked to both the meeting and the user for easy querying.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.action_items (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    meeting_id  uuid NOT NULL REFERENCES public.meetings(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    task        text NOT NULL,
    assignee    text DEFAULT 'Not specified',
    deadline    text DEFAULT 'No deadline specified',
    priority    text DEFAULT 'Not specified',     -- High | Medium | Low | Not specified
    status      text NOT NULL DEFAULT 'pending',  -- pending | completed
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now()
);

-- Speed up queries that filter by meeting or user
CREATE INDEX IF NOT EXISTS idx_action_items_meeting_id ON public.action_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_action_items_user_id ON public.action_items(user_id);

-- Enable RLS
ALTER TABLE public.action_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own action items"
    ON public.action_items
    FOR SELECT
    USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own action items"
    ON public.action_items
    FOR INSERT
    WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own action items"
    ON public.action_items
    FOR UPDATE
    USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own action items"
    ON public.action_items
    FOR DELETE
    USING (auth.uid() = user_id);


-- ============================================================
-- STEP 4: Auto-update the "updated_at" column on row changes
-- ============================================================

-- Generic trigger function that sets updated_at = now()
CREATE OR REPLACE FUNCTION public.update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_meetings_updated_at
    BEFORE UPDATE ON public.meetings
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER set_action_items_updated_at
    BEFORE UPDATE ON public.action_items
    FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


-- ============================================================
-- STEP 5: Auto-create a profile row when a user signs up
-- This trigger fires whenever a new user is added to auth.users.
-- ============================================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO public.profiles (id, email, full_name)
    VALUES (
        NEW.id,
        NEW.email,
        NEW.raw_user_meta_data->>'full_name'  -- pulled from signup metadata
    );
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Attach the trigger to the auth.users table (Supabase's internal auth table)
CREATE OR REPLACE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- STEP 6: Storage bucket policies
-- ============================================================
-- NOTE: You must create the bucket itself via the Supabase dashboard:
--   Storage > New Bucket > Name: "meeting-audio" > Private (NOT public) > Save
--
-- Then run the SQL below to set access policies.
-- These policies ensure users can only access their own audio files.
-- The folder structure inside the bucket is: {user_id}/{filename}
-- ============================================================

-- Allow users to upload files to their own folder only
CREATE POLICY "Users can upload own audio files"
    ON storage.objects
    FOR INSERT
    TO authenticated
    WITH CHECK (
        bucket_id = 'meeting-audio'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Allow users to read/download their own audio files
CREATE POLICY "Users can read own audio files"
    ON storage.objects
    FOR SELECT
    TO authenticated
    USING (
        bucket_id = 'meeting-audio'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );

-- Allow users to delete their own audio files
CREATE POLICY "Users can delete own audio files"
    ON storage.objects
    FOR DELETE
    TO authenticated
    USING (
        bucket_id = 'meeting-audio'
        AND (storage.foldername(name))[1] = auth.uid()::text
    );
