-- Migration: Add RLS policies for cypher.keyset with dedicated application role
--
-- Context:
-- - cypher.keyset stores KMS-encrypted user encryption keys
-- - Previously used service role which bypasses RLS
-- - This migration creates cypher_app role that respects RLS policies
-- - Enforces user isolation at database level via request.user_id session variable
--
-- Related: TEM-3398, TEM-3397
-- ============================================================================
-- 1. Grant necessary permissions to authenticated role
-- ============================================================================

-- Schema access
GRANT USAGE ON SCHEMA cypher TO authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA _tempest TO authenticated;

-- Table access: cypher.keyset (read + create only, keys are immutable)
GRANT SELECT, INSERT ON TABLE cypher.keyset TO authenticated;

-- Table access: public.user (read-only, for FK validation)
GRANT SELECT ON TABLE public."user" TO authenticated;

-- Table access: public.llm_virtualkey (read-only, used by GetVirtualKeyCiphertext query)
GRANT SELECT ON TABLE public.llm_virtualkey TO authenticated;

-- Function access: needed for DEFAULT shortid() and trigger
GRANT EXECUTE ON FUNCTION _tempest.shortid() TO authenticated;
GRANT EXECUTE ON FUNCTION _tempest.updated_at() TO authenticated;

-- Sequence access: none needed (shortid() doesn't use sequences)

-- ============================================================================
-- 2. Add RLS policies for user isolation
-- ============================================================================

-- RESTRICTIVE baseline: users can ONLY access their own rows (safety net)
-- This ensures no future PERMISSIVE policy can bypass user isolation
CREATE POLICY "keyset_user_isolation" ON cypher.keyset
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = current_setting('request.user_id', true))
    WITH CHECK (user_id = current_setting('request.user_id', true));

-- PERMISSIVE grants for specific operations
CREATE POLICY "keyset_select" ON cypher.keyset
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = current_setting('request.user_id', true));

CREATE POLICY "keyset_insert" ON cypher.keyset
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = current_setting('request.user_id', true));

-- RESTRICTIVE baseline for public.user
CREATE POLICY "user_isolation" ON public."user"
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (id = current_setting('request.user_id', true))
    WITH CHECK (id = current_setting('request.user_id', true));

-- PERMISSIVE grant for SELECT
CREATE POLICY "user_select_self" ON public."user"
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (id = current_setting('request.user_id', true));
