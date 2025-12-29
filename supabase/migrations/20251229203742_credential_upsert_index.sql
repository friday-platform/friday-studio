-- Partial unique index for upsert ON CONFLICT clause
-- Excludes soft-deleted credentials (deleted_at IS NOT NULL)
CREATE UNIQUE INDEX IF NOT EXISTS credential_user_provider_label_active_idx
ON public.credential (user_id, provider, label)
WHERE deleted_at IS NULL;
