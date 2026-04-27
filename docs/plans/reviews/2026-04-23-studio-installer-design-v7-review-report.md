# Review Report: studio-installer-design v7

**Reviewed:** 2026-04-23  
**Plan:** `docs/plans/2026-04-23-studio-installer-design.v7.md`  
**Output:** `docs/plans/2026-04-23-studio-installer-design.v8.md`  
**Reviewer:** /improving-plans

---

## Context Gathered

Read full v7 plan and all six prior review reports (v1–v6) to avoid retreading resolved issues. Verified `docker/run-platform.sh` binary path override vars against installer context. Confirmed no new design gaps exist.

---

## Issues Found and Resolutions

### Issue 1: Binary path overrides (`ATLAS_NPX_PATH` etc.) absent from v7 ❌ NOT A GAP

**Finding:** `docker/run-platform.sh` exports `ATLAS_NPX_PATH=/usr/bin/npx`, `ATLAS_NODE_PATH=/usr/bin/node`, `ATLAS_CLAUDE_PATH=/usr/local/bin/claude`, `ATLAS_SQLITE3_PATH=/usr/bin/sqlite3`. These were in v6's `startup.rs` trust contract but absent from v7. Raised as a potential gap.

**User decision:** Not needed. These are Docker-specific paths pointing to system binaries inside the container (`/usr/bin/*`, `/usr/local/bin/*`). They are not applicable to a local macOS/Windows installer where apps use PATH discovery or bundled binaries at known relative locations. v7 was correct to drop them.

**Why not adopted:** Would add Docker-world assumptions to an installer that explicitly does not run in a container. The `FRIDAY_HOME` architecture is sufficient.

---

## Items Not Changed (and Why)

- **All prior deferred items** (tmp_dir, Deno/Node runtime, Windows PID): unchanged from v4–v6.
- **FRIDAY_HOME architecture**: validated — no gaps identified.
- **`env_file.rs` static platform vars**: complete as documented.
- **`launch.rs` simplified trust contract**: correct — sets `FRIDAY_HOME`, apps read `$FRIDAY_HOME/.env`.

---

## Unresolved Questions

None — the deferred Deno/Node runtime question carries forward from v4. No new unresolved questions.
