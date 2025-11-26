-- Enable required extensions in extensions schema
CREATE EXTENSION IF NOT EXISTS pg_hashids WITH SCHEMA extensions;

-- Create _tempest schema for common helper functions
CREATE SCHEMA IF NOT EXISTS _tempest;

/*
_tempest.shortid() generates a unique short ID using lowercase alphanumeric characters.
Lowercase-only alphabet ensures RFC 1123 compliance for Kubernetes resource names.
*/
CREATE OR REPLACE FUNCTION _tempest.shortid() RETURNS text AS $$
DECLARE
    random_bigint bigint;
    encoded_id text;
BEGIN
    SELECT ('x' || encode(extensions.gen_random_bytes(8), 'hex'))::bit(64)::bigint INTO random_bigint;
    SELECT extensions.id_encode(
        random_bigint,
        '13E438DD-9C00-4D3A-BE82-EDC753C9EA41',
        10,
        'abcdefghijklmnopqrstuvwxyz0123456789'
    ) INTO encoded_id;
    RETURN encoded_id;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

/*
_tempest.updated_at() is a trigger function that sets the updated_at column to the
current date and time
*/
CREATE OR REPLACE FUNCTION _tempest.updated_at()
RETURNS trigger AS $$
BEGIN
    -- Check if the row is actually being updated to prevent unnecessary updates
    IF ROW(NEW.*) IS DISTINCT FROM ROW(OLD.*) THEN
        -- Set updated_at to the current date and time
        NEW.updated_at := now();
    END IF;
    -- Return the modified NEW row to apply the update
    RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = '';

-- Create bounce schema for authentication
CREATE SCHEMA IF NOT EXISTS bounce;

-- Create bounce enum types
CREATE TYPE bounce_identity_provider AS ENUM ('google');
CREATE TYPE bounce_otp_use AS ENUM ('magiclink', 'emailconfirm', 'oauthstate', 'csrf');

-- Create auth_user table
CREATE TABLE bounce.auth_user (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  email TEXT NOT NULL UNIQUE,
  email_confirmed BOOLEAN NOT NULL DEFAULT false,
  email_confirmed_at TIMESTAMPTZ,
  confirmation_token TEXT,
  confirmation_sent_at TIMESTAMPTZ
);

CREATE TRIGGER trigger_update_updated_at_auth_user
  BEFORE UPDATE ON bounce.auth_user
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.updated_at();

-- Create identity table for OAuth providers
CREATE TABLE bounce.identity (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  auth_user_id TEXT REFERENCES bounce.auth_user(id),
  email TEXT NOT NULL,
  last_sign_in_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider bounce_identity_provider NOT NULL,
  provider_id TEXT NOT NULL,
  provider_app_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  provider_user_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (provider, email),
  UNIQUE (provider, provider_id, email)
);

CREATE TRIGGER trigger_update_updated_at_identity
  BEFORE UPDATE ON bounce.identity
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.updated_at();

-- Create OTP table
CREATE TABLE bounce.otp (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  token TEXT NOT NULL UNIQUE,
  auth_user_id TEXT REFERENCES bounce.auth_user(id),
  created_at TIMESTAMPTZ NOT NULL,
  not_valid_after TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  use bounce_otp_use NOT NULL
);

-- Create user table in public schema
CREATE TABLE IF NOT EXISTS public."user" (
  id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
  bounce_auth_user_id TEXT REFERENCES bounce.auth_user(id),
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  display_name TEXT NOT NULL DEFAULT '',
  profile_photo TEXT NOT NULL DEFAULT '',
  pool_available BOOLEAN NOT NULL DEFAULT false,
  name TEXT GENERATED ALWAYS AS (
    CASE
      WHEN display_name = '' THEN full_name
      ELSE display_name
    END
  ) STORED
);

CREATE TRIGGER trigger_update_updated_at_user
  BEFORE UPDATE ON public."user"
  FOR EACH ROW
  EXECUTE FUNCTION _tempest.updated_at();

-- Indexes for bounce schema
CREATE INDEX idx_auth_user_confirmation_token ON bounce.auth_user (confirmation_token) WHERE confirmation_token IS NOT NULL;
CREATE INDEX idx_otp_auth_user_magiclink ON bounce.otp (auth_user_id, use) WHERE used_at IS NULL;

-- Indexes for public.user
CREATE INDEX idx_user_bounce_auth_user_id ON public."user" (bounce_auth_user_id) WHERE bounce_auth_user_id IS NOT NULL;
CREATE INDEX idx_pool_users_available ON public."user" (created_at ASC) WHERE pool_available = true;

-- Lock down all access from anon role
-- This prevents unauthorized access via Supabase's REST API
-- Service role retains full access

-- Revoke default privileges for future objects
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA bounce REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA bounce REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA bounce REVOKE ALL ON TABLES FROM anon;

-- Revoke all existing privileges from anon
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM anon;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA bounce FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA bounce FROM anon;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA bounce FROM anon;
REVOKE ALL PRIVILEGES ON SCHEMA bounce FROM anon;

-- Also revoke from authenticated (only service role should access these tables)
REVOKE ALL ON SCHEMA bounce FROM authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA bounce FROM authenticated;
REVOKE ALL ON public."user" FROM authenticated;

-- Enable RLS on public.user
ALTER TABLE public."user" ENABLE ROW LEVEL SECURITY;

-- Disable OpenAPI introspection for security
ALTER ROLE anon SET pgrst.openapi_mode TO 'disabled';
ALTER ROLE authenticated SET pgrst.openapi_mode TO 'disabled';
NOTIFY pgrst, 'reload config';
