# Review Report: studio-installer-design v5

**Reviewed:** 2026-04-23  
**Plan:** `docs/plans/2026-04-23-studio-installer-design.v5.md`  
**Output:** `docs/plans/2026-04-23-studio-installer-design.v6.md`  
**Reviewer:** /improving-plans

---

## Context Gathered

Traced the PID file lifecycle across both launch paths (`launch.rs` direct spawn vs startup script execution) and walked the `extract.rs` backup/rename sequence under the scenario of a force-killed mid-extraction followed by a retry.

---

## Issues Found and Resolutions

### Issue 1: `launch.rs` spawns processes but never writes PID files ✅ FIXED

**Problem:** `check_running_processes()` reads `~/.friday/local/pids/` to determine whether Studio is running. The startup script writes PID files to that directory. But `launch.rs` uses `std::process::Command` directly and the v5 plan said nothing about it writing PID files. After `launch_studio()` succeeds and Studio is running, re-opening the installer would find no PID files → `check_running_processes()` returns `false` → `detectInstallState()` returns `{ mode: 'current', studioRunning: false }` → Welcome screen shows "Launch Studio" button. The user clicks it; `launch.rs` attempts to spawn all five processes again; all crash with "address already in use"; `try_wait(100ms)` catches the first crash and returns a confusing `Err("Failed to start atlas: exited with code 1")`.

**Resolution adopted:** Option A — `launch.rs` writes a PID file to `~/.friday/local/pids/{name}.pid` for each process immediately after the `try_wait(100ms)` check confirms it stayed alive. PID files are written inline in the startup sequence: after `atlas` try_wait → write `atlas.pid`; after `link` try_wait → write `link.pid`; etc. Same format as the startup script. `check_running_processes()` now works correctly regardless of which launch path was used. Trust contract updated: "PID files have been written for all five processes" is part of the `Ok` postcondition.

**Testing added:** `launch.rs` — after successful `launch_studio()`, `check_running_processes()` immediately returns `true` (PID files exist and processes are live).

---

### Issue 2: Stale `.bak` from a crashed extraction silently blocks the next update ✅ FIXED

**Problem:** Scenario: installer is force-killed during extraction. State on disk: `Friday Studio.app` (partial new binaries), `Friday Studio.app.bak` (the last known-good install). The `.installed` marker still has the old version. On next installer run, `detectInstallState()` correctly enters the update flow. `extract.rs` tries to rename `Friday Studio.app` → `Friday Studio.app.bak` as the backup step — but `.bak` already exists. On macOS, `fs::rename` between two directories fails when the destination exists. `extract.rs` returns `Err` before touching anything. The user is stuck in a loop: the update always fails with an opaque error, neither the good backup nor the partial install is reachable through the normal flow.

**Resolution adopted:** Option A — at the start of `extract.rs`'s backup step, check for a pre-existing `.bak` directory. If one exists, delete it (recursively) before performing the rename. A stale `.bak` is definitionally superseded the moment the user retries the update: the current install dir (even if partially-extracted from the last attempt) is the starting point for the new backup. Trust contract addition: "If a stale `.bak` from a previous failed extraction is present, it is removed before creating a new backup — a stale `.bak` is superseded the moment the user retries the update."

**Testing added:** `extract.rs` — pre-existing `.bak` directory present → removed, rename succeeds, extraction proceeds normally (does not return `Err`).

---

## Items Not Changed (and Why)

- **`{tmp_dir}` for download staging**: Already explicitly declined in v4 review. Not revisited.
- **Deno/Node.js runtime dependency**: Already deferred in v4 review. Not revisited.
- **Windows `.bat` PID capture**: PID files are now also written by `launch.rs`, but the startup script's Windows PID capture mechanism is still left as an implementation detail for `startup.rs`. The issue is acknowledged in the v4 review report but not design-level blocking.

---

## Unresolved Questions

None new — the deferred Deno/Node runtime question carries forward from v4.
