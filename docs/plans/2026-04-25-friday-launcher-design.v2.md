<!-- v2 - 2026-04-25 - Generated via /improving-plans from docs/plans/2026-04-25-friday-launcher-design.md -->

# Friday Launcher — Design (v2)

**Date:** 2026-04-25
**Status:** Drafted — pending implementation

## Problem Statement

Today the Tauri installer's last step (`launch.rs`) directly spawns the five
platform binaries (`friday`, `link`, `playground`, `pty-server`,
`webhook-tunnel`), polls health endpoints, writes pid files, and opens the
browser. Once the wizard closes there is nothing supervising those
processes — if any of them crash, the user sees a broken Studio with no
indicator and no path back to a healthy state. Re-running the installer is
the only way to bring everything back up, and there is no visible
"Friday is running" signal in the user's menu bar / system tray.

The pid-tracking + manual TERM logic in
`extract.rs::terminate_studio_processes` also iterates every binary's pid
file individually, which means each new binary added to the platform tarball
needs three places updated: build script, launch.rs, extract.rs. The
launcher pattern collapses that to one boundary.

## Solution

Introduce **`friday-launcher`** — a new cross-platform Go binary, shipped in
the studio platform tarball alongside the existing five binaries. It owns
the lifetime of Friday Studio after install: it supervises the five backends
via an embedded `process-compose`, renders a tray-icon UI (green / amber /
red), and exposes the platform to the user via the OS's autostart-at-login
mechanism (LaunchAgent on macOS, registry entry on Windows, both managed
through `tauri-plugin-autostart`).

The Tauri installer's only role at install-time becomes "extract files,
register autostart, spawn the launcher, exit." All the supervision +
restart-on-crash + health-aware browser-open behavior lives in one place
the user can see in their menu bar and reach via the tray menu.

## User Stories

1. As a Friday Studio user finishing the install wizard, I want the wizard
   to close and leave a tray icon visible, so I have a persistent indicator
   that Studio is running and a way to interact with it.

2. As a Friday Studio user, I want the browser to open to `localhost:5200`
   automatically once every platform service reports healthy after install,
   so I'm never staring at a blank progress bar wondering if it worked.

3. As a Friday Studio user who restarts their machine, I want Studio to
   come back up automatically without re-launching anything by hand, so my
   platform feels persistent like Slack or Docker Desktop.

4. As a Friday Studio user logging in fresh, I want the autostart path to
   bring Studio up silently without popping a browser tab, so my login
   isn't disrupted.

5. As a Friday Studio user, I want a single menu item in the tray to "Open
   in browser" whenever I need it, so I can come back to Studio without
   keeping a browser tab pinned.

6. As a Friday Studio user, I want the tray icon's color to tell me at a
   glance whether everything is running (green), still coming up (amber),
   or broken (red), so I can debug without first opening the browser.

7. As a Friday Studio user with a flaky `link` process, I want the
   launcher to restart it automatically with backoff, so a transient
   crash doesn't take down my whole session.

8. As a Friday Studio user, I want a "Restart all" tray menu item that
   stops every supervised process and brings them back up cleanly, so a
   visible-bad state has an obvious recovery action.

9. As a Friday Studio user debugging a problem, I want a "View logs" tray
   menu item that opens the launcher's log directory in my OS file
   browser, so I can ship logs to support without hunting paths.

10. As a Friday Studio user who wants to stop the platform, I want a
    "Quit" tray menu item that gracefully shuts down every supervised
    process before exiting, so I don't leave orphan binaries holding
    ports.

11. As a Friday Studio user re-running the installer to update, I want
    the installer to cleanly stop the running launcher (and everything
    under it) before extracting, so file replacement doesn't race with
    a running binary.

12. As a release engineer, I want the launcher binary to be built and
    signed/notarized in the same `studio-build.yml` matrix as every
    other platform binary, so there is no second pipeline to maintain.

13. As a release engineer, I want the launcher to embed the
    `process-compose` binary per-target (no runtime download, no PATH
    dependency), so the user gets a single self-contained file.

14. As a release engineer, I want the installer↔launcher contract to be
    "pid file + SIGTERM" with no IPC port or token, so the installer
    doesn't need to know any launcher internals.

15. As a release engineer, I want process-compose's `open-browser`
    process to depend on every supervised service reporting
    `process_healthy`, so the browser only opens when Studio is
    genuinely usable.

16. As a Friday Studio user during install, I want a single checkbox
    "Start Friday Studio when I log in" (default checked) so I can opt
    out of the autostart behavior at install time.

