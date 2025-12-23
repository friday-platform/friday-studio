-- Create cortex schema for object storage with flexible metadata
CREATE SCHEMA IF NOT EXISTS cortex;

-- Ensure uuid-ossp extension is enabled for uuid_generate_v1mc()
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Ensure soft_delete function exists (generic version that works for any table)
CREATE OR REPLACE FUNCTION _tempest.soft_delete()
RETURNS trigger
SECURITY DEFINER
AS $$
BEGIN
    IF OLD.deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'Record is already deleted';
    END IF;

    -- Set the deleted_at column to the current date and time
    EXECUTE FORMAT('UPDATE %I.%I SET deleted_at = now() WHERE id = %L', TG_TABLE_SCHEMA, TG_TABLE_NAME, OLD.id);

    -- Return NULL to prevent the deletion
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Create object table for storing blob metadata and references
CREATE TABLE cortex.object (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v1mc(),
    user_id TEXT NOT NULL REFERENCES public."user"(id) ON DELETE CASCADE,
    content_size BIGINT,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at TIMESTAMPTZ
);

-- Auto-update updated_at timestamp
CREATE TRIGGER trigger_update_updated_at_cortex_object
    BEFORE UPDATE ON cortex.object
    FOR EACH ROW
    EXECUTE FUNCTION _tempest.updated_at();

-- Indexes for common query patterns
CREATE INDEX idx_cortex_object_user ON cortex.object(user_id);
CREATE INDEX idx_cortex_object_workspace ON cortex.object ((metadata->>'workspace_id')) WHERE metadata->>'workspace_id' IS NOT NULL;
CREATE INDEX idx_cortex_object_chat ON cortex.object ((metadata->>'chat_id')) WHERE metadata->>'chat_id' IS NOT NULL;
CREATE INDEX idx_cortex_object_metadata ON cortex.object USING GIN (metadata);
CREATE INDEX idx_cortex_object_active ON cortex.object(id) WHERE deleted_at IS NULL;

-- Enable RLS
ALTER TABLE cortex.object ENABLE ROW LEVEL SECURITY;
ALTER TABLE cortex.object FORCE ROW LEVEL SECURITY;

-- ============================================================================
-- Grant permissions to authenticated role
-- ============================================================================

-- Schema access
GRANT USAGE ON SCHEMA cortex TO authenticated;

-- Table access (DELETE triggers soft delete via _tempest.soft_delete)
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE cortex.object TO authenticated;

-- Lock down from anon role
ALTER DEFAULT PRIVILEGES IN SCHEMA cortex REVOKE ALL ON FUNCTIONS FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA cortex REVOKE ALL ON SEQUENCES FROM anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA cortex REVOKE ALL ON TABLES FROM anon;

REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA cortex FROM anon;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA cortex FROM anon;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA cortex FROM anon;
REVOKE ALL PRIVILEGES ON SCHEMA cortex FROM anon;

-- ============================================================================
-- Soft delete trigger (converts DELETE to UPDATE deleted_at)
-- ============================================================================

CREATE TRIGGER object_soft_delete
BEFORE DELETE ON cortex.object
FOR EACH ROW
EXECUTE FUNCTION _tempest.soft_delete();

-- ============================================================================
-- RLS policies for user isolation
-- ============================================================================

-- RESTRICTIVE baseline: users can ONLY access their own rows (safety net)
-- This ensures no future PERMISSIVE policy can bypass user isolation
CREATE POLICY "object_user_isolation" ON cortex.object
    AS RESTRICTIVE FOR ALL TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

-- PERMISSIVE grants for specific operations
CREATE POLICY "object_select" ON cortex.object
    AS PERMISSIVE FOR SELECT TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "object_insert" ON cortex.object
    AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "object_update" ON cortex.object
    AS PERMISSIVE FOR UPDATE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)))
    WITH CHECK (user_id = (SELECT current_setting('request.user_id', true)));

CREATE POLICY "object_delete" ON cortex.object
    AS PERMISSIVE FOR DELETE TO authenticated
    USING (user_id = (SELECT current_setting('request.user_id', true)));
