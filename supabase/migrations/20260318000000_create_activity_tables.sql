-- Create activity tables for tracking workspace activity (sessions, resources)
-- Tables: activities, activity_read_status
-- Includes: indexes, RLS policies, data backfill from cortex.object

-- ============================================================================
-- Types
-- ============================================================================

CREATE TYPE public.activity_type AS ENUM ('session', 'resource');
CREATE TYPE public.activity_source AS ENUM ('agent', 'user');
CREATE TYPE public.activity_read_statuses AS ENUM ('viewed', 'dismissed');

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE public.activities (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  type public.activity_type NOT NULL,
  source public.activity_source NOT NULL,
  reference_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  job_id TEXT,
  user_id TEXT REFERENCES public."user"(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.activity_read_status (
  user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  activity_id TEXT NOT NULL REFERENCES public.activities(id) ON DELETE CASCADE,
  status public.activity_read_statuses NOT NULL,
  PRIMARY KEY (user_id, activity_id)
);

-- ============================================================================
-- Indexes
-- ============================================================================

CREATE INDEX idx_activities_created_at ON public.activities(created_at DESC);
CREATE INDEX idx_activities_workspace_id ON public.activities(workspace_id);
CREATE INDEX idx_activities_reference_id ON public.activities(reference_id);
CREATE INDEX idx_activities_user_id ON public.activities(user_id);
CREATE INDEX idx_activity_read_status_user ON public.activity_read_status(user_id);

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities FORCE ROW LEVEL SECURITY;
ALTER TABLE public.activity_read_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_read_status FORCE ROW LEVEL SECURITY;

-- Grant permissions to authenticated role
GRANT USAGE ON TYPE public.activity_type TO authenticated;
GRANT USAGE ON TYPE public.activity_source TO authenticated;
GRANT USAGE ON TYPE public.activity_read_statuses TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.activities TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.activity_read_status TO authenticated;

-- ============================================================================
-- RLS policies — activities
-- ============================================================================

-- RESTRICTIVE baseline: users can ONLY access their own rows (safety net).
-- The IS NOT NULL guard ensures that an unset request.user_id always denies
-- access rather than relying on NULL != value being falsy.
CREATE POLICY "activities_user_isolation" ON public.activities
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  )
  WITH CHECK (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  );

CREATE POLICY "activities_select" ON public.activities
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "activities_insert" ON public.activities
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "activities_update" ON public.activities
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "activities_delete" ON public.activities
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));

-- ============================================================================
-- RLS policies — activity_read_status
-- ============================================================================

CREATE POLICY "activity_read_status_user_isolation" ON public.activity_read_status
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  )
  WITH CHECK (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  );

CREATE POLICY "activity_read_status_select" ON public.activity_read_status
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "activity_read_status_insert" ON public.activity_read_status
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "activity_read_status_update" ON public.activity_read_status
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "activity_read_status_delete" ON public.activity_read_status
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));

-- ============================================================================
-- Data backfill from Cortex session metadata
-- ============================================================================

INSERT INTO public.activities (type, source, reference_id, workspace_id, job_id, user_id, title, created_at)
SELECT
  'session'::public.activity_type,
  'agent'::public.activity_source,
  o.metadata->>'session_id',
  o.metadata->>'workspace_id',
  o.metadata->>'job_name',
  o.user_id,
  initcap(replace(replace(o.metadata->>'job_name', '-', ' '), '_', ' '))
    || ' session '
    || CASE WHEN o.metadata->>'status' = 'completed' THEN 'completed' ELSE 'failed' END,
  o.created_at
FROM cortex.object o
WHERE o.deleted_at IS NULL
  AND o.metadata->>'session_id' IS NOT NULL
  AND o.metadata->>'status' IN ('completed', 'failed')
  -- Exclude conversation workspaces and chat jobs
  AND o.metadata->>'workspace_id' NOT IN ('atlas-conversation', 'friday-conversation', 'system')
  AND o.metadata->>'job_name' != 'handle-chat'
  -- Prevent duplicate backfill (idempotent)
  AND NOT EXISTS (
    SELECT 1 FROM public.activities a
    WHERE a.reference_id = o.metadata->>'session_id'
  );