17. As a Friday Studio user uninstalling Studio, I want the autostart
    entry removed so Studio stops trying to launch after I've removed
    it. (Out of scope for first implementation — see Out of Scope.)

18. As a Friday Studio developer, I want to be able to invoke the
    launcher from the command line (`friday-launcher`,
    `friday-launcher --no-browser`) so I can iterate locally without
    going through the installer.

19. As a Friday Studio developer adding a new supervised binary, I want
    to add it in one place (the launcher's `process-compose.yaml`
    template) and have all the other behavior — restart, health
    polling, browser-open gating, tray status — flow from that single
    edit.

20. As a Friday Studio developer, I want the tray UI's "is everything
    healthy" predicate to be the same predicate process-compose uses
    to gate the open-browser process, so there is one source of truth
    for "Studio is up."

21. As a Friday Studio user opening Spotlight (or Launchpad / Start
    Menu), I want to find "Friday Studio" by name and click it to
    relaunch, so I don't have to re-run the installer just to bring
    the tray back when I've quit it.

22. As a Friday Studio user clicking the Dock icon (macOS) or
    taskbar icon (Windows), I want the same "Open in browser" action
    that the tray menu offers, so the affordances are consistent.

23. As a Friday Studio user logging in for the first time after
    install, I want the tray icon to start in the "starting" (amber)
    state — not red — until the supervised binaries get a chance to
    spin up, so I'm not panicked by a red icon during a normal cold
    boot.

24. As a Friday Studio user who hard-kills the launcher from
    Activity Monitor / Task Manager, I want every supervised binary
    to die with it instead of being orphaned, so my system isn't
    left holding ports nothing is using.

25. As a release engineer running an installer update on a machine
    where the launcher crashed earlier (stale pid file), I want the
    installer to detect the staleness and proceed without sending a
    TERM to whatever process happens to have recycled that pid, so a
    routine update doesn't accidentally kill an unrelated user
    process.

## Implementation Decisions

### New binary: `friday-launcher`

- Lives in `tools/friday-launcher/` as a new Go binary.
- Cross-compiles via the existing `GO_BINARIES` slot in
  `scripts/build-studio.ts` (the same path `pty-server` already uses),
  so it picks up the GOOS/GOARCH matrix and codesign loop for free.
- On macOS, the binary is wrapped into a `Friday Studio.app` bundle as
  part of the studio-build pipeline (see "macOS app bundling" below).
- Ships in the studio platform tarball at the top level on Windows and
  inside the `Friday Studio.app` on macOS.

### Embedded process-compose

- Per-platform `process-compose` release binaries (pinned to **v1.85.x**)
  embedded via Go's `embed` package + per-platform build tags. One
  binary per `(GOOS, GOARCH)` pair: `darwin/arm64`, `darwin/amd64`,
  `windows/amd64`. (`linux/*` follows when we ship Linux.)
- A new step in `scripts/build-studio.ts` fetches the right
  `process-compose` release asset per target and stages it into the
  launcher's `embed` directory before `go build` runs (mirroring the
  existing `EXTERNAL_CLIS` download pattern for `gh` and
  `cloudflared`).
- At first launch, the launcher extracts the embedded `process-compose`
  binary to `~/.friday/cache/process-compose-<sha>` (sha-keyed so old
  versions get cleaned up), `chmod 0755`'s it on Unix, and execs it.

### macOS app bundling (Dock + Spotlight visible)

- The launcher ships as a regular `.app` bundle (NOT `LSUIElement`) so
  the user can find "Friday Studio" via Spotlight, Launchpad, and the
  Dock — the same way Slack / Docker Desktop are reachable after the
  user has quit the tray.
- Both Dock icon and tray icon are visible. Clicking the Dock icon
  routes through the same code path as the tray menu's "Open in
  browser" item.
- Quit from the Dock (right-click → Quit, or `⌘Q` from the Dock app
  menu) routes through the same orderly-shutdown handler as the tray
  menu's Quit item.
- The bundle is created by `scripts/build-studio.ts` per macOS target
  (one `.app` per arch). The `Friday Studio.app/Contents/MacOS/`
  directory contains the launcher binary; the studio platform tarball
  for macOS contains the `.app` at its top level alongside the bare
  Mach-O binaries (`friday`, `link`, `playground`, `pty-server`,
  `webhook-tunnel`).

### process-compose.yaml (Go template, rendered at first launch)

Configures the five binaries plus an `open-browser` process gated on
all five reporting `process_healthy`. Restart policy `always` with
2-second backoff and `max_restarts: 5`.

