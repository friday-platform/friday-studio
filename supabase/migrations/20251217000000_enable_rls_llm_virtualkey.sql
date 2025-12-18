-- Enable RLS on llm_virtualkey table
-- This table stores encrypted LiteLLM virtual keys per user
-- Service role (used by atlas-operator and cypher) bypasses RLS
-- No policies = no access for anon/authenticated roles

ALTER TABLE public.llm_virtualkey ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.llm_virtualkey FORCE ROW LEVEL SECURITY;
