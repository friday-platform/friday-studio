-- Create cypher schema for encryption key storage
CREATE SCHEMA IF NOT EXISTS cypher;

-- Create keyset table for user encryption keys
-- Each user has exactly one encryption keyset (encrypted with KMS master key)
CREATE TABLE cypher.keyset (
    id TEXT PRIMARY KEY DEFAULT _tempest.shortid(),
    user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    key_set BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE(user_id)  -- One key per user
);

CREATE TRIGGER trigger_update_updated_at_cypher_keyset
    BEFORE UPDATE ON cypher.keyset
    FOR EACH ROW
    EXECUTE FUNCTION _tempest.updated_at();

-- Note: UNIQUE(user_id) already creates an index, no separate index needed

-- Enable RLS (defense in depth - even if someone gets DB access)
ALTER TABLE cypher.keyset ENABLE ROW LEVEL SECURITY;
ALTER TABLE cypher.keyset FORCE ROW LEVEL SECURITY;

-- No policies for anon/authenticated = no access
-- Service role bypasses RLS by default, which is what we want

-- Lock down schema from anon/authenticated roles
ALTER DEFAULT PRIVILEGES IN SCHEMA cypher REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA cypher REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA cypher REVOKE ALL ON TABLES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA cypher REVOKE ALL ON FUNCTIONS FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA cypher REVOKE ALL ON SEQUENCES FROM authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA cypher REVOKE ALL ON TABLES FROM authenticated;

REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA cypher FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA cypher FROM anon;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA cypher FROM anon;
REVOKE ALL PRIVILEGES ON SCHEMA cypher FROM anon;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA cypher FROM authenticated;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA cypher FROM authenticated;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA cypher FROM authenticated;
REVOKE ALL PRIVILEGES ON SCHEMA cypher FROM authenticated;