Readiness probes — verified against actual service implementations:

- `friday`         — HTTP GET `localhost:8080/health`     (apps/atlasd/routes/health.ts)
- `link`           — HTTP GET `localhost:3100/health`     (apps/link/src/index.ts)
- `playground`     — HTTP GET `localhost:5200/api/health` (tools/agent-playground/src/lib/server/router.ts)
- `pty-server`     — HTTP GET `localhost:7681/health`     (tools/pty-server/main.go)
- `webhook-tunnel` — HTTP GET `localhost:9090/health`     (apps/webhook-tunnel/src/index.ts)

Probe tuning to avoid the cold-start RED flash:

- `initial_delay_seconds: 5` per probe — gives each binary 5 s to bind
  its port before the first probe attempt.
- `period_seconds: 2` — once probing starts, retry every 2 s.
- `failure_threshold: 5` — only flip to `Failed` after 5 consecutive
  failures (≈10 s window) so a transient probe miss doesn't turn the
  tray red.

The `open-browser` process is `disabled: true` when `--no-browser` is
passed, so the LaunchAgent / Windows Startup path supervises silently.

### Tray status semantics + cold-start grace period

The tray icon polls `process-compose`'s `GET /processes` REST endpoint
every 2 s and renders one of three states:

| Tray | Meaning | process-compose state |
|------|---------|----------------------|
| 🟢 green | every service Running + is_ready=true | all healthy |
| 🟡 amber | (a) any service Pending/Starting, or (b) launcher process started < 30 s ago, or (c) any service in the failure-threshold window | starting up |
| 🔴 red | any service Failed (after exhausting failure_threshold) or Restarting (>max_restarts) | broken |

The 30 s "post-launch amber regardless" rule is the key UX fix: cold
starts naturally take 5–15 s, and we never want the user's first
post-login experience to be a red icon followed by green. Only after
30 s of post-launch elapsed time + a probe that was previously green
going red do we render red.

### CLI surface

- `friday-launcher` — supervises + opens browser when healthy + tray icon
- `friday-launcher --no-browser` — supervises + tray icon, no browser open

That's it. No subcommands. The tray menu (Restart all / Quit / Open in
browser / View logs) is the user-facing surface; CLI users get the same
two flags.

### Autostart registration (via `tauri-plugin-autostart`)

- The Tauri installer adds the official Tauri 2 plugin
  `tauri-plugin-autostart` (`v2.x`) to its dependency list. This wraps
  the `auto-launch` Rust crate and handles the per-platform mechanism:
  - macOS: `~/Library/LaunchAgents/<bundle-id>.plist`.
  - Windows: `HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run`
    registry entry (more reliable than `.lnk` in Startup; survives
    anti-malware quarantine and Startup-folder cleanup tools).
  - Linux: `~/.config/autostart/<name>.desktop` (free for v2 once we
    ship Linux).
- The installer's API Keys (or Done) step gains one checkbox: *"Start
  Friday Studio when I log in"*, default checked. Action:
  `app.autolaunch().enable("--no-browser")` if checked,
  `app.autolaunch().disable()` if not.
- The launcher itself does not touch autostart files. Only the
  installer's Rust side does, exclusively through the plugin.

### Installer↔launcher contract

- Single touchpoint: `~/.friday/local/pids/launcher.pid`.
- pid file format: `<pid> <start_time_unix_seconds>` (two fields,
  space-separated), so a stale pid pointing at a recycled OS PID can
  be distinguished from a real launcher.
- File-locking: launcher takes a shared `flock` (Unix) /
  `LockFileEx LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY`
  (Windows) on the pid file while running. Installer takes an
  exclusive lock with timeout — failure to acquire = launcher is
  alive; success = stale pid file.
- On install:
  1. Installer attempts the exclusive lock. If acquired immediately,
     the file is stale; remove and proceed to step 4.
  2. If lock fails: installer reads pid + start_time, verifies the
     process exists with that exact start time (via `kqueue`/`/proc`
     on Unix, `GetProcessTimes` on Windows). Mismatched start time =
     stale pid; clean up and proceed.
  3. If verified live: send SIGTERM (`taskkill /PID` on Windows),
     poll for pid disappearance every 500 ms, up to 30 s. Bumped from
     10 s because `process-compose down` can legitimately take 15–20 s
     to TERM all children cleanly.
  4. Extract the new tarball.
  5. Spawn `friday-launcher` (no flag) detached, exit.
