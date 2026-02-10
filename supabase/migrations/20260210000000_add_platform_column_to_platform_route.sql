-- Migration: Add platform column to platform_route
--
-- Context:
-- - listByUser() previously returned ALL routes regardless of platform
-- - reconnect() had to skip non-numeric IDs (Slack) when reconnecting GitHub
-- - Adding platform column enables proper per-platform filtering
-- - Backfill: numeric team_ids are GitHub installations, alphanumeric are Slack

-- 1. Create enum type for platform values
CREATE TYPE public.platform_type AS ENUM ('slack', 'github');

-- 2. Add column (nullable initially for backfill)
ALTER TABLE public.platform_route ADD COLUMN platform public.platform_type;

-- 3. Backfill existing rows
UPDATE public.platform_route SET platform =
  CASE WHEN team_id ~ '^\d+$' THEN 'github'::public.platform_type
       ELSE 'slack'::public.platform_type END;

-- 4. Set NOT NULL constraint
ALTER TABLE public.platform_route ALTER COLUMN platform SET NOT NULL;

-- 5. Replace user_id index with compound (user_id, platform) index
-- Covers both WHERE user_id = $1 and WHERE user_id = $1 AND platform = $2
DROP INDEX IF EXISTS idx_platform_route_user_id;
CREATE INDEX idx_platform_route_user_platform ON public.platform_route(user_id, platform);

-- 6. Update comments
COMMENT ON TABLE public.platform_route IS 'Routes platform events to Atlas user instances';
COMMENT ON COLUMN public.platform_route.team_id IS 'External platform ID (Slack team ID or GitHub installation ID)';
COMMENT ON COLUMN public.platform_route.platform IS 'Platform identifier';
