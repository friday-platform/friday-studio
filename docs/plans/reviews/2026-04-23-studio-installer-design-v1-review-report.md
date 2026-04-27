# Review Report: studio-installer-design v1

**Reviewed:** 2026-04-23
**Plan:** `docs/plans/2026-04-23-studio-installer-design.md`
**Output:** `docs/plans/2026-04-23-studio-installer-design.v2.md`
**Reviewer:** /improving-plans

---

## Issues Found and Resolutions

### Issue 1: Checksum failure leaves corrupt partial — retry makes it worse ✅ FIXED

**Problem:** `download.rs` resumes downloads using HTTP Range from whatever bytes are in the `.partial` file. If `verify_sha256` returns `false` (corrupt download), the partial itself is corrupt. Clicking "Try again" sends `Range: bytes={corrupt_size}-`, the server appends bytes to the already-bad file, checksum fails again with a larger corrupt partial. This is an unrecoverable loop.

**Resolution adopted:** Option A — added `delete_partial(platform: String) → Result<(), String>` as a new Tauri command. `installer.ts` calls it after `verify_sha256` returns `Ok(false)`, before re-invoking `download_file`. Idempotent (safe to call when partial is absent). `download.rs`'s trust contract explicitly notes it does not delete the partial — that is the caller's responsibility via this command.

**Options considered but rejected:**
- B (`force_restart: bool` param on `download_file`): muddies `download.rs` interface with caller's verdict
- C (send `Range: bytes=0-` to restart without delete): fragile, `200` vs `206` behavior implementation-defined

**Testing added:** `delete_partial.rs` — file exists → deleted OK; absent → OK (idempotent); directory absent → OK.

---

### Issue 2: Installer silently kills Studio with no warning or escape ✅ FIXED

**Problem:** `extract.rs` terminates Studio processes via SIGTERM/`TerminateProcess` without any UI indication. A user who opens the installer while Studio is running (e.g., to check for updates, or by accident) would have their running Studio killed immediately upon proceeding.

**User's direction:** If Studio is running and already up to date, offer "Open Studio" as the primary CTA and close the installer. If an update is available, warn about the impact and give both "Update" and "Open Studio" options.

**Resolution adopted:** Option A, extended — added `check_running_processes() → bool` as a separate read-only Tauri command (thin wrapper around the PID check that `extract.rs` would have done internally anyway). `installer.ts` calls it during `detectInstallState()`. The Welcome screen branches on `{ mode, studioRunning }`:
- `current + running` → "Open Studio" (opener plugin) + close — no steps needed
- `current + not running` → "Launch Studio" button
- `update + running` → warn inline, offer [Update] and [Open Studio instead]
- `update + not running` → proceed with update flow directly

**Options considered but rejected:**
- B (explicit "Stop Studio" step in flow): adds a step to an already-skipped-down update flow
- C (silent termination, documented): worst UX, user loses running work

**Testing added:** `detectInstallState()` branching tests cover all `{ mode, studioRunning }` combinations.

---

### Issue 3: Failed extraction leaves a broken, unrecoverable installation ✅ FIXED

**Problem:** If extraction fails midway (disk full, corrupted archive, power loss), some binaries are the new version and some are the old version. Studio won't start. The `.installed` marker was not written (it's written on success), so the next installer run would see a version mismatch and re-download — but the user has no indication their previous install is intact or destroyed.

**Resolution adopted:** Option A — backup-then-restore pattern in `extract.rs`. Before extracting on update, rename the existing install dir to `.bak` suffix (`Friday Studio.app.bak` / `Friday Studio.bak`). On extraction success, delete `.bak`. On any extraction failure, rename `.bak` back to original and return `Err`. The trust contract is updated: "On failure, existing install is restored from backup — the system is never left in a partially-updated state."

**Options considered but rejected:**
- B (extract to temp dir, atomic rename): requires 2× disk space for a 1GB+ install — tight
- C (accept broken state, document): poor recovery UX

**Testing added:** `extract.rs` — assert backup created before extraction; deleted on success; restored on simulated failure.

---

### Issue 4: Manifest fetch hangs indefinitely on network failure ✅ FIXED

**Problem:** The manifest fetch at startup had no timeout specified. On CDN outage or offline machine, the installer would display nothing and hang. No escape, no retry button.

**Resolution adopted:** Option A — promoted manifest fetch to its own Tauri command `fetch_manifest.rs` with a hard-coded 10-second total timeout via reqwest. Returns `Err` with human-readable message on timeout, DNS failure, or parse error. `installer.ts` shows the error with a Retry button. "Never hangs longer than 10s" is part of the trust contract.

**Options considered but rejected:**
- B (fall back to `.installed` version on failure): hides real connectivity errors, user thinks they're up to date when the check didn't run
- C (configurable timeout): unnecessary complexity

**Testing added:** `fetch_manifest.rs` — timeout simulation → `Err` with message within 10s.

---

### Issue 5: Branding — logo assets identified ✅ ADDED (new, not a bug)

**Finding:** `apps/friday-website/src/lib/assets/` contains `favicon.svg` (standalone blue mark, perfect as app icon) and `logo.svg` (full wordmark for Welcome screen). No new artwork needed. A **Branding** section was added to the plan documenting:
- `favicon.svg` → convert to `.icns`/`.ico` for `src-tauri/icons/`
- `logo.svg` → Welcome screen header
- `logo-grey.svg` → disabled/secondary states

---

## Clarifications Made Explicit

- **`.installed` write timing**: Write after successful extraction, before launch. Tracks what's on disk, not whether Studio is running. Launch failure is a runtime concern, not an install-state concern. Explicitly stated in v2.
- **Path quoting in startup script**: `startup.rs` trust contract now notes paths with spaces (e.g., `Friday Studio`) must be quoted in both `.sh` and `.bat` output.
- **`check_running_processes()` is also a UI primitive**: The same PID-check logic exposed as a separate read-only command (not buried in `extract.rs`) so the Welcome screen can show the right message without triggering termination.

---

## Items Not Changed (and Why)

- **`verify_sha256` returning `Ok(false)` vs `Err`**: The existing distinction is correct. `Ok(false)` = corrupt download (caller's job to delete partial). `Err` = IO failure (different error path). Kept as-is.
- **5-attempt retry cap on download**: Not increased. 5 attempts with exponential backoff covers transient network issues; more attempts would just delay the manual "Try again" CTA.
- **No API key format validation**: Deliberately left out. Validating key format would require API calls during install; wrong keys surface at Studio startup with a clear error.
- **Windows: `%LOCALAPPDATA%\Programs\Friday Studio`**: Path with space is handled by the quoting fix in `startup.rs`. NSIS handles quoting internally.

---

## Unresolved Questions

None — all four issues were resolved with clear user direction.