- On launcher shutdown (whether triggered by SIGTERM or tray-menu
  Quit): orderly handler runs `process-compose down` (which TERMs all
  children), removes the pid file, releases the lock, exits 0.
- The installer never needs to know the launcher's process-compose
  port or token.

### Hard-kill resilience (process group / Job Object)

If the user kills `friday-launcher` from Activity Monitor / Task
Manager (SIGKILL), the supervised children must die with it — we
cannot leave them orphaned and ports held.

- **Unix (macOS, Linux):** when the launcher spawns
  `process-compose`, set `cmd.SysProcAttr.Setpgid = true` so the
  launcher + process-compose + every supervised binary share a single
  process group. On hard-kill of the launcher, send SIGKILL to the
  whole group. Even if the launcher's own process gets SIGKILL'd
  externally, the OS reaps the group when the process-group leader
  exits.
- **Windows:** wrap the `process-compose` subprocess in a Job Object
  with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. When the launcher
  process exits (gracefully or via TerminateProcess), Windows kills
  every process attached to the Job, including the entire descendant
  tree below process-compose. The pty-server PR (#3012) already
  implemented this exact pattern at
  `tools/pty-server/jobobject_windows.go` — the launcher lifts the
  same code, parameterized only by which child process gets
  Job-attached.

### Tray UI

- `fyne.io/systray` for cross-platform tray icon + menu.
- macOS: regular `.app` bundle with both Dock and tray icon visible
  (NOT `LSUIElement`).
- Windows `.exe` built with `-ldflags="-H=windowsgui"` to suppress
  the console window flash.
- Tray polls process-compose's `GET /processes` REST endpoint every
  2 seconds; renders icon + status string per the Tray Status
  Semantics table above.
- Menu items:
  - "Open in browser" → `pkg/browser.OpenURL("http://localhost:5200")`
  - "Restart all" → POST `/processes/restart` for each
    non-`open-browser` service
  - "View logs" → opens `~/.friday/local/logs/` in OS file browser
  - "Quit" → orderly shutdown handler (same path as SIGTERM)
- Dock-icon click (macOS) and taskbar-icon click (Windows) route
  through the "Open in browser" handler — same as the menu item.

### Tauri installer changes

- `Launch.svelte` becomes a "spawn launcher and close" step, no
  progress UI needed.
- `commands/launch.rs` shrinks dramatically — spawn the launcher
  detached, register the autostart entry per the user's checkbox via
  `tauri-plugin-autostart`, return. No more health polling, pid
  bookkeeping, or browser-open.
- `commands/extract.rs::terminate_studio_processes` reads only
  `pids/launcher.pid` (not every binary's pid). Uses the lock-file +
  start-time-verification protocol described in the contract above.

### Module Boundaries

#### `friday-launcher` binary

- **Interface:** two CLI flags (`--no-browser`), pid file at
  `~/.friday/local/pids/launcher.pid` with `<pid> <start_time>`
  format and exclusive flock semantics, SIGTERM/TERM as the shutdown
  signal. Tray icon + Dock icon visible to the user.
- **Hides:** the existence of `process-compose`, the YAML schema,
  the random local port + token, the embed/extract dance, the
  per-platform health probes, the browser-open trick, the per-service
  restart policy, the cold-start grace-period logic, the process
  group / Job Object machinery.
- **Trust contract:** if `friday-launcher` holds the exclusive lock
  on `pids/launcher.pid`, Friday Studio is being supervised. SIGTERM
  brings everything down cleanly; SIGKILL still brings everything
  down via process group / Job Object.

#### Tauri installer

- **Interface:** wizard UI; final step spawns the launcher and
  writes the autostart entry via `tauri-plugin-autostart`.
- **Hides:** download + sha-verify + extract + autostart-mechanism
  details; arch detection; pid-file lock + start-time verification
  protocol.
- **Trust contract:** when the wizard's *Done* screen renders, the
  launcher is running and (if the user kept the checkbox) the OS will
  re-spawn it at next login.

#### process-compose subprocess

- **Interface:** YAML manifest on stdin / file path; REST API on a
  random loopback port with token-file auth.
- **Hides:** restart policies, health probing, dependency ordering,
  signal forwarding to children.
- **Trust contract:** if `GET /processes` reports every service
  `is_ready: true`, those services have all responded successfully
  to their readiness probes within the last polling interval.

## Testing Decisions

A good test exercises the launcher's *external* behavior: pid file
appears + disappears at the right times, tray status reflects
process-compose state, SIGTERM brings everything down cleanly,
SIGKILL brings everything down via process group / Job Object,
stale pid files don't cause the installer to TERM unrelated
processes.

Modules tested:

- **Launcher orderly shutdown**: integration test that spawns the
  launcher with a stub `process-compose.yaml` (3 trivial Go HTTP
  servers as the "supervised" set), verifies the pid file appears
  with expected `<pid> <start_time>` format, sends SIGTERM, asserts
  pid file is gone and all child pids exited within the timeout.
  Same shape as the existing pty-server `protocol_test.go`
  integration tests (real subprocesses, no mocks).
- **Hard-kill resilience**: spawn the launcher, capture child pids,
  SIGKILL the launcher process, assert all child pids exited within
  ~5 s (kernel reaps the process group). Windows variant: kill the
  launcher with `taskkill /F`, assert children die via Job Object.
- **Pid-file staleness handling**: write a stale pid file pointing
  at the test-harness's own pid (which won't match the recorded
  start_time), invoke the installer's stop-launcher routine, assert
  it cleans up the stale file without sending TERM to the harness.
- **Embed/extract**: unit test that the embedded `process-compose`
  bytes match the expected sha for the host platform, and that
  extraction is idempotent (running the launcher twice doesn't
  re-write the cache file).
- **Tray status predicate**: unit test against captured JSON from
  `process-compose`'s `/processes` endpoint — verifies the green /
  amber / red mapping is total (every state combination resolves to
  exactly one color), AND that within the 30 s post-launch grace
  window the predicate never returns red regardless of probe state.
- **Installer↔launcher handoff**: end-to-end smoke test on a real
  Mac that runs the installer, verifies the launcher pid file
  appears, then re-runs the installer and verifies the previous
  launcher exited before extract started.

Prior art:

- `tools/pty-server/protocol_test.go` — testify-style integration
  tests against real subprocesses, ~22 tests, passing with `-race`.
- `tools/pty-server/jobobject_windows.go` — direct prior art for the
  Job Object pattern used here.
- `apps/studio-installer/src-tauri/src/commands/*.rs` — existing
  Rust command tests in the installer.

## Out of Scope

- **Auto-update of the studio tarball.** The launcher does not
  download or apply platform updates; the Tauri installer keeps that
  responsibility for the first ship. Sparkle-style auto-update from
  the launcher is a follow-up.
- **Linux platform target.** macOS arm/intel + Windows only,
  matching the existing studio-build matrix.
- **Uninstall flow.** Removing the autostart entry on uninstall is
  important but not part of v1 — currently we don't have an
  uninstaller at all.
- **Windows EV-cert signing for SmartScreen.** Same as the rest of
  the platform — we ship with a self-signed cert and accept the
  SmartScreen warning.
- **Running as a system-level service** (root launchd LaunchDaemon /
  Windows Service). User-session only, because tray icons require an
  active session.
- **Logging out + back in mid-update.** If the user logs out during
  a Tauri-installer-driven update, the launcher autostarts at next
  login and may collide with extraction. We assume the user keeps
  their session alive while the wizard is running.
- **Log rotation for supervised processes.** process-compose collects
  child stdout/stderr; for v1 we accept unbounded growth. A follow-up
  can configure per-process `log_configuration` with rotation.
- **Per-service tray status detail.** v1 tray collapses all five
  services into one tri-state icon. A follow-up can add a
  per-service submenu (`friday ●  link ●  playground ✕ restarting…`).

## Further Notes

- The launcher binary size will be roughly the size of a Go binary
  (~5 MB) plus the embedded `process-compose` (~20 MB) plus the
  `fyne.io/systray` runtime — call it 30 MB pre-codesign. Well within
  the noise of the existing 1.1 GB platform tarball.
- The `process-compose` subprocess does NOT need to know it's
  embedded. It reads our YAML, exposes its REST API to the launcher
  only on the loopback address, and exits when we tell it to. The
  launcher is the only consumer of its REST surface — no public
  network port is opened.
- Tray icon on macOS supports template images (B/W rendering that
  adapts to dark/light mode); we should ship the icon as a template
  PNG. Same icon flipped to red/amber for status states. The Dock
  icon is the regular full-color app icon (separate asset).
- All five service `/health` endpoints already exist (verified
  against current source — no follow-up commits needed before the
  launcher can ship).
- We can dogfood the launcher locally by running
  `go run ./tools/friday-launcher` after `deno task playground`
  builds the supervised binaries.
- `process-compose` v1.85.x is the pinned version; if we bump it,
  re-verify that `GET /processes`, `POST /processes/restart`, and
  `POST /project/stop` still match the launcher's REST client.
