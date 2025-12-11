-- Development seed data
-- Run with: supabase db reset (applies migrations then seeds)

-- Dev user for local testing
INSERT INTO public."user" (id, full_name, email)
VALUES ('dev', 'Dev User', 'dev@test.local')
ON CONFLICT (id) DO NOTHING;
