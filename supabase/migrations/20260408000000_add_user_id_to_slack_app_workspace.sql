-- Migration: Add user_id + RLS policies to public.slack_app_workspace
--
-- Context:
-- - slack_app_workspace previously had ENABLE/FORCE ROW LEVEL SECURITY set
--   but zero policies and no user_id column, so it was effectively protected
--   only by Link's `postgres` superuser connection bypassing RLS entirely.
-- - The adapter's insert() did a `DELETE ... WHERE workspace_id = $1` with no
--   user scoping, which — combined with per-atlasd workspace_id generation —
--   meant two users with colliding workspace IDs (e.g. both calling a
--   workspace "ops") could silently wipe each other's Slack wiring.
-- - This migration brings the table in line with the rest of the schema
--   (credential, platform_route, cypher.keyset): adds user_id, backfills from
--   credential, enforces per-user 1:1 (user_id, workspace_id), and adds the
--   standard RESTRICTIVE + PERMISSIVE policies. The repository will now go
--   through withUserContext() like every other user-scoped table.

-- ============================================================================
-- 1. Add user_id column and backfill from credential
-- ============================================================================

-- Nullable initially so the backfill can run
ALTER TABLE public.slack_app_workspace ADD COLUMN user_id TEXT;

-- Backfill from credential. credential.id is a logical FK (no constraint
-- because credential uses soft delete); every live row here must resolve.
UPDATE public.slack_app_workspace s
SET user_id = c.user_id
FROM public.credential c
WHERE s.credential_id = c.id;

-- Drop any orphan rows whose credential was hard-deleted in the past.
-- These are unreachable anyway — no user would own them under RLS.
DELETE FROM public.slack_app_workspace WHERE user_id IS NULL;

ALTER TABLE public.slack_app_workspace ALTER COLUMN user_id SET NOT NULL;

-- ============================================================================
-- 2. Indexes
-- ============================================================================

-- Per-user 1:1 between workspace and credential, enforced at the DB level.
-- Replaces the application-layer DELETE-then-INSERT dance.
CREATE UNIQUE INDEX idx_slack_app_workspace_user_workspace
    ON public.slack_app_workspace(user_id, workspace_id);

-- Supporting index for RLS policy evaluation
CREATE INDEX idx_slack_app_workspace_user_id
    ON public.slack_app_workspace(user_id);

-- The old workspace_id-only index is redundant: every query is now
-- user-scoped via RLS and the composite index above covers lookups.
DROP INDEX IF EXISTS public.idx_slack_app_workspace_workspace_id;

-- ============================================================================
-- 3. Grants and RLS policies
-- ============================================================================

-- RLS is already ENABLED + FORCED on this table (see original migration).
-- Authenticated role needs explicit table grants — previously absent because
-- the table was reached only via superuser bypass.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.slack_app_workspace TO authenticated;

-- RESTRICTIVE baseline — cannot be bypassed by future PERMISSIVE policies
CREATE POLICY "slack_app_workspace_user_isolation" ON public.slack_app_workspace
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- PERMISSIVE per-operation policies
CREATE POLICY "slack_app_workspace_select" ON public.slack_app_workspace
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "slack_app_workspace_insert" ON public.slack_app_workspace
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "slack_app_workspace_update" ON public.slack_app_workspace
    AS PERMISSIVE FOR UPDATE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "slack_app_workspace_delete" ON public.slack_app_workspace
    AS PERMISSIVE FOR DELETE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

COMMENT ON COLUMN public.slack_app_workspace.user_id IS 'Atlas user ID — enforced by RLS policies, matches credential.user_id';
