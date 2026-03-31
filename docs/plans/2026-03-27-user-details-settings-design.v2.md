<!-- v2 - 2026-03-27 - Generated via /improving-plans from docs/plans/2026-03-27-user-details-settings-design.md -->

## Problem Statement

Users have no way to view or edit their profile details after signup. Profile
photos from Google OAuth are available but not displayed in the sidebar. There's
no UI to set a display name or update a profile picture.

## Solution

Add a Profile Details page accessible from the sidebar dropdown, letting users
view and edit their name, display name, and profile photo. Show the user's
profile photo in the sidebar next to their name.

## User Stories

1. As a user, I want to see my profile photo next to my name in the sidebar, so
   that the app feels personalized
2. As a user, I want to click my name in the sidebar and access my profile
   details, so that I can view my account information
3. As a user, I want to edit my full name, so that I can correct it if it was
   imported wrong
4. As a user, I want to set a display name, so that I can go by a preferred
   name in the app
5. As a user, I want to see my email address on my profile (read-only), so that
   I know which account I'm signed in with
6. As a user, I want to upload a profile photo by clicking or dragging an image,
   so that I can personalize my avatar
7. As a user, I want to see a placeholder avatar when I haven't set a photo, so
   that the layout doesn't break
8. As a user, I want the display name field to show my full name as a
   placeholder when empty, so that I understand what it defaults to
9. As a user, I want to preview my photo immediately after selecting it, so that
   I can confirm it looks right before saving
10. As a user, I want to click an explicit Save button to persist my changes, so
    that I don't accidentally update my profile
11. As a user, I want to remove my profile photo and revert to the placeholder,
    so that I can undo a photo I no longer want

## Implementation Decisions

### Sidebar changes

- Add profile photo next to user name in the sidebar
- CSS for name + image container: `display: flex; padding: 0 7px; align-items: center; gap: 12px;`
- CSS for image: `width: 24px; height: 24px; aspect-ratio: 1/1; border-radius: 24px;`
- Placeholder avatar (initials or generic icon) when no photo is set
- Add "Profile Details" menu item above "Settings" in the user dropdown

### New `/profile` route

- Uses existing Page component with `header` snippet ("Profile Details")
- `+page.ts` loader fetches user data via RPC client
- Form fields:
  - Profile photo: custom image picker (see below)
  - Full name: text input, editable
  - Display name: text input, editable, `placeholder` shows the current
    full_name value
  - Email: text input, read-only / disabled
- Explicit Save button
- Client-side form with `onsubmit` handler (not `+page.server.ts` — this is an
  adapter-static app)
- Add `profile` route to `getRouteConfig()` in `app-context.svelte.ts`

### Image picker component

