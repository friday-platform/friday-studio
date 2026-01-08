-- Add user_identifier column to store OAuth user identity (email, sub, or account ID)
ALTER TABLE public.credential ADD COLUMN IF NOT EXISTS user_identifier TEXT;
