-- Minimal DDL for SQLC codegen only. This is never executed.
-- Mirrors the real LiteLLM_VerificationToken schema for columns we query.
CREATE TABLE "LiteLLM_VerificationToken" (
    token TEXT NOT NULL PRIMARY KEY,
    key_alias TEXT,
    spend DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    max_budget DOUBLE PRECISION
);
