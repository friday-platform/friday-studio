-- Add display_name column for custom credential labels
-- Nullable - existing rows stay NULL, user sets via PATCH endpoint
ALTER TABLE public.credential ADD COLUMN IF NOT EXISTS display_name TEXT;
