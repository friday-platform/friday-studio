-- The ON CONFLICT DO UPDATE in StoreSuppression requires UPDATE privilege.
-- The previous migration only granted SELECT, INSERT, DELETE.
GRANT UPDATE ON TABLE gateway.email_suppressions TO authenticated;

CREATE POLICY "suppression_update" ON gateway.email_suppressions
    AS PERMISSIVE FOR UPDATE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));
