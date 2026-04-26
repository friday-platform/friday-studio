# Review: 2026-04-25-friday-launcher-design.md (v1)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review
**Output:** v2 plan at `docs/plans/2026-04-25-friday-launcher-design.v2.md`

## Context Gathering

Verified against the actual codebase via Explore agent. Key findings that
ground the review:

- **All five `/health` endpoints exist exactly as the plan claims.** No
  prerequisite "add /health to X" follow-up commits needed before the
  launcher can ship. Specifically:
  - `apps/atlasd/routes/health.ts` — `GET /health` on 8080
  - `apps/link/src/index.ts` — `GET /health` on 3100
  - `tools/agent-playground/src/lib/server/router.ts` — `GET /api/health` on 5200
  - `tools/pty-server/main.go` — `GET /health` on 7681
  - `apps/webhook-tunnel/src/index.ts` — `GET /health` on 9090
- **No autostart plumbing exists today.** No references to "autostart",
  "LaunchAgent", "RunAtLoad", or Startup-folder anywhere in the repo.
  No `tauri-plugin-autostart` in `Cargo.toml`. The plan's
  installer-owned autostart story is greenfield.
- **No `process-compose` references** anywhere in the repo. Brand-new
  pattern.
- **No auto-update plumbing** anywhere. Plan correctly defers this.
- **PID-file conventions today** — `~/.friday/local/pids/<name>.pid`,
  bare `<pid>` plaintext format. Plan's launcher pid file inherits the
  directory but reuses only one entry.
- **Job Object pattern already exists** in `tools/pty-server/jobobject_windows.go`
  — direct prior art for the launcher's hard-kill resilience story.

## Ideas Raised + Decisions

### 1. macOS app form factor — tray-only is too restrictive

**Reviewer recommendation:** Regular `.app` with both Dock + tray icon
(NOT `LSUIElement=true`) so users can find "Friday Studio" via
Spotlight / Launchpad / Dock. Matches Slack and Docker Desktop's
distribution shape.

**Tradeoff against current plan:** v1 said "menu-bar-only" which
makes the app invisible to Spotlight — once the user quits the tray
they have no path back except re-running the installer.

**User decision:** **Accepted (A — recommended).** Spotlight discoverability
is required.

**Rolled into v2:** New "macOS app bundling (Dock + Spotlight visible)"
section in Implementation Decisions. New user stories #21 and #22 capture
the Spotlight + Dock-click affordances.

### 2. Use `tauri-plugin-autostart` instead of writing autostart code by hand

**Reviewer recommendation:** Add `tauri-plugin-autostart` (v2.x). It
wraps `auto-launch` Rust crate; one API
(`app.autolaunch().enable()/.disable()`) handles macOS LaunchAgent,
Windows registry (HKCU\...\Run), and Linux `~/.config/autostart`.

**Tradeoff against current plan:** v1 said the installer would write
a LaunchAgent plist by hand on macOS and a `.lnk` shortcut in
`Startup\` on Windows. The Startup-folder approach is fragile —
anti-malware tools sweep it, and registry-based autostart is the
Windows convention.

**User decision:** **Accepted (A — recommended).**

**Rolled into v2:** "Autostart registration" section now specifies
the plugin and HKCU registry mechanism on Windows. Plus a note that
Linux comes for free when we add it.

### 3. Probe grace period — tray shouldn't flash RED on every cold start

**Reviewer recommendation:** Two-part fix:
- (a) `initial_delay_seconds: 5` + `period_seconds: 2` +
  `failure_threshold: 5` per readiness probe in the YAML, so probes
  give binaries time to bind before counting failures.
- (b) Tray status predicate: any "all-services-healthy" check returns
  amber (not red) for the first 30 s after launcher start, regardless
  of probe state. Only flips to red after probes were green and went
  bad.

**Tradeoff against current plan:** v1 didn't specify probe tuning,
so process-compose defaults would render the tray red for ~10 s on
every login during the cold-start window. Trains users to ignore
red.

**User decision:** **Accepted (A — recommended).**

**Rolled into v2:** New "Tray status semantics + cold-start grace
period" section with a state→color table, plus probe-tuning fields
in the process-compose YAML section. New user story #23 captures
the cold-boot UX requirement. Test for the predicate's
"never-red-in-first-30s" property added to Testing Decisions.

### 4. Pid-file race during update

**Reviewer recommendation:** Three-part hardening:
- pid file format = `<pid> <start_time_unix>` not bare `<pid>`.
- File-lock the pid file (`flock` Unix / `LockFileEx` Windows) — the
  installer's lock-acquire success means the pid file is stale.
- Verify the running process's actual start time matches the
  recorded start time before sending TERM, so a recycled OS PID
  can't accidentally get killed.
- Bump TERM-then-wait timeout from 10 s to 30 s with 500 ms polling
  (process-compose down can take 15-20 s legitimately).

**Tradeoff against current plan:** v1 had three real failure modes
unhandled: (a) stale pid → kill recycled PID, (b) concurrent
launcher → installer kills wrong instance, (c) 10 s sleep too short
on busy systems.

**User decision:** **Accepted (A — recommended).**

**Rolled into v2:** "Installer↔launcher contract" section rewrites
the protocol to specify lock+start-time verification. Test for
stale-pid handling added. New user story #25 captures the staleness
requirement.

### 5. Orphan-process resistance when launcher is hard-killed

**Reviewer recommendation:** Process group on Unix
(`SysProcAttr.Setpgid = true`) + Windows Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. The pty-server PR (#3012)
already wrote the Windows half at
`tools/pty-server/jobobject_windows.go` — the launcher lifts the
same code.

**Tradeoff against current plan:** v1 only addressed graceful TERM
shutdown. SIGKILL of the launcher (Activity Monitor, Task Manager,
or a launcher crash) would leave every supervised binary as an
orphan holding ports.

**User decision:** **Accepted (A — recommended).**

**Rolled into v2:** New "Hard-kill resilience" section in
Implementation Decisions, referencing the pty-server prior art.
Hard-kill integration test added to Testing Decisions. New user
story #24 captures the requirement.

## Ideas Considered and Discarded

(None — all five raised ideas made it into the recommendation set.
Below are ideas that surfaced during context gathering but were
deemed not worth adding noise about.)

- **Binary naming (`friday-launcher` vs `friday-tray` vs
  `friday-studio`).** Naming the binary `friday-launcher` is fine;
  what matters for the user is the .app's display name ("Friday
  Studio"), which v2 now specifies for macOS.
- **process-compose REST-API token-vs-no-token.** v2 keeps the
  token-file plumbing — same-user trust boundary is fine, and
  process-compose's defaults set the token regardless. Not worth
  fighting.
- **Log rotation.** Real concern but out-of-scope for v1; added
  explicitly to Out of Scope rather than addressed in detail.
- **Per-service tray status detail.** Same — moved to Out of Scope
  with a "follow-up can add submenu" note.

## Unresolved Questions

None. All five recommendations were accepted as proposed.

One thing to double-check during implementation but not blocking the
plan:

- **process-compose v1.85.x REST stability.** v2 pins the version;
  during implementation, verify `GET /processes`, `POST /processes/restart`,
  and `POST /project/stop` exist with those exact paths in v1.85. If
  the REST surface changed since v1.85 was researched, the launcher's
  tray-poll + restart-all + quit handlers need to track that. Noted
  in v2's Further Notes section.
