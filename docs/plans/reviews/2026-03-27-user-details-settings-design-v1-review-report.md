# Review Report: User Details & Settings Design (v1)

**Reviewed:** `docs/plans/2026-03-27-user-details-settings-design.md`
**Date:** 2026-03-27
**Output:** `docs/plans/2026-03-27-user-details-settings-design.v2.md`

## Findings

### 1. RLS UPDATE policy missing (critical)

**Issue:** Plan said "uses service role (no RLS migration needed)" but persona's
`withUserContext` sets `SET LOCAL ROLE authenticated`. The `public."user"` table
only has a PERMISSIVE SELECT policy — no PERMISSIVE UPDATE. UPDATEs via
`withUserContext` would be silently rejected.

**Resolution:** Add a `user_update_self` PERMISSIVE UPDATE policy via migration.
Use `withUserContext` for the update query to maintain defense-in-depth. User
chose this over the simpler "use pool directly as service role" approach.

### 2. sqlc partial update query unspecified

**Issue:** PATCH with optional fields needs a specific SQL pattern. sqlc doesn't
support dynamic field sets.

**Resolution:** Use COALESCE pattern — `COALESCE($2, full_name)` so SQL NULL
means "keep current". Single query handles all partial update combinations.
Client always sends all fields from the form anyway. For clearing profile_photo,
empty string means "clear" vs SQL NULL means "keep".

### 3. Local mode has no persona service

**Issue:** atlasd adapter falls back to JWT extraction in local mode (no
`PERSONA_URL`). PATCH would have nothing to proxy to — profile editing would
fail in local dev.

**Resolution:** Build a local-mode write path in the atlasd adapter (JSON file
in `$ATLAS_HOME` or KV store). Profile editing must work locally for testing.

### 4. Image storage and serving

**Issue:** Plan didn't specify how uploaded photos become resolvable URLs.
Research showed all blobs are proxied through atlasd — no direct CDN URLs.

**Resolution:** Store uploaded photos as artifacts via existing storage adapter.
Construct URL as `/api/artifacts/{artifactId}/content`. The `profile_photo`
field is always a URL string — external (Google OAuth) or atlasd-relative
(uploaded). Frontend uses it directly in `<img src>`.

### 5. No photo removal flow

**Issue:** Plan had no way to remove a profile photo once set.

**Resolution:** Add remove/X button on image picker. On save, sends empty string
for `profile_photo` which the COALESCE query stores as `''` (clearing it).
`nullIfEmpty` in the GET handler then returns `null` to the client.

## Unresolved Questions

None — all findings were resolved during review.
