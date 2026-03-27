-- Make user_id NOT NULL on activities table.
-- userId is required for RLS policies to enforce user isolation.
-- The `source` column already distinguishes agent vs user-initiated activity.

-- Remove any orphaned rows with NULL user_id (created before this fix)
DELETE FROM public.activities WHERE user_id IS NULL;

-- Add NOT NULL constraint
ALTER TABLE public.activities ALTER COLUMN user_id SET NOT NULL;
