-- Create table to store encrypted LiteLLM virtual keys per user
CREATE TABLE IF NOT EXISTS public.llm_virtualkey (
    user_id TEXT PRIMARY KEY REFERENCES public."user"(id) ON DELETE CASCADE,
    ciphertext BYTEA NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trigger_update_updated_at_public_llm_virtualkey
    BEFORE UPDATE ON public.llm_virtualkey
    FOR EACH ROW
    EXECUTE FUNCTION _tempest.updated_at();
