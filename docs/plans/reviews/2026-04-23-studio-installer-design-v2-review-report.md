# Review Report: studio-installer-design v2

**Reviewed:** 2026-04-23
**Plan:** `docs/plans/2026-04-23-studio-installer-design.v2.md`
**Output:** `docs/plans/2026-04-23-studio-installer-design.v3.md`
**Reviewer:** /improving-plans

---

## Issues Found and Resolutions

### Issue 1: launch.rs trust contract overpromises — port poll can't confirm all processes started ✅ FIXED

**Problem:** `launch.rs` spawned 5 processes (postgres, redis, LLM proxy, vector store, atlasd) and then polled `http://localhost:5200` until it responded. Polling a single port doesn't confirm that the other 4 processes started successfully — any of them can crash immediately after spawn with no detection. The trust contract stated "Studio is running and reachable on port 5200" which implied all services are up, but in practice only atlasd's port was verified.

**Resolution adopted:** Option A — added `child.try_wait()` check 100ms after each `Command::spawn()` call. If a process exits within that window, return `Err("Failed to start {name}: exited with code {N}")` before proceeding to the next process or the port poll. Trust contract corrected to: "all five processes passed the 100ms immediate-exit check AND port 5200 became reachable within 30s."

**Options considered but rejected:**
- B (poll all 5 process PIDs continuously): complex, still misses processes that crash after the initial check window
- C (accept partial start, let user diagnose): wrong failure UX — installer should never silently succeed into a broken state

**Testing added:** `launch.rs` — simulate immediate process exit (mock `try_wait` returns `Some(ExitStatus::failure())`) → returns `Err` with process name and exit code.

---

### Issue 2: `.installed` write is not atomic — crash mid-write leaves corrupt state ✅ FIXED

**Problem:** `extract.rs` wrote the `.installed` marker file with a plain `fs::write()`. If the machine crashes between truncation and full write, the file contains truncated JSON. On next installer run, `installer.ts` reads a corrupt file and doesn't know whether the install completed — it could either send the user through a full re-download or silently treat a partial install as current. Neither is correct.

**Resolution adopted:** Option A — extracted `.installed` management into a dedicated `installed_marker.rs` command module with two commands:
- `write_installed(version: String) → Result<(), String>`: writes to `{marker_path}.tmp`, then `fs::rename()` (atomic on all target platforms). Trust contract: "On success, the file is either absent or fully valid JSON — never a partial write."
- `read_installed() → Result<Option<InstalledMarker>, String>`: parses the file; if parse fails (corrupt file), deletes it and returns `None` so the installer falls through to fresh-install detection.

**Options considered but rejected:**
- B (catch JSON parse errors in `installer.ts`, delete from TypeScript): requires a separate Tauri command to delete the file anyway; leaks file path knowledge to the frontend
- C (accept corrupt state, document): unacceptable — leaves the installer in an indeterminate loop for the user

**Testing added:** `installed_marker.rs` — round-trip (write → read → verify); corruption simulation (write bad bytes to marker file → read returns `None` and deletes file); absent file → `Ok(None)`.

---

### Issue 3: Version comparison sends beta users into unexpected downgrade flow ✅ FIXED

**Problem:** `detectInstallState()` in `installer.ts` compared installed version against available version with strict `!=`. A beta user on `v1.1.0-beta.3` would see `installed != available` (where available = `v1.0.0`) and enter the update flow — offering to "downgrade" their beta build to the stable release. The installer would then overwrite a newer binary with an older one without warning.

**Resolution adopted:** Option A — changed the comparison to semver ordering: `installed >= available` → return `"current"`. Implementation strips pre-release suffixes from both versions before comparing (e.g., `v1.1.0-beta.3` → `v1.1.0`; `v1.0.0` → `v1.0.0`), then compares major/minor/patch numerically. No external semver library — the logic is six lines of inline comparison. `installed > available` (beta on newer version) maps to `"current"`.

**Options considered but rejected:**
- B (separate `"newer"` install state for installed > available): adds UI complexity (a new screen state) for a rare case; `"current"` with an informational label is sufficient
- C (show update prompt but label it "downgrade warning"): confusing UX; most users don't know they're on beta

**Testing added:** `installer.ts` — semver edge cases: `v1.0.0` = `v1.0.0` → current; `v1.1.0` > `v1.0.0` → current; `v0.9.0` < `v1.0.0` → update; `v1.1.0-beta.3` (strip → `v1.1.0`) > `v1.0.0` → current; `v1.0.0-rc.1` (strip → `v1.0.0`) = `v1.0.0` → current.

---

## Update Story Added (Design Decision)

**Finding during review:** v2 marked "auto-update" as out of scope but left it unclear how future versions would be installed. The installer already has all the pieces needed (manifest fetch, download, verify, extract, env merge) — re-running the installer on a machine with an existing install naturally detects the version mismatch and updates in place.

**Resolution:** Clarified the update model in v3:
- The installer is also the updater. Re-running it on a machine with an older install shows an "Update Available" flow instead of "Welcome."
- Studio shows a passive update-available banner (non-blocking, links to installer download page). No auto-download, no forced restart.
- "Auto-update" (background downloads, silent restarts) remains explicitly out of scope.

---

## Clarifications Made Explicit

- **`installed_marker.rs` is the sole owner of the `.installed` file** — `extract.rs` no longer touches it directly. The trust contract boundary is explicit: extract handles archives, installed_marker handles state persistence.
- **Pre-release suffix stripping applies to both sides** of the semver comparison, so a stable available version `v1.0.0` is correctly compared against a beta installed version.
- **`try_wait()` timeout of 100ms** is chosen to catch immediate crashes (missing dependency, permission error) without adding meaningful UI latency to the launch step.

---

## Items Not Changed (and Why)

- **5-process launch sequence**: Order (postgres → redis → LLM proxy → vector store → atlasd) unchanged. Each process is given its own 100ms check but they are not launched in parallel — sequential launch simplifies failure attribution.
- **30s port poll**: Unchanged. For a 1GB+ app with database startup, 30s is a reasonable upper bound. Users see a spinner with elapsed time.
- **Backup-before-extract from v2**: Unchanged. The `installed_marker.rs` split does not affect the backup-restore pattern in `extract.rs`.

---

## Unresolved Questions

None — all three issues resolved with clear user direction.
