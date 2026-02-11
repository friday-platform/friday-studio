-- Clear any pre-audit rows — they lack user_id and can't be backfilled.
-- Table was created in 20260210100000, no production suppressions exist yet.
DELETE FROM gateway.email_suppressions;

-- Add audit columns
ALTER TABLE gateway.email_suppressions
    ADD COLUMN user_id   TEXT NOT NULL DEFAULT (current_setting('request.user_id', true)) REFERENCES public."user"(id) ON DELETE CASCADE,
    ADD COLUMN remote_ip TEXT NOT NULL DEFAULT '';

-- Enable RLS (defense-in-depth; gateway connects as superuser).
-- Using ENABLE without FORCE so the superuser can still run cross-user
-- suppression checks (isEmailSuppressed) without setting a role context.
ALTER TABLE gateway.email_suppressions ENABLE ROW LEVEL SECURITY;

-- Grant authenticated role access to gateway schema and table
GRANT USAGE ON SCHEMA gateway TO authenticated;
GRANT SELECT, INSERT, DELETE ON TABLE gateway.email_suppressions TO authenticated;

-- Revoke anon access
REVOKE ALL ON SCHEMA gateway FROM anon;
REVOKE ALL ON ALL TABLES IN SCHEMA gateway FROM anon;

-- Restrictive baseline: authenticated users can only access their own rows
CREATE POLICY "suppression_user_isolation" ON gateway.email_suppressions
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- Permissive policies per operation
CREATE POLICY "suppression_select" ON gateway.email_suppressions
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "suppression_insert" ON gateway.email_suppressions
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "suppression_delete" ON gateway.email_suppressions
    AS PERMISSIVE FOR DELETE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));