- Custom component (reference `artifact-ref-input` for patterns, don't reuse)
- Displays current profile photo or placeholder in a clickable area
- Click opens native file picker (accept image types: `image/png`, `image/jpeg`,
  `image/gif`, `image/webp`)
- Drag-and-drop supported over the image area
- Preview immediately via `URL.createObjectURL` on file select
- Actual upload happens on form save (not eager)
- Remove button (X) visible when a photo exists — clears photo on save
  (sets `profile_photo` to null)
- Client-side validation: max file size (e.g. 5MB), image MIME types only

### Backend: `PATCH /api/me` in atlasd

- Single multipart endpoint on the existing `/api/me` route — handles both
  photo upload and profile field updates in one request
- If a photo file is included: store the image binary directly (not as an
  artifact — artifacts have workspace/chat associations and show up in the
  library):
  - **Local mode:** Write to `$ATLAS_HOME/profile-photos/{userId}.{ext}`
  - **Cortex mode:** Upload raw binary to Cortex `POST /objects` (same HTTP
    client, but no artifact metadata/indexing), store the Cortex object ID
- Set `profile_photo` to `/api/me/photo` (the serving URL) and proxy remaining
  field updates to persona service `PATCH /api/me`
- Return updated `MeResponse`
- **Local mode (no PERSONA_URL):** Must also support profile updates. Use a
  local write path (JSON file in `$ATLAS_HOME` or KV store) so profile editing
  works in local development without a persona service

### Backend: `GET /api/me/photo` in atlasd

- Serves the stored profile photo binary for the authenticated user
- **Local mode:** Read from `$ATLAS_HOME/profile-photos/{userId}.{ext}`
- **Cortex mode:** Download blob from Cortex by stored object ID, stream back
- Returns image with appropriate `Content-Type` and cache headers
- Returns 404 if no uploaded photo exists
- Not used for Google OAuth photos — those are external URLs loaded directly
  by the browser

### Backend: `PATCH /api/me` in persona service (Go)

- New handler `handleUpdateMe` in `apps/persona/service/handlers.go`
- Register as `r.Patch("/me", handleUpdateMe)` in the `/api` route group
- New sqlc query `UpdateUser` using COALESCE pattern for partial updates:

  ```sql
  -- name: UpdateUser :one
  UPDATE "user"
  SET
      full_name = COALESCE($2, full_name),
      display_name = COALESCE($3, display_name),
      profile_photo = COALESCE($4, profile_photo),
      updated_at = now()
  WHERE id = $1
  RETURNING id, full_name, email, created_at, updated_at, display_name,
            profile_photo, name;
  ```

  Note: to clear `profile_photo` (remove photo), send empty string — COALESCE
  treats SQL NULL as "keep current", while empty string means "clear". The Go
  handler maps the JSON `null` → SQL `NULL` (keep) vs JSON `""` → SQL `''`
  (clear).

- **RLS: add a PERMISSIVE UPDATE policy** via new migration:

  ```sql
  CREATE POLICY "user_update_self" ON public."user"
      AS PERMISSIVE FOR UPDATE TO authenticated
      USING (id = (SELECT current_setting('request.user_id', true)))
      WITH CHECK (id = (SELECT current_setting('request.user_id', true)));
  ```

  This allows the persona service to use `withUserContext` for the UPDATE,
  maintaining RLS enforcement for defense-in-depth.

- Input validation in Go handler:
  - Reject any attempt to change `email`, `id`, `created_at`, `updated_at`
  - Validate `full_name` is non-empty if provided
  - Validate `profile_photo` is a valid URL or empty string if provided
- Returns updated user in same shape as `GET /api/me`

### Profile photo URL contract

`profile_photo` is always a URL string (or null):
- Google OAuth users: external URL (e.g. `https://lh3.googleusercontent.com/...`)
- Uploaded photos: `/api/me/photo` (served by atlasd)
- No photo: `null`

The frontend uses it directly as `<img src={profile_photo}>` without caring
about the source. Both external URLs and relative atlasd URLs work in `<img>`.

### Save flow

1. User edits fields and/or selects a new photo (previewed immediately via
   `URL.createObjectURL`)
2. User clicks Save
3. Client sends `PATCH /api/me` (multipart if photo changed, JSON otherwise)
4. atlasd stores photo binary if present (local disk or Cortex — not as an
   artifact), sets `profile_photo` to `/api/me/photo`
5. atlasd proxies field updates (including photo URL) to persona `PATCH /api/me`
6. Persona updates DB row via `withUserContext` + COALESCE query, returns
   updated user
7. Client invalidates user data so sidebar/app context refreshes

### Data Isolation

The `public."user"` table already has a RESTRICTIVE `user_isolation` policy and
a PERMISSIVE `user_select_self` policy. A new PERMISSIVE `user_update_self`
policy is required (see persona backend section) so the `authenticated` role
can UPDATE its own row via `withUserContext`.

## Testing Decisions

Good tests here verify external behavior: submitting profile changes results in
persisted data, and the UI reflects the updates.

- **Persona service**: Go tests for the new `PATCH /api/me` handler — valid
  updates succeed, partial updates (COALESCE) preserve untouched fields,
  clearing profile_photo with empty string works, read-only fields (email) are
  rejected, invalid input returns 400
- **RLS integration test**: Add a case to `rls_test.go` verifying that
  authenticated users can UPDATE their own row but not another user's
- **atlasd proxy route**: Vitest for the PATCH route — proxies correctly to
  persona, handles photo upload + field update in one request, local mode
  fallback works
- **Web client**: Component-level tests for the image picker (file select,
  drag-and-drop, preview, remove behavior)
- Prior art: existing settings page tests, persona service `handleMe` tests

## Out of Scope

- Display name fallback audit across the full app (sidebar already handles it)
- Password/email change
- Account deletion
- Notification preferences
- Theme/appearance settings
