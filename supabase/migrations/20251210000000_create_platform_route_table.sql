-- Signal Gateway platform routing table for Slack
-- Routes Slack teams to Atlas user instances

-- Slack team routing table
CREATE TABLE public.platform_route (
    id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
    team_id TEXT NOT NULL UNIQUE,  -- Slack team/workspace ID
    user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER trigger_update_updated_at_platform_route
    BEFORE UPDATE ON public.platform_route
    FOR EACH ROW
    EXECUTE FUNCTION _tempest.updated_at();

CREATE INDEX idx_platform_route_lookup ON public.platform_route(team_id);

-- Enable Row Level Security
-- No policies defined - table access is only via service role (which bypasses RLS)
-- RLS is enabled for defense in depth, preventing accidental anonymous/authenticated role access
ALTER TABLE public.platform_route ENABLE ROW LEVEL SECURITY;

-- Note: Signal Gateway accesses this table via service role, which automatically bypasses RLS
-- The authenticated role has been revoked all privileges on this table (see 20251114020000_create_bounce_tables.sql)
-- If user-facing access is needed in the future, add policies with proper auth.uid() to public.user.id mapping

-- Comments for documentation
COMMENT ON TABLE public.platform_route IS 'Routes Slack team events to Atlas user instances';
COMMENT ON COLUMN public.platform_route.team_id IS 'Slack team/workspace ID';
