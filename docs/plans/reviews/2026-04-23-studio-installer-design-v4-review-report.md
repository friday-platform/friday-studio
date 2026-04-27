# Review Report: studio-installer-design v4

**Reviewed:** 2026-04-23  
**Plan:** `docs/plans/2026-04-23-studio-installer-design.v4.md`  
**Output:** `docs/plans/2026-04-23-studio-installer-design.v5.md`  
**Reviewer:** /improving-plans

---

## Context Gathered

Verified macOS `$TMPDIR` behavior (per-session directory, cleaned on reboot), checked `run-platform.sh` for process runtime requirements (Deno for agent-playground, Node.js/npx for pty-server), and traced the `check_download_complete → verify_sha256` call sequence for unhandled error paths.

---

## Issues Found and Resolutions

### Issue 1: Download partial in `{tmp_dir}` is erased on macOS reboot ❌ NOT ADOPTED

**Finding:** macOS `$TMPDIR` (`/var/folders/.../T/`) is a per-user-session directory cleaned on reboot. A user who downloads 900MB of a 1GB file and reboots loses the partial and must start over. The `.complete` marker is also cleaned, so `check_download_complete` correctly returns false — but the partial bytes are gone.

**User decision:** Accepted trade-off. The temp dir approach is fine; the team does not want to own download staging directory cleanup. If the partial is lost to a reboot, the installer restarts the download cleanly via the existing retry path.

**Why not adopted:** Would require managing `~/.friday/local/downloads/` lifecycle (creation, cleanup on success, cleanup on uninstall). For a background download that takes ~10min on a reasonable connection, losing progress to a reboot is an acceptable edge case.

---

### Issue 2: `agent-playground` and `pty-server` require Deno and Node.js — unaddressed ❌ NOT ADOPTED (deferred)

**Finding:** Two of the five spawned processes are not standalone compiled binaries:
- `agent-playground`: `deno run -A --no-lock npm:vite dev`
- `pty-server`: `npx tsx server.ts`

On a clean machine, both fail with exit code 127 (command not found). `launch.rs`'s `try_wait(100ms)` catches this but the error message is cryptic.

**User decision:** Deferred. The team may rewrite `agent-playground` and/or `pty-server` in something that compiles to a standalone binary, at which point this issue resolves itself. Adding a bundled Deno/Node runtime now would be premature given the likely architectural change.

**Why not adopted:** YAGNI — the runtime architecture is expected to change before the installer ships. Adding bundled runtimes now creates maintenance burden for a likely-to-change component.

---

### Issue 3: `verify_sha256` returning `Err` after `check_download_complete=true` has no handler ✅ FIXED

**Problem:** The v4 checkpoint flow has an unspecified path: `check_download_complete` returns `true` → `installer.ts` skips the download → calls `verify_sha256` → the file doesn't exist (OS temp cleanup, user deletion, etc.) → `verify_sha256` returns `Err("No such file or directory")`. The plan specifies `Ok(false)` → `delete_partial` + retry, but `Err` has no handler. The user would see a cryptic IO error on what appears to be a completed download step.

**Resolution adopted:** Option A — `installer.ts` treats `Err` from `verify_sha256` identically to `Ok(false)`: call `delete_partial(platform)` to clear all checkpoint state, then show the re-download UI with a distinct message ("Download file not found — starting download again"). Both `Err` and `Ok(false)` mean "the file is not in a verifiable state"; the distinction is logged but does not fork the user-facing flow. Updated in `installer.ts` trust contract, download/resume section, and testing decisions.

**Testing added:** `installer.ts` — `verify_sha256` returns `Err` after `check_download_complete=true` → calls `delete_partial`, shows re-download UI with "file not found" message (not a generic error screen).

---

## Items Not Changed (and Why)

- **`{tmp_dir}` for download staging**: Intentionally kept. User prefers not to own cleanup of a persistent downloads directory.
- **Deno/Node.js runtime dependency**: Intentionally unaddressed. Deferred pending potential rewrite of agent-playground/pty-server to compiled binaries.
- **Windows `.bat` PID capture**: Not surfaced — the `startup.rs` trust contract already notes PIDs are written to `pids/`, and the Windows implementation detail (PowerShell vs batch) is left to the implementor. Not a design-level gap worth blocking on at this stage.

---

## Unresolved Questions

- **Runtime bundling**: If agent-playground and pty-server are NOT rewritten before the installer ships, the Deno/Node.js dependency must be revisited. The plan currently documents `ATLAS_NPX_PATH`/`ATLAS_NODE_PATH` as derived from `install_dir` — if runtimes are eventually bundled, the startup script and launch.rs env setup are already in the right shape to receive them.
