# Review Report: studio-installer-design v3

**Reviewed:** 2026-04-23  
**Plan:** `docs/plans/2026-04-23-studio-installer-design.v3.md`  
**Output:** `docs/plans/2026-04-23-studio-installer-design.v4.md`  
**Reviewer:** /improving-plans

---

## Context Gathered

Reviewed `docker/run-platform.sh` and `Dockerfile-platform` in the monorepo. These are the authoritative sources for how Friday Platform actually starts — they reveal two issues that the plan under-specified and one issue with the download checkpoint design.

---

## Issues Found and Resolutions

### Issue 1: `launch.rs` has no backend health gates — agent-playground shows 500 errors on first open ✅ FIXED

**Problem:** `run-platform.sh` (the actual platform entrypoint) explicitly polls `http://localhost:8080/health` and `http://localhost:3100/health` before spawning agent-playground, because agent-playground proxies to atlasd on load and produces 500s in the browser if started while atlasd is still initializing. The v3 plan's `launch.rs` spawns all five processes sequentially with `try_wait(100ms)` per process, but `try_wait(100ms)` only catches immediate crashes — it does not detect "process started but backend isn't ready yet." agent-playground boots via Vite in ~2s regardless of whether atlasd is healthy. Port 5200 becomes reachable, `launch.rs` returns `Ok`, the browser opens, and the user sees HTTP 500 errors on the very first load.

**Resolution adopted:** Option A — `launch.rs` now splits the spawn sequence into two phases:
1. Spawn atlas + link, then poll `http://localhost:8080/health` and `http://localhost:3100/health` (30s timeout each) before proceeding.
2. Only after both backend health checks pass: spawn agent-playground, pty-server, webhook-tunnel.
3. Existing port 5200 poll remains as the final liveness gate.

Trust contract corrected: "On `Ok`, all backend services (atlas, link) passed their health checks before any frontend process was spawned, all five processes passed the 100ms immediate-exit check, and port 5200 became reachable within 30s."

**Testing added:** `launch.rs` — atlasd health endpoint not reachable within 30s → returns `Err("atlasd did not become healthy within 30s")`; agent-playground spawn is not attempted until both backend health checks pass.

---

### Issue 2: `startup.rs` generated script missing platform env vars that each process requires ✅ FIXED

**Problem:** `run-platform.sh` reveals ~8 additional environment variables required by the platform processes beyond what `~/.friday/local/.env` provides. Without these, services fail at startup in non-obvious ways:
- Without `ATLAS_LOCAL_ONLY=true`: `link` tries to connect to a remote credential API and fails
- Without auto-generated `ATLAS_KEY` JWT: skill publish, workspace creation, and user identity all fail
- Without `LINK_DEV_MODE=true`: Deno KV fallback in `link` is disabled
- Without `ATLASD_URL=http://localhost:8080`: webhook-tunnel cannot connect to the daemon
- Without `VITE_EXTERNAL_DAEMON_URL`/`VITE_EXTERNAL_TUNNEL_URL`: agent-playground can't proxy to the daemon or tunnel

The v3 `startup.rs` trust contract said "starts all five Studio processes and is idempotent" but gave no guidance on what environment the script sets. An implementor building from the plan would ship a startup script that crashes at runtime in non-obvious ways.

**Resolution adopted:** Option A — expanded `startup.rs` trust contract and implementation section to explicitly specify that the generated startup script:
1. **Sources** `~/.friday/local/.env` for user-provided API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY)
2. **Hardcodes** platform-internal env vars: `ATLAS_LOCAL_ONLY=true`, `LINK_DEV_MODE=true`, `ATLASD_URL=http://localhost:8080`, `VITE_EXTERNAL_DAEMON_URL=http://localhost:8080`, `VITE_EXTERNAL_TUNNEL_URL=http://localhost:9090`
3. **Generates** `ATLAS_KEY` inline using Node.js (same technique as `run-platform.sh`) — a local JWT providing user identity for the single-user local install
4. **Sets** binary path overrides for `npx`, `node`, `claude`, `sqlite3` derived from `install_dir`

