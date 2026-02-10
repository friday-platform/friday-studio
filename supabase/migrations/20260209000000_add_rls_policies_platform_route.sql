-- Migration: Add RLS policies for public.platform_route
--
-- Context:
-- - platform_route maps external platform IDs (team_id) to user IDs for webhook routing
-- - Previously accessed only via service role (bypasses RLS) with manual app-layer auth
-- - Link service now uses SET LOCAL ROLE authenticated within transactions
-- - Signal Gateway continues to access via service role (read-only, no user context)
-- - Enforces user isolation at database level via request.user_id session variable
--
-- Incident: Missing RLS policies allowed app-layer bug to overwrite other users' routes
-- (see rca/2026-02-09-github-app-reconnect-privilege-escalation.md)

-- ============================================================================
-- 1. Grant necessary permissions to authenticated role
-- ============================================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.platform_route TO authenticated;

-- Index for listByUser query (called on every /authorize via reconnect)
CREATE INDEX IF NOT EXISTS idx_platform_route_user_id ON public.platform_route(user_id);

-- ============================================================================
-- 2. Add RLS policies for user isolation
-- ============================================================================

-- RESTRICTIVE baseline: users can ONLY access their own rows (safety net)
-- This ensures no future PERMISSIVE policy can bypass user isolation.
-- is_route_claimable() SECURITY DEFINER function handles cross-user ownership checks.
-- Signal Gateway also uses service role for webhook routing (no user context).
CREATE POLICY "platform_route_user_isolation" ON public.platform_route
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- PERMISSIVE grants for specific operations
CREATE POLICY "platform_route_select" ON public.platform_route
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "platform_route_insert" ON public.platform_route
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "platform_route_update" ON public.platform_route
    AS PERMISSIVE FOR UPDATE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "platform_route_delete" ON public.platform_route
    AS PERMISSIVE FOR DELETE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));
