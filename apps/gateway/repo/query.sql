-- Gateway email suppression queries

-- name: IsEmailSuppressed :one
SELECT EXISTS(
    SELECT 1 FROM gateway.email_suppressions
    WHERE email = $1 AND workspace_id = $2
);

-- name: StoreSuppression :exec
INSERT INTO gateway.email_suppressions (email, workspace_id)
VALUES ($1, $2)
ON CONFLICT DO NOTHING;
