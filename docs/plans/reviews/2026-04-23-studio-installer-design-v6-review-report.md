# Review Report: studio-installer-design v6

**Reviewed:** 2026-04-23  
**Plan:** `docs/plans/2026-04-23-studio-installer-design.v6.md`  
**Output:** `docs/plans/2026-04-23-studio-installer-design.v7.md`  
**Reviewer:** /improving-plans

---

## Context Gathered

Read full v6 plan and all five prior review reports (v1–v5) to avoid retreading resolved issues. Verified the `launch.rs` module boundary against the startup env var requirements documented in `startup.rs`'s trust contract. Compared the two process-spawning paths (installer's `launch.rs` vs generated startup script) for env var consistency.

---

## Issues Found and Resolutions

### Issue 1: `launch.rs` spawns processes without the env vars they require ✅ FIXED (architecture change)

**Problem:** `startup.rs`'s trust contract documents that the generated script sets `ATLAS_LOCAL_ONLY=true`, `LINK_DEV_MODE=true`, `ATLAS_KEY`, `ATLASD_URL`, `VITE_EXTERNAL_DAEMON_URL`, `VITE_EXTERNAL_TUNNEL_URL`, and binary path overrides. But `launch.rs` — the other spawning path, used during the installer's own Launch step — has no mention of env var injection. An implementer reading only the `launch.rs` section would spawn all five processes without the required environment: `link` can't authenticate, `agent-playground` can't reach the daemon, and the stack silently misfires even though all `try_wait` checks pass.

**Resolution adopted:** Architecture change — **apps read env files themselves; installer only sets `FRIDAY_HOME`.**

Instead of `launch.rs` injecting individual env vars, all configuration (both user API keys and platform-internal vars) lives in `$FRIDAY_HOME/.env` (`~/.friday/local/.env` on macOS, `%USERPROFILE%\.friday\local\.env` on Windows). `launch.rs` sets `FRIDAY_HOME` to the platform-appropriate path when spawning each process; apps read their own config from `$FRIDAY_HOME/.env` at startup.

Consequences across the plan:

- **`env_file.rs`** — expanded from user-key-only to writing platform-internal vars as well: `ATLAS_LOCAL_ONLY=true`, `LINK_DEV_MODE=true`, `ATLAS_KEY` (fixed JWT, generated in Rust at install time — no Node.js needed), `ATLASD_URL=http://localhost:8080`, `VITE_EXTERNAL_DAEMON_URL=http://localhost:8080`, `VITE_EXTERNAL_TUNNEL_URL=http://localhost:9090`. All vars are merge-preserved (existing values never overwritten). `ATLAS_KEY` is a compile-time constant: base64url(header) + "." + base64url(payload) + ".local", computed in Rust without a Node.js dependency.

- **`launch.rs`** — simplified. No longer injects individual env vars. Sets `FRIDAY_HOME` for all spawned processes. Trust contract updated accordingly.

- **`startup.rs`** — simplified. Script no longer hardcodes platform-internal vars or generates `ATLAS_KEY` via Node.js. Instead, script sets `FRIDAY_HOME` and starts processes; apps read from `$FRIDAY_HOME/.env` themselves. Test assertions updated to check for `FRIDAY_HOME` instead of individual platform vars.

**Testing added:** `env_file.rs` — platform vars present after fresh write (ATLAS_LOCAL_ONLY, ATLAS_KEY, ATLASD_URL, VITE_EXTERNAL_*); pre-existing platform vars not overwritten on repeat call. `launch.rs` — spawned processes have `FRIDAY_HOME` in their environment.

---

## Items Not Changed (and Why)

- **`{tmp_dir}` for download staging**: Accepted in v4. Not revisited.
- **Deno/Node.js runtime dependency**: Deferred in v4. Not revisited. Note: the `startup.rs` simplification removes the Node.js JWT generation from the startup script, reducing (but not eliminating) the Node.js dependency surface — pty-server still requires it at runtime.
- **Windows `.bat` PID capture**: Acknowledged in v4. Not a design-level blocker.

---

## Unresolved Questions

None new — the deferred Deno/Node runtime question carries forward from v4.
