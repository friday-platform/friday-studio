-- Migration: Add is_route_claimable() SECURITY DEFINER function
--
-- Context:
-- - Cross-user ownership checks previously required the app connection to
--   have BYPASSRLS privileges, creating a coupling between app code and
--   Postgres connection role configuration.
-- - SECURITY DEFINER function encapsulates the privilege escalation in Postgres,
--   so the app can call it from any role (including authenticated under RLS).
-- - Used by upsert (within RLS transaction) and completeInstall (standalone check).

CREATE OR REPLACE FUNCTION public.is_route_claimable(p_team_id TEXT, p_user_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM platform_route
    WHERE team_id = p_team_id AND user_id != p_user_id
  );
$$;

COMMENT ON FUNCTION public.is_route_claimable IS
  'Returns true if route is unclaimed or owned by the given user. '
  'SECURITY DEFINER: bypasses RLS to see all rows for cross-user ownership checks.';

-- Restrict access: only authenticated users and service_role can call this function.
-- Default EXECUTE grant to PUBLIC would allow anon role to probe route ownership.
REVOKE EXECUTE ON FUNCTION public.is_route_claimable FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_route_claimable TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_route_claimable TO service_role;
