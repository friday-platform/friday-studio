-- name: GetKeysetByUserID :one
SELECT * FROM cypher.keyset WHERE user_id = $1;

-- name: CreateKeyset :one
INSERT INTO cypher.keyset (user_id, key_set)
VALUES ($1, $2)
RETURNING *;
