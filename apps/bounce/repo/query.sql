-- name: AuthUserByEmail :one
SELECT * FROM bounce.auth_user WHERE email = $1;

-- name: AuthUserByConfirmationToken :one
SELECT * FROM bounce.auth_user WHERE confirmation_token = $1;

-- name: AuthUserByID :one
SELECT * FROM bounce.auth_user WHERE id = $1;

-- name: SaveUnconfirmedAuthUser :one
INSERT INTO bounce.auth_user (email, confirmation_token, confirmation_sent_at)
VALUES ($1, $2, $3)
ON CONFLICT (email) DO UPDATE
SET confirmation_token = $2,
confirmation_sent_at = $3
RETURNING *;
-- name: SaveConfirmedAuthUser :one
INSERT INTO bounce.auth_user (email, email_confirmed, email_confirmed_at)
VALUES ($1, true, now())
RETURNING *;

-- name: ConfirmAuthUser :one
UPDATE bounce.auth_user
SET
    email_confirmed = true,
    email_confirmed_at = now(),
    confirmation_token = null,
    confirmation_sent_at = null
WHERE
    email = $1
    AND id = $2
RETURNING *;

-- name: CreateTempestUser :one
INSERT INTO public."user" (bounce_auth_user_id, email, full_name, display_name, profile_photo)
VALUES ($1, $2, $3, $4, $5) RETURNING *;

-- name: SaveTempestUser :one
UPDATE public."user"
SET
    full_name = $2,
    display_name = $3,
    profile_photo = $4
WHERE
    id = $1
RETURNING *;

-- name: TempestUserByID :one
SELECT * FROM public."user" WHERE id = $1;

-- name: TempestUserByAuthUserID :one
SELECT * FROM public."user" WHERE bounce_auth_user_id = $1;

-- name: AuthIdentityByProviderID :one
SELECT * FROM bounce.identity WHERE provider = $1 AND provider_id = $2;

-- name: AuthIdentityByProviderEmail :one
SELECT * FROM bounce.identity WHERE provider = $1 AND email = $2;

-- name: SaveAuthIdentity :one
INSERT INTO bounce.identity (
    auth_user_id, email, provider, provider_id, provider_app_data, provider_user_data
)
VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (provider, provider_id, email) DO UPDATE
SET
email = $2,
provider_app_data = $5,
provider_user_data = $6
RETURNING *;

-- name: SetIdentityLastSignin :exec
UPDATE bounce.identity
SET last_sign_in_at = now()
WHERE id = $1;

-- name: SetAuthUserLastSignin :exec
UPDATE bounce.auth_user
SET last_sign_in_at = now()
WHERE id = $1;

-- OTP queries
-- name: SaveOTP :one
INSERT INTO bounce.otp (token, auth_user_id, not_valid_after, use, created_at)
VALUES ($1, $2, $3, $4, $5)
RETURNING *;

-- name: GetUnusedOTP :one
SELECT * FROM bounce.otp WHERE token = $1 AND used_at IS NULL;

-- name: UseOTP :one
UPDATE bounce.otp
SET used_at = now()
WHERE token = $1
    AND used_at IS NULL
RETURNING *;

-- name: ValidMagicLinkOTPByAuthUserID :one
SELECT token, created_at, not_valid_after
FROM bounce.otp
WHERE auth_user_id = $1
    AND use = 'magiclink'
    AND used_at IS NULL
    AND not_valid_after > now()
ORDER BY created_at DESC
LIMIT 1;

-- name: ClaimPoolUser :one
-- Claims an available pool user by updating it with real user data.
-- Uses FOR UPDATE SKIP LOCKED to prevent race conditions on concurrent signups.
-- Returns no rows if pool is empty.
UPDATE public."user"
SET email = $1,
    full_name = $2,
    bounce_auth_user_id = $3,
    display_name = $4,
    profile_photo = $5,
    pool_available = false
WHERE id = (
    SELECT id FROM public."user"
    WHERE pool_available = true
    ORDER BY created_at ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
RETURNING *;

-- name: UpdateUserStripeCustomerID :exec
-- Updates a user's Stripe customer ID after successful Stripe customer creation.
UPDATE public."user"
SET stripe_customer_id = $2
WHERE id = $1;
