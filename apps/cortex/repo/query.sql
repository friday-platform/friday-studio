-- Cortex object storage queries

-- name: CreateObject :one
INSERT INTO cortex.object (user_id, content_size, metadata)
VALUES ($1, $2, $3)
RETURNING id;

-- name: GetObjectForUser :one
SELECT id, user_id, content_size, metadata, created_at, updated_at, deleted_at
FROM cortex.object
WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL;

-- name: UpdateMetadata :exec
UPDATE cortex.object
SET metadata = $2
WHERE id = $1 AND deleted_at IS NULL;

-- name: UpdateContentSize :exec
UPDATE cortex.object
SET content_size = $2
WHERE id = $1 AND deleted_at IS NULL;

-- name: DeleteObject :exec
DELETE FROM cortex.object WHERE id = $1 AND deleted_at IS NULL;

-- name: ListObjects :many
SELECT id, user_id, content_size, metadata, created_at, updated_at, deleted_at
FROM cortex.object
WHERE user_id = $1
  AND deleted_at IS NULL
  AND (sqlc.narg('workspace_id')::text IS NULL OR metadata->>'workspace_id' = sqlc.narg('workspace_id'))
  AND (sqlc.narg('chat_id')::text IS NULL OR metadata->>'chat_id' = sqlc.narg('chat_id'))
ORDER BY created_at DESC
LIMIT sqlc.arg('limit')
OFFSET sqlc.arg('offset');

-- name: ListObjectsWithMetadataFilter :many
SELECT id, user_id, content_size, metadata, created_at, updated_at, deleted_at
FROM cortex.object
WHERE user_id = sqlc.arg('user_id')
  AND deleted_at IS NULL
  AND (sqlc.narg('metadata')::jsonb IS NULL OR metadata @> sqlc.narg('metadata'))
ORDER BY
  created_at DESC,
  -- Defensive ordering: if multiple revisions are marked is_latest (during migration or race),
  -- return the highest revision number first. COALESCE handles NULL/invalid revision fields.
  COALESCE((metadata->>'revision')::int, -1) DESC NULLS LAST
LIMIT sqlc.arg('limit')
OFFSET sqlc.arg('offset');
