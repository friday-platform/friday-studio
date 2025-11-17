-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS pg_hashids;

-- Create _tempest schema for common helper functions
CREATE SCHEMA IF NOT EXISTS _tempest;

/*
_tempest.shortid() is a helper function that generates a unique short id for a record.
This function is used to encode a bigint into a hashid. The implementation can
be replaced here if needed.
*/
CREATE OR REPLACE FUNCTION _tempest.shortid() RETURNS text AS $$
DECLARE
    random_bigint bigint;
    encoded_id text;
BEGIN
    -- Generate a new unique bigint, simulating serial behavior
    SELECT ('x' || encode(extensions.gen_random_bytes(8), 'hex'))::bit(64)::bigint INTO random_bigint;

    -- Encode this bigint
    SELECT public.id_encode(random_bigint, '13E438DD-9C00-4D3A-BE82-EDC753C9EA41', 10) INTO encoded_id;
    RETURN encoded_id;
END;
$$ LANGUAGE plpgsql;

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
$$ LANGUAGE plpgsql;

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
  name TEXT GENERATED ALWAYS AS (
    CASE
      WHEN display_name = '' THEN full_name
      ELSE display_name
    END
  ) STORED
);