The plan now cross-references `docker/run-platform.sh` as the authoritative source for platform env requirements.

**Testing added:** `startup.rs` — assert generated script contains `ATLAS_LOCAL_ONLY=true`; `LINK_DEV_MODE=true`; `ATLASD_URL=http://localhost:8080`; `VITE_EXTERNAL_DAEMON_URL`/`VITE_EXTERNAL_TUNNEL_URL`; Node.js JWT generation snippet; and sources `.env` file.

---

### Issue 3: `localStorage` download checkpoint doesn't survive partial file deletion ✅ FIXED

**Problem:** The plan used `localStorage.setItem('download:complete', 'true')` as a checkpoint to skip re-downloading if the installer was reopened after a completed download. However, `localStorage` is not coupled to the file on disk. After a checksum failure, `installer.ts` correctly calls `delete_partial(platform)` to delete the corrupt partial — but does not clear the `localStorage` flag. On the next installer launch: the code reads `download:complete = true` from localStorage, skips the download, attempts to verify a file that no longer exists, and `verify.rs` returns `Err` (IO error) rather than `Ok(false)` — hitting an unexpected error path instead of a clean retry.

Additionally, `localStorage` in Tauri persists in the WebView storage, which may or may not survive app reinstalls depending on OS behavior — making the checkpoint unreliable in both directions.

**Resolution adopted:** Option A — replaced `localStorage` checkpoint with a file-based marker:
- New `download_checkpoint.rs` module with two commands:
  - `mark_download_complete(platform: String) → Result<(), String>`: writes `{tmp_dir}/friday-studio-{platform}.complete`
  - `check_download_complete(platform: String) → Result<bool, String>`: checks for `.complete` file existence
- Updated `delete_partial.rs` trust contract: now deletes **both** `.partial` and `.complete` atomically. A single `delete_partial` call fully resets download state for the platform.
- `installer.ts` now calls `check_download_complete(platform)` instead of reading localStorage. After `Done` event from `download_file`, calls `mark_download_complete(platform)` before invoking `verify_sha256`.
- All `localStorage` download checkpoint references removed from the plan.

**Testing added:** `download_checkpoint.rs` — mark then check returns `true`; check without mark returns `false`; `delete_partial` clears both `.partial` and `.complete`, post-delete check returns `false`.

---

## Clarifications Made Explicit

- **`launch.rs` process groups**: Two explicit phases — (1) backend: atlas, link; (2) frontend: agent-playground, pty-server, webhook-tunnel. Health gates run between phases. Order within each phase is sequential with `try_wait(100ms)` per process.
- **`startup.rs` env source split**: User env (API keys) comes from `.env` file; platform env (service coordination vars) is hardcoded in the script. No mixing.
- **`ATLAS_KEY` JWT format**: Header=`{alg:"HS256",typ:"JWT"}`, payload=`{iss:"friday-platform",email:"platform-local@hellofriday.ai",sub:"local-user",user_metadata:{tempest_user_id:"local-user"}}`, signature=`"local"` — matches what `run-platform.sh` generates. Not a real JWT (no actual signing) but accepted by the link service in `ATLAS_LOCAL_ONLY` mode.
- **Cross-reference added**: Plan now notes `docker/run-platform.sh` as the authoritative reference for platform startup sequence and env requirements.

---

## Items Not Changed (and Why)

- **5-process startup sequence order**: Changed from single-phase to two-phase (backends first), but within each phase the order from v3 is preserved.
- **30s port 5200 poll**: Unchanged. The backend health polls use the same 30s timeout pattern — consistent UX, same spinner timing.
- **`delete_partial.rs` interface**: Extended (now also deletes `.complete`), not changed. Callers only call `delete_partial` to reset download state — they don't need a separate "delete complete" command.

---

## Unresolved Questions

None — all three issues resolved with Option A.
