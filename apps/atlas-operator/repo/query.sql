-- name: GetUsersFirstPage :many
-- Retrieves the first page of users (no cursor).
SELECT
    id,
    bounce_auth_user_id,
    full_name,
    email,
    created_at,
    updated_at,
    display_name,
    profile_photo
FROM public."user"
ORDER BY id
LIMIT $1;

-- name: GetUsersAfterCursor :many
-- Retrieves users after the given cursor ID.
SELECT
    id,
    bounce_auth_user_id,
    full_name,
    email,
    created_at,
    updated_at,
    display_name,
    profile_photo
FROM public."user"
WHERE id > $1::text
ORDER BY id
LIMIT $2;

-- name: GetUserByID :one
SELECT
    id,
    bounce_auth_user_id,
    full_name,
    email,
    created_at,
    updated_at,
    display_name,
    profile_photo
FROM public."user"
WHERE id = $1;

-- name: CountPoolUsers :one
SELECT COUNT(*)::int FROM public."user" WHERE pool_available = true;

-- name: CreatePoolUser :one
INSERT INTO public."user" (email, full_name, pool_available)
VALUES (gen_random_uuid()::text || '@pool.internal', '', true)
RETURNING id;

-- name: HasVirtualKey :one
SELECT EXISTS(SELECT 1 FROM public.llm_virtualkey WHERE user_id = $1);

-- name: UpsertVirtualKey :exec
INSERT INTO public.llm_virtualkey (user_id, ciphertext)
VALUES ($1, $2)
ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext;
