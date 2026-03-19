-- Add is_default column to credential table for multi-credential support.
-- Business rule: "oldest-wins" — the oldest credential per (user_id, provider)
-- becomes the default during backfill, determined by created_at ASC, id ASC.

-- 1. Add column
ALTER TABLE public.credential
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- 2. Partial unique index: at most one default per provider per user (active only)
CREATE UNIQUE INDEX IF NOT EXISTS idx_credential_default_per_provider
    ON public.credential (user_id, provider)
    WHERE is_default = true AND deleted_at IS NULL;

-- 3. Backfill: set is_default = true for the oldest credential per (user_id, provider).
-- Uses DISTINCT ON to pick the first row per group, ordered by created_at ASC, id ASC
-- as a deterministic tiebreaker when timestamps collide.
UPDATE public.credential AS c
SET is_default = true
FROM (
    SELECT DISTINCT ON (user_id, provider) id
    FROM public.credential
    WHERE deleted_at IS NULL
    ORDER BY user_id, provider, created_at ASC, id ASC
) AS oldest
WHERE c.id = oldest.id
  AND c.deleted_at IS NULL
  AND c.is_default = false;
