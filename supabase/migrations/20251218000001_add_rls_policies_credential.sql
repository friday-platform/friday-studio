-- Migration: Add RLS policies for public.credential and public.llm_virtualkey
--
-- Context:
-- - public.credential stores encrypted API keys, OAuth tokens, and other secrets
-- - Previously used service role which bypasses RLS
-- - Services use SET LOCAL ROLE authenticated within transactions
-- - Enforces user isolation at database level via request.user_id session variable
--
-- Related: TEM-3397, TEM-3398

-- ============================================================================
-- 1. Grant necessary permissions to authenticated role
-- ============================================================================

-- Table access: public.credential (no hard delete - soft delete via UPDATE)
GRANT SELECT, INSERT, UPDATE ON TABLE public.credential TO authenticated;

-- Type access: credential_type enum
GRANT USAGE ON TYPE public.credential_type TO authenticated;

-- ============================================================================
-- 2. Add RLS policies for user isolation
-- ============================================================================

-- RESTRICTIVE baseline: users can ONLY access their own rows (safety net)
-- This ensures no future PERMISSIVE policy can bypass user isolation
CREATE POLICY "credential_user_isolation" ON public.credential
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = current_setting('request.user_id', true))
    WITH CHECK (user_id = current_setting('request.user_id', true));

-- PERMISSIVE grants for specific operations
CREATE POLICY "credential_select" ON public.credential
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = current_setting('request.user_id', true));

CREATE POLICY "credential_insert" ON public.credential
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = current_setting('request.user_id', true));

CREATE POLICY "credential_update" ON public.credential
    AS PERMISSIVE FOR UPDATE TO authenticated
    USING (user_id = current_setting('request.user_id', true))
    WITH CHECK (user_id = current_setting('request.user_id', true));

-- RESTRICTIVE baseline for llm_virtualkey
CREATE POLICY "llm_virtualkey_user_isolation" ON public.llm_virtualkey
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = current_setting('request.user_id', true))
    WITH CHECK (user_id = current_setting('request.user_id', true));

-- PERMISSIVE grant for SELECT (writes use service_role)
CREATE POLICY "llm_virtualkey_select" ON public.llm_virtualkey
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = current_setting('request.user_id', true));
