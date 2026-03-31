-- Migration: Grant UPDATE on mutable profile columns for public.user
--
-- Context:
-- - Users need to update their own profile (full_name, display_name, profile_photo)
-- - RLS is already enforced via user_isolation (RESTRICTIVE FOR ALL)
-- - Only the column-level GRANT is missing
--
-- Related: TEM-3584

-- Grant UPDATE on mutable profile columns only
GRANT UPDATE (full_name, display_name, profile_photo) ON TABLE public."user" TO authenticated;
