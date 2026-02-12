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

-- name: UpsertVirtualKey :exec
INSERT INTO public.llm_virtualkey (user_id, ciphertext)
VALUES ($1, $2)
ON CONFLICT (user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext;

-- name: GetUserIDsMissingVirtualKeys :many
-- Returns user IDs that don't have a virtual key yet.
SELECT u.id
FROM public."user" u
LEFT JOIN public.llm_virtualkey v ON u.id = v.user_id
WHERE v.user_id IS NULL
ORDER BY u.id
LIMIT $1;

-- name: GetVirtualKeyUserIDs :many
-- Returns which of the given user IDs have a virtual key stored.
SELECT user_id FROM public.llm_virtualkey WHERE user_id = ANY($1::text[]);

-- name: DeleteVirtualKey :exec
DELETE FROM public.llm_virtualkey WHERE user_id = $1;
