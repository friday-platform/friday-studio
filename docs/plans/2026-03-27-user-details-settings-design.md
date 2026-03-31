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

### Image picker component

- Custom component (reference `artifact-ref-input` for patterns, don't reuse)
- Displays current profile photo or placeholder in a clickable area
- Click opens native file picker (accept image types only)
- Drag-and-drop supported over the image area
- Preview immediately via `URL.createObjectURL` on file select
- Actual upload happens on form save (not eager)

### Backend: `PATCH /api/me` in atlasd

- Single multipart endpoint handling both photo upload and profile field updates
- If a photo file is included: store via existing storage adapter (Cortex or
  local), produce a URL
- Proxy the field updates (full_name, display_name, profile_photo URL) to
  persona service `PATCH /api/me`
- Return updated `MeResponse`

### Backend: `PATCH /api/me` in persona service (Go)

- New handler in `apps/persona/service/handlers.go`
- New sqlc query `UpdateUser` — updates `full_name`, `display_name`,
  `profile_photo` on `public."user"` where `id` matches JWT user
- Uses service role (no RLS migration needed)
- Returns updated user in same shape as `GET /api/me`

### Save flow

1. User edits fields and/or selects a new photo (previewed immediately)
2. User clicks Save
3. Client sends `PATCH /api/me` (multipart if photo changed, JSON otherwise)
4. atlasd stores photo if present, proxies field updates to persona
5. Persona updates DB row, returns updated user
6. Client invalidates user data so sidebar/app context refreshes

### Data Isolation

The `public."user"` table already has RLS policies restricting authenticated
users to their own row. Persona service uses the service role for writes, so no
new RLS policies are needed.

## Testing Decisions

Good tests here verify external behavior: submitting profile changes results in
persisted data, and the UI reflects the updates.

- **Persona service**: Go tests for the new `PATCH /api/me` handler — valid
  updates succeed, partial updates work, read-only fields (email) are rejected,
  invalid input returns 400
- **atlasd proxy route**: Vitest for the PATCH route — proxies correctly to
  persona, handles photo upload + field update in one request
- **Web client**: Component-level tests for the image picker (file select,
  drag-and-drop, preview behavior)
- Prior art: existing settings page tests, persona service `handleMe` tests

## Out of Scope

- Display name fallback audit across the full app (sidebar already handles it)
- Password/email change
- Account deletion
- Notification preferences
- Theme/appearance settings
