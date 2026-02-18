<!-- v2 - 2026-02-18 - Generated via /improving-plans from docs/plans/2026-02-18-email-scanner-token-fix-design.md -->

# Fix: Email scanner token consumption on signup & magic link verify

## Context

Email security scanners (Barracuda, Mimecast, Proofpoint, Microsoft Safe Links) follow links in emails via GET requests before the user clicks. Both `/signup/email/verify` and `/magiclink/verify` consume their one-time tokens on GET, meaning the scanner burns the token and the actual user sees a blank page (401 with empty body or bare `return` with no response).

Confirmed in production logs: scanner IPs (`161.123.122.150`, `185.223.42.146`) consume the token 3-4 seconds before the real user clicks. The scanner even claims a pool user slot, creating an orphaned account.

**Note on magic link behavior:** The current `UseOTP` SQL query (`UPDATE bounce.otp SET used_at = now() WHERE token = $1`) has no `AND used_at IS NULL` guard, so technically a scanner consuming the magic link token doesn't prevent the real user from also succeeding (the UPDATE fires twice). The primary production breakage is in the signup flow, where `confirmation_token` is NULLed on use, making the token truly one-time. The magic link fix is defense-in-depth plus an opportunity to fix the missing SQL guard.

## Solution

Convert both verify endpoints from single-step GET (consume on request) to two-step GET→POST (GET redirects to confirmation page, POST consumes). Scanners follow GETs but don't submit forms.

Additionally: harden `UseOTP` to enforce one-time consumption at the SQL level.

### Flow (signup)

```
Before:  Email link → GET bounce/signup/email/verify → consume token → set cookie → redirect /complete-setup
After:   Email link → GET bounce/signup/email/verify → redirect to auth-ui/confirm-email?t=TOKEN
                       auth-ui renders "Verify" button → POST /signup/email/verify → consume → cookie → redirect
```

### Flow (magic link)

```
Before:  Email link → GET bounce/magiclink/verify → consume OTP → set cookie → redirect /
After:   Email link → GET bounce/magiclink/verify → redirect to auth-ui/confirm-login?otp=TOKEN
                       auth-ui renders "Continue" button → POST /magiclink/verify → consume → cookie → redirect
```

## Changes

### 1. Bounce: `apps/bounce/repo/query.sql`

**Harden `UseOTP` query** — add `AND used_at IS NULL` guard:
```sql
-- name: UseOTP :one
UPDATE bounce.otp
SET used_at = now()
WHERE token = $1
  AND used_at IS NULL
RETURNING *;
```

This makes consumption atomic and one-time at the DB level. Without this guard, the same token can be "used" repeatedly — the `UPDATE` always succeeds as long as the row exists. This brings `UseOTP` in line with `ValidMagicLinkOTPByAuthUserID`, which already filters `used_at IS NULL`.

After editing `query.sql`, regenerate with `sqlc generate`.

### 2. Bounce: `apps/bounce/service/signup.go`

**Modify `verifyEmailSignup` (GET handler)** — strip it down to just redirect:
```go
func verifyEmailSignup(w http.ResponseWriter, r *http.Request) {
    token := r.URL.Query().Get("t")
    if token == "" {
        http.Redirect(w, r, cfg.AuthUIURL+"/signup-retry", http.StatusTemporaryRedirect)
        return
    }
    http.Redirect(w, r, cfg.AuthUIURL+"/confirm-email?t="+token, http.StatusTemporaryRedirect)
}
```

**Add `verifyEmailSignupPost` (POST handler)** — the actual verification logic (extracted from current GET handler). Returns JSON instead of redirecting (client-side fetch from auth-ui):
- Parse token from JSON body
- Look up auth user by confirmation token
- Check expiry, verify HMAC
- Confirm auth user, claim/create tempest user, commit
- Set session cookie
- Return `{ redirect: "/complete-setup" }` on success
- Return `{ error: "...", code: "token_expired" | "token_invalid" }` on failure

### 3. Bounce: `apps/bounce/service/magiclink.go`

**Modify `verifyMagicLink` (GET handler)** — strip down to redirect:
```go
func verifyMagicLink(w http.ResponseWriter, r *http.Request) {
    otp := r.URL.Query().Get("otp")
    originalReferrer := r.URL.Query().Get("original_referrer")
    redirectURL := cfg.AuthUIURL + "/confirm-login?otp=" + otp
    if originalReferrer != "" {
        redirectURL += "&original_referrer=" + url.QueryEscape(originalReferrer)
    }
    http.Redirect(w, r, redirectURL, http.StatusTemporaryRedirect)
}
```

**Add `verifyMagicLinkPost` (POST handler)** — extracted from current GET handler. Returns JSON.

