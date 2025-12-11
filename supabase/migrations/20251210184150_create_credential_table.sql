-- Create credential table for encrypted user credentials
-- Used by Link service for storing API keys, OAuth tokens, etc.

CREATE TYPE public.credential_type AS ENUM ('apikey', 'oauth');

CREATE TABLE public.credential (
    id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
    user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    type public.credential_type NOT NULL,
    provider TEXT NOT NULL,
    label TEXT NOT NULL,
    encrypted_secret TEXT NOT NULL,  -- base64 ciphertext from Cypher service
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ  -- soft delete timestamp, NULL = active
);

CREATE TRIGGER trigger_update_updated_at_credential
    BEFORE UPDATE ON public.credential
    FOR EACH ROW
    EXECUTE FUNCTION _tempest.updated_at();

-- Indexes
CREATE INDEX idx_credential_user_id ON public.credential(user_id);
CREATE INDEX idx_credential_user_type ON public.credential(user_id, type);

-- RLS
ALTER TABLE public.credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.credential FORCE ROW LEVEL SECURITY;

-- No policies = no access for anon/authenticated
-- Service role bypasses RLS, which is what Link service uses
