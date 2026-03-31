-- name: GetUserByID :one
SELECT
    id,
    full_name,
    email,
    created_at,
    updated_at,
    display_name,
    profile_photo,
    name
FROM "user"
WHERE id = $1;

-- name: UpdateUser :one
UPDATE "user"
SET
    full_name = COALESCE(sqlc.narg('full_name'), full_name),
    display_name = COALESCE(sqlc.narg('display_name'), display_name),
    profile_photo = COALESCE(sqlc.narg('profile_photo'), profile_photo),
    updated_at = now()
WHERE id = $1
RETURNING id, full_name, email, created_at, updated_at, display_name, profile_photo, name;
