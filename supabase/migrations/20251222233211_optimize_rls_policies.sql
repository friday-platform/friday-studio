-- Optimize RLS policies to evaluate current_setting() once per query
--
-- Issue: current_setting() without SELECT wrapper is re-evaluated for each row
-- Fix: Wrap in (SELECT ...) to cache the value for the query duration
-- See: https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select

-- ============================================================================
-- cypher.keyset policies
-- ============================================================================

DROP POLICY "keyset_user_isolation" ON cypher.keyset;
CREATE POLICY "keyset_user_isolation" ON cypher.keyset
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

DROP POLICY "keyset_select" ON cypher.keyset;
CREATE POLICY "keyset_select" ON cypher.keyset
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

DROP POLICY "keyset_insert" ON cypher.keyset;
CREATE POLICY "keyset_insert" ON cypher.keyset
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- ============================================================================
-- public.user policies
-- ============================================================================

DROP POLICY "user_isolation" ON public."user";
CREATE POLICY "user_isolation" ON public."user"
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (id = (SELECT current_setting('request.user_id', true)));

DROP POLICY "user_select_self" ON public."user";
CREATE POLICY "user_select_self" ON public."user"
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (id = (SELECT current_setting('request.user_id', true)));

-- ============================================================================
-- public.credential policies
-- ============================================================================

DROP POLICY "credential_user_isolation" ON public.credential;
CREATE POLICY "credential_user_isolation" ON public.credential
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

DROP POLICY "credential_select" ON public.credential;
CREATE POLICY "credential_select" ON public.credential
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

DROP POLICY "credential_insert" ON public.credential;
CREATE POLICY "credential_insert" ON public.credential
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

DROP POLICY "credential_update" ON public.credential;
CREATE POLICY "credential_update" ON public.credential
    AS PERMISSIVE FOR UPDATE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- ============================================================================
-- public.llm_virtualkey policies
-- ============================================================================

DROP POLICY "llm_virtualkey_user_isolation" ON public.llm_virtualkey;
CREATE POLICY "llm_virtualkey_user_isolation" ON public.llm_virtualkey
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

DROP POLICY "llm_virtualkey_select" ON public.llm_virtualkey;
CREATE POLICY "llm_virtualkey_select" ON public.llm_virtualkey
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));
