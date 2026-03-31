-- Migration: Add updated_at to the column-scoped UPDATE grant on public.user
--
-- Context:
-- - The UpdateUser query sets updated_at = now(), but the prior grant
--   (20260330000000) only allowed full_name, display_name, profile_photo
-- - PostgreSQL column-level GRANT is strict: unlisted columns are denied
--
-- Related: TEM-3584

-- Revoke the incomplete grant and re-grant with updated_at included
REVOKE UPDATE ON TABLE public."user" FROM authenticated;
GRANT UPDATE (full_name, display_name, profile_photo, updated_at) ON TABLE public."user" TO authenticated;

-- Add permissive UPDATE policy — the existing user_isolation (RESTRICTIVE FOR ALL)
-- constrains to own row, but RLS requires at least one permissive policy per
-- operation type to grant access. Only user_select_self (SELECT) existed.
CREATE POLICY "user_update_self" ON public."user"
    AS PERMISSIVE FOR UPDATE TO authenticated
    USING (id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (id = (SELECT current_setting('request.user_id', true)));