Fix the silent 200 bugs from the current handler while extracting:
- **Wrong OTP `use` type** (current: silent `return` with 200, no body) → return `{ error: "Invalid token", code: "token_invalid" }` with 400
- **HMAC mismatch** (current: silent `return` with 200, no body) → return `{ error: "Invalid token", code: "token_invalid" }` with 400
- **Token not found / already consumed** (`UseOTP` returns no rows after adding `used_at IS NULL` guard) → return `{ error: "Magic link expired or already used", code: "token_consumed" }` with 410
- **Token expired** (current: 410 plain text) → return `{ error: "Magic link expired", code: "token_expired" }` with 410

Success path:
- Parse OTP from JSON body
- `UseOTP` (now enforces one-time use)
- Validate use type, check expiry, verify HMAC
- Look up tempest user
- Set session cookie
- Return `{ redirect: cfg.RedirectURI + "/" }` (or `original_referrer` if provided)

**Reorder expiry check before consumption:** Currently expiry is checked *after* `UseOTP` fires, meaning expired tokens get marked as used even though auth fails. With the new `used_at IS NULL` guard, this ordering matters — an expired token would be permanently consumed with no benefit. Move expiry validation before `UseOTP`, or accept the tradeoff (consumed expired tokens are harmless since they were going to expire anyway).

### 4. Bounce: `apps/bounce/service/service.go`

Update routes — add POST handlers with CORS:
```go
r.Route("/signup", func(r chi.Router) {
    r.Get("/email/verify", verifyEmailSignup)        // redirect only
    r.With(cors.Handler(corsOptions)).Post("/email/verify", verifyEmailSignupPost)  // actual verification
    r.Post("/email", newEmailSignup)
    // ... existing /complete route
})
r.Route("/magiclink", func(r chi.Router) {
    r.Post("/", sendMagicLink)
    r.Get("/verify", verifyMagicLink)              // redirect only
    r.With(cors.Handler(corsOptions)).Post("/verify", verifyMagicLinkPost)  // actual verification
})
```

### 5. Bounce: `apps/bounce/service/session.go`

Fix `SetNewSessionCookie` — remove `w.WriteHeader(http.StatusOK)` from all 5 error paths (lines 218, 235, 243, 250, 258). The function already returns the error; callers should control the HTTP response status. Currently these write 200 before the caller can write an error status, and Go's `http.ResponseWriter` silently drops the second `WriteHeader` call.

### 6. Auth-UI: `apps/atlas-auth-ui/src/routes/confirm-email/+page.svelte`

New page. Reads `t` from URL query params. Renders a "Verify my email" button. On click:
```ts
const res = await fetch("/signup/email/verify", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: t }),
});
const data = await res.json();
if (res.ok) window.location.href = data.redirect;
else // show error, link to /signup-retry
```

Follows existing patterns from `complete-setup` (client-side fetch, same layout/components, `<Decal>` grid). The `credentials: "include"` ensures the Set-Cookie from bounce is accepted by the browser (same origin via traefik).

Use `toast()` for network errors (not `alert()`). Disable button on click (existing `$state` pattern: `submitted` flag).

Error states: token expired → show message + link to `/signup-retry`. Token invalid → same. Network error → toast.

### 7. Auth-UI: `apps/atlas-auth-ui/src/routes/confirm-login/+page.svelte`

New page. Same pattern as confirm-email but for magic links. Reads `otp` and `original_referrer` from URL query params. "Continue to Friday" button. POSTs to `/magiclink/verify`.

Error states:
- `token_expired` → show message + "Request a new magic link" link to login page
- `token_consumed` → show message + "Request a new magic link" link to login page
- `token_invalid` → show message + link to login page
- Network error → toast

## What does NOT change

- **Email templates** — links still point to bounce (`SignupHostname/signup/email/verify?t=...`, `BounceServiceURL/magiclink/verify?otp=...`). Bounce just redirects now.
- **Traefik routing** — GET already routes to bounce, POST on same path routes to bounce too. New auth-ui pages (`/confirm-email`, `/confirm-login`) fall through to auth-ui's catch-all.
- **Database schema** — no changes (just a query update + sqlc regen).
- **Token generation/storage** — unchanged.

## Verification

1. **Signup flow**: Sign up with email → receive email → click link → see confirm page → click "Verify" → redirected to `/complete-setup` → complete profile → redirected to app
2. **Magic link flow**: Request magic link → receive email → click link → see confirm page → click "Continue" → redirected to app
3. **Scanner simulation**: `curl -L` the verify link → follows redirects to confirm page HTML → stops (no form submission, token NOT consumed)
4. **Expired token**: Wait 24h (or modify DB) → click verify link → see error message + retry link
5. **Already-used token (magic link)**: Consume OTP in DB manually → POST verify → get `token_consumed` error with friendly message
6. **Double-click**: Click verify button twice → button disabled after first click, second POST returns error (token consumed) → first request's redirect fires
7. **Existing tests**: Run `go test -race ./...` in `apps/bounce/` to verify nothing breaks
8. **sqlc regen**: Run `sqlc generate` after `query.sql` change, verify generated code compiles
