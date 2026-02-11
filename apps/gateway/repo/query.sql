-- Gateway email suppression queries

-- name: IsEmailSuppressed :one
SELECT EXISTS(
    SELECT 1 FROM gateway.email_suppressions
    WHERE email = $1 AND workspace_id = $2
);

-- name: StoreSuppression :exec
INSERT INTO gateway.email_suppressions (email, workspace_id, remote_ip)
VALUES ($1, $2, $3)
ON CONFLICT (email, workspace_id) DO UPDATE
    SET user_id   = current_setting('request.user_id', true),
        remote_ip = EXCLUDED.remote_ip;
