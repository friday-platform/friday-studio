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
