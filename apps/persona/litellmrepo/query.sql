-- name: GetKeyUsage :one
SELECT COALESCE(spend, 0)::float8 AS spend,
       COALESCE(max_budget, 0)::float8 AS max_budget
FROM "LiteLLM_VerificationToken"
WHERE key_alias = $1;
