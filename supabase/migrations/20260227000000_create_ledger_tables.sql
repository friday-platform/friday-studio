-- Create ledger tables for workspace-scoped persistent resources
-- Tables: resource_metadata, resource_versions
-- Includes: indexes, immutability triggers, RLS policies

-- ============================================================================
-- Types
-- ============================================================================

CREATE TYPE public.resource_type AS ENUM ('document', 'artifact_ref', 'external_ref');

-- ============================================================================
-- Tables
-- ============================================================================

CREATE TABLE public.resource_metadata (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  type public.resource_type NOT NULL,
  current_version INTEGER NOT NULL DEFAULT 1 CHECK (current_version >= 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, workspace_id, slug)
);

CREATE TABLE public.resource_versions (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  resource_id TEXT NOT NULL REFERENCES public.resource_metadata(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
  version INTEGER CHECK (version IS NULL OR version >= 1),
  schema JSONB NOT NULL DEFAULT '{}',
  data JSONB NOT NULL DEFAULT '{}',
  dirty BOOLEAN NOT NULL DEFAULT FALSE,
  draft_version INTEGER NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (resource_id, version)
);

-- ============================================================================
-- Indexes
-- ============================================================================

-- Enforces at most one draft per resource (NULL != NULL defeats the UNIQUE constraint)
CREATE UNIQUE INDEX idx_one_draft_per_resource
  ON public.resource_versions(resource_id) WHERE version IS NULL;

-- Composite index for the hot path: most adapter queries filter on all three.
-- INCLUDE enables index-only scans for common SELECT columns (id, type, current_version).
-- Subsumes the old single-column (workspace_id) index — the UNIQUE(user_id, workspace_id, slug)
-- constraint handles user+workspace lookups via leftmost prefix.
CREATE INDEX idx_resource_metadata_ws_slug_user
  ON public.resource_metadata(workspace_id, slug, user_id)
  INCLUDE (id, type, current_version);

-- FK column indexes — Postgres does NOT auto-index FK columns.
-- Missing indexes cause 10-100x slower JOINs and ON DELETE CASCADE.
-- resource_versions.resource_id is NOT indexed separately — the UNIQUE(resource_id, version)
-- constraint provides an implicit index with resource_id as the leftmost column, which
-- the planner uses for FK CASCADE lookups.
CREATE INDEX idx_resource_metadata_user_id
  ON public.resource_metadata(user_id);

CREATE INDEX idx_resource_versions_user_id
  ON public.resource_versions(user_id);

-- Covers getResource(published: true): ORDER BY version DESC LIMIT 1.
-- INCLUDE (user_id) lets the planner verify RLS filter without heap access.
CREATE INDEX idx_resource_versions_latest
  ON public.resource_versions(resource_id, version DESC)
  INCLUDE (user_id)
  WHERE version IS NOT NULL;

-- ============================================================================
-- Triggers — immutability (versioned rows are append-only)
-- ============================================================================
-- Immutability triggers use "a_" prefix to fire BEFORE timestamp triggers ("b_").
-- Postgres fires same-event BEFORE triggers in alphabetical order by name.
-- Immutability must reject the UPDATE before updated_at() modifies NEW.

-- Reject UPDATE on versioned (non-draft) rows
CREATE FUNCTION _tempest.reject_versioned_row_update()
RETURNS trigger
SET search_path = ''
AS $$
BEGIN
  IF OLD.version IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot update immutable version row (resource_id=%, version=%)', OLD.resource_id, OLD.version;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER a_trg_resource_versions_immutable_update
  BEFORE UPDATE ON public.resource_versions
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.reject_versioned_row_update();

-- Reject resource_id changes on version rows (prevent cross-user reassignment)
CREATE FUNCTION _tempest.reject_resource_id_change()
RETURNS trigger
SET search_path = ''
AS $$
BEGIN
  IF NEW.resource_id IS DISTINCT FROM OLD.resource_id THEN
    RAISE EXCEPTION 'Cannot change resource_id on an existing version row';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER a_trg_resource_versions_immutable_resource_id
  BEFORE UPDATE ON public.resource_versions
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.reject_resource_id_change();

-- Reject DELETE on versioned (non-draft) rows, unless parent resource is being
-- deleted (ON DELETE CASCADE). When the parent resource_metadata row is already
-- gone, the CASCADE delete is allowed — you can't cherry-pick versions to remove,
-- but deleting the entire resource is valid.
CREATE FUNCTION _tempest.reject_versioned_row_delete()
RETURNS trigger
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF OLD.version IS NOT NULL
     AND EXISTS (SELECT 1 FROM public.resource_metadata WHERE id = OLD.resource_id) THEN
    RAISE EXCEPTION 'Cannot delete immutable version row (resource_id=%, version=%)', OLD.resource_id, OLD.version;
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER a_trg_resource_versions_immutable_delete
  BEFORE DELETE ON public.resource_versions
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.reject_versioned_row_delete();

-- ============================================================================
-- Triggers — timestamps
-- ============================================================================
-- "b_" prefix ensures these fire AFTER immutability triggers.

CREATE TRIGGER b_trg_resource_metadata_updated_at
  BEFORE UPDATE ON public.resource_metadata
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.updated_at();

CREATE TRIGGER b_trg_resource_versions_updated_at
  BEFORE UPDATE ON public.resource_versions
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.updated_at();

REVOKE EXECUTE ON FUNCTION _tempest.reject_versioned_row_update() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION _tempest.reject_resource_id_change() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION _tempest.reject_versioned_row_delete() FROM PUBLIC;

-- ============================================================================
-- Security — defense-in-depth REVOKEs
-- ============================================================================

-- These REVOKEs are defense-in-depth. The PRIMARY security boundary is the
-- AST-level function allowlist in validateAgentSql() (~80 functions). Functions
-- like set_config, pg_sleep, pg_advisory_lock are NOT on the allowlist and are
-- rejected at parse time before SQL ever reaches Postgres.
--
-- In Supabase, pg_catalog functions are owned by supabase_admin, and PUBLIC
-- EXECUTE is granted by supabase_admin. Since this migration runs as postgres
-- (not a superuser in Supabase), the REVOKEs silently succeed but only remove
-- postgres-granted ACEs — the supabase_admin-granted ones persist. This is
-- expected and safe because of the AST allowlist + extended query protocol
-- (simple:false) + post-execution verifyAgentContext() check.
--
-- On self-hosted Postgres where the migration runs as a superuser, these
-- REVOKEs work as intended and provide an additional layer.
DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO service_role;
  RAISE NOTICE 'set_config revoked from PUBLIC (effective on self-hosted, no-op on Supabase)';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not revoke set_config from PUBLIC: % — safe because AST allowlist blocks it', SQLERRM;
END $$;

-- ============================================================================
-- Restricted role for agent SQL execution
-- ============================================================================

-- Agent SQL runs in a sandboxed environment: a temp table called `draft`
-- with only the resource's JSONB data/schema. The agent_query role has
-- NO access to any permanent tables — it can only SELECT from the temp table.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_query') THEN
    CREATE ROLE agent_query NOLOGIN NOINHERIT;
  END IF;
END $$;

-- agent_query has NO schema grants — it can only access pg_temp (temp tables)
-- and pg_catalog (built-in functions/types like jsonb_agg, ::int casts).

-- Revoke TEMP privilege — agent cannot create its own temp tables.
-- The adapter creates the `draft` temp table as `authenticated` before
-- switching to agent_query, so this privilege is not needed.
DO $$ BEGIN
  EXECUTE format('REVOKE TEMP ON DATABASE %I FROM agent_query', current_database());
EXCEPTION WHEN OTHERS THEN
  RAISE EXCEPTION 'CRITICAL: Could not revoke TEMP from agent_query: %. Without this REVOKE, agent SQL can create temp tables and shadow the adapter-provided draft table. Run this migration as supabase_admin (Supabase) or a superuser (self-hosted).', SQLERRM;
END $$;

-- Revoke dangerous pg_catalog functions (defense-in-depth, see note above).
-- On Supabase these are no-ops; on self-hosted they provide an additional layer.
DO $$ BEGIN
  -- Advisory locks (non-try)
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock_shared(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock_shared(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock_shared(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock_shared(int, int) FROM PUBLIC;
  -- Advisory locks (try variants)
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock_shared(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock_shared(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock_shared(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock_shared(int, int) FROM PUBLIC;
  -- Advisory unlock
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_shared(bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_shared(int, int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_all() FROM PUBLIC;
  -- Notify and sleep (all three sleep variants: pg_sleep, pg_sleep_for, pg_sleep_until)
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_notify(text, text) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_for(interval) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION pg_catalog.pg_sleep_until(timestamp with time zone) FROM PUBLIC;

  -- Re-grant to roles that need them
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock_shared(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_lock_shared(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock_shared(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_xact_lock_shared(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock_shared(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_lock_shared(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock_shared(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_try_advisory_xact_lock_shared(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_shared(bigint) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_shared(int, int) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_advisory_unlock_all() TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_notify(text, text) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep(double precision) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep_for(interval) TO postgres;
  GRANT EXECUTE ON FUNCTION pg_catalog.pg_sleep_until(timestamp with time zone) TO postgres;

  RAISE NOTICE 'Advisory locks, pg_notify, and pg_sleep revoked from PUBLIC (effective on self-hosted, no-op on Supabase)';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not revoke dangerous functions: % — safe because AST allowlist blocks them', SQLERRM;
END $$;

-- Revoke SELECT on system catalog views (defense-in-depth, see note above).
-- On Supabase these are no-ops; on self-hosted they provide an additional layer.
DO $$ BEGIN
  REVOKE SELECT ON pg_catalog.pg_stat_activity FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_roles FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_settings FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_user FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_shadow FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_auth_members FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_proc FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_class FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_namespace FROM PUBLIC;
  REVOKE SELECT ON pg_catalog.pg_attribute FROM PUBLIC;

  GRANT SELECT ON pg_catalog.pg_stat_activity TO postgres;
  GRANT SELECT ON pg_catalog.pg_roles TO postgres;
  GRANT SELECT ON pg_catalog.pg_settings TO postgres;
  GRANT SELECT ON pg_catalog.pg_user TO postgres;
  GRANT SELECT ON pg_catalog.pg_shadow TO postgres;
  GRANT SELECT ON pg_catalog.pg_auth_members TO postgres;
  GRANT SELECT ON pg_catalog.pg_proc TO postgres;
  GRANT SELECT ON pg_catalog.pg_class TO postgres;
  GRANT SELECT ON pg_catalog.pg_namespace TO postgres;
  GRANT SELECT ON pg_catalog.pg_attribute TO postgres;

  -- service_role needs catalog access for PostgREST schema introspection.
  -- Without these, Supabase API returns 500 on schema cache refresh.
  GRANT SELECT ON pg_catalog.pg_stat_activity TO service_role;
  GRANT SELECT ON pg_catalog.pg_roles TO service_role;
  GRANT SELECT ON pg_catalog.pg_settings TO service_role;
  GRANT SELECT ON pg_catalog.pg_proc TO service_role;
  GRANT SELECT ON pg_catalog.pg_class TO service_role;
  GRANT SELECT ON pg_catalog.pg_namespace TO service_role;
  GRANT SELECT ON pg_catalog.pg_attribute TO service_role;

  RAISE NOTICE 'System catalog views revoked from PUBLIC (effective on self-hosted, no-op on Supabase)';
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Could not revoke system catalog views: % — safe because AST allowlist blocks catalog access', SQLERRM;
END $$;

-- Session user (postgres / service_role) must be able to SET LOCAL ROLE agent_query.
GRANT agent_query TO postgres;
DO $$ BEGIN
  GRANT agent_query TO service_role;
EXCEPTION WHEN undefined_object THEN
  NULL; -- service_role doesn't exist (standalone Postgres)
END $$;

-- ============================================================================
-- RLS
-- ============================================================================

ALTER TABLE public.resource_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_metadata FORCE ROW LEVEL SECURITY;
ALTER TABLE public.resource_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.resource_versions FORCE ROW LEVEL SECURITY;

-- Grant permissions to authenticated role
GRANT USAGE ON TYPE public.resource_type TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.resource_metadata TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.resource_versions TO authenticated;

-- ============================================================================
-- RLS policies — resource_metadata
-- ============================================================================

-- RESTRICTIVE baseline: users can ONLY access their own rows (safety net).
-- The IS NOT NULL guard ensures that an unset request.user_id (returns NULL
-- from current_setting with missing_ok=true) always denies access rather than
-- relying on NULL != value being falsy — documents intent explicitly.
CREATE POLICY "resource_metadata_user_isolation" ON public.resource_metadata
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  )
  WITH CHECK (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  );

CREATE POLICY "resource_metadata_select" ON public.resource_metadata
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "resource_metadata_insert" ON public.resource_metadata
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "resource_metadata_update" ON public.resource_metadata
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "resource_metadata_delete" ON public.resource_metadata
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));

-- ============================================================================
-- RLS policies — resource_versions
-- ============================================================================

CREATE POLICY "resource_versions_user_isolation" ON public.resource_versions
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  )
  WITH CHECK (
    (SELECT current_setting('request.user_id', true)) IS NOT NULL
    AND user_id = (SELECT current_setting('request.user_id', true))
  );

CREATE POLICY "resource_versions_select" ON public.resource_versions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));

-- INSERT must also verify the referenced resource belongs to the inserting user.
-- Without this, a malicious authenticated user could insert version rows referencing
-- another user's resource_id (with their own user_id), creating orphaned data.
CREATE POLICY "resource_versions_insert" ON public.resource_versions
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (
    user_id = (SELECT current_setting('request.user_id', true))
    AND EXISTS (
      SELECT 1 FROM public.resource_metadata
      WHERE id = resource_id
        AND user_id = (SELECT current_setting('request.user_id', true))
    )
  );

CREATE POLICY "resource_versions_update" ON public.resource_versions
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)))
  WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "resource_versions_delete" ON public.resource_versions
  AS PERMISSIVE FOR DELETE TO authenticated
  USING (user_id = (SELECT current_setting('request.user_id', true)));
