<!-- v3 - 2026-04-25 - Generated via /improving-plans from docs/plans/2026-04-25-friday-launcher-design.v2.md -->

# Friday Launcher — Design (v3)

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
by importing **process-compose** as a Go library (not a subprocess), renders
a tray-icon UI (green / amber / red), and exposes the platform to the user
via the OS's autostart-at-login mechanism (LaunchAgent on macOS, registry
entry on Windows, both managed through `tauri-plugin-autostart`).

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

13. As a release engineer, I want process-compose pulled in as a Go
    library dependency (not a separate embedded binary), so the
    launcher is a single self-contained Go process with no subprocess
    bookkeeping.

14. As a release engineer, I want the installer↔launcher contract to be
    "pid file + SIGTERM" with no IPC port or token, so the installer
    doesn't need to know any launcher internals.

15. As a release engineer, I want the launcher to use process-compose's
    own `IsReady()` predicate as the source of truth for "is everything
    ready," so the predicate drives both the tray color and the
    open-browser timing.

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
    to add it in one place (the launcher's `types.Project` builder) and
    have all the other behavior — restart, health polling, browser-open
    gating, tray status — flow from that single edit.

20. As a Friday Studio developer, I want the tray UI's "is everything
    healthy" predicate to be the same predicate that gates the
    open-browser action, so there is one source of truth for "Studio is
    up."

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

### Imported process-compose library (NOT embedded binary)

The launcher imports process-compose directly as a Go module:

- `github.com/f1bonacc1/process-compose` — pinned via `go.mod`. No
  version pinning by string; resolution happens at `go build` time.
- Public entry point: `app.NewProjectRunner(opts *app.ProjectOpts) (*app.ProjectRunner, error)`.
  This is the same constructor `cmd.Execute()` uses internally.
- Project configuration is built programmatically as a typed
  `types.Project` struct — no YAML rendering, no template strings, no
  per-platform `OpenCmd` substitution.
- The launcher runs `runner.Run()` in a goroutine; on its own main
  loop it calls `runner.GetProcessesState()` directly to read state
  for the tray and to gate the browser-open.

**What disappears compared to v2's embed-binary model:**

- No `embed.FS` of per-platform process-compose binaries (-20 MB).
- No sha-keyed extract to `~/.friday/cache/process-compose-<sha>`.
- No port allocation (`net.Listen("tcp", "127.0.0.1:0")` dance).
- No token file or `--token-file` flag plumbing.
- No REST polling — direct typed Go method calls instead.
- No "what if process-compose dies" failure mode — process-compose
  is a goroutine inside our PID, not a child process.
- No `open-browser` YAML process with platform-specific `OpenCmd`.
  Browser-open is one Go line in the launcher's main loop (see
  "Browser-open" below).

**API stability risk:** `app.NewProjectRunner` and `types.Project` are
public APIs but may evolve with process-compose releases. Mitigations:
(a) pin a specific version in `go.mod`; (b) bump deliberately and
re-verify the launcher's integration tests pass; (c) treat
process-compose as a dep we own — if upstream breaks us, fork or
submit upstream patches.

### Project configuration (typed Go struct, not YAML template)

The launcher constructs a `types.Project` programmatically with five
processes plus the dependency edges between them. The five process
configs are defined in a single Go slice; adding a sixth supervised
binary is one struct literal added to the slice.

Readiness probes — verified against actual service implementations:

| Process | Health URL | Source |
|---|---|---|
| `friday`         | `http://127.0.0.1:8080/health`     | apps/atlasd/routes/health.ts |
| `link`           | `http://127.0.0.1:3100/health`     | apps/link/src/index.ts |
| `playground`     | `http://127.0.0.1:5200/api/health` | tools/agent-playground/src/lib/server/router.ts |
| `pty-server`     | `http://127.0.0.1:7681/health`     | tools/pty-server/main.go |
| `webhook-tunnel` | `http://127.0.0.1:9090/health`     | apps/webhook-tunnel/src/index.ts |

Probe tuning to avoid the cold-start RED flash (set on each
`ReadinessProbe`):

- `InitialDelay: 5s` — gives each binary 5 s to bind its port before
  first probe.
- `PeriodSeconds: 2` — once probing starts, retry every 2 s.
- `FailureThreshold: 5` — only flip to `Failed` after 5 consecutive
  failures (≈10 s window).

Restart policy on every supervised process:
`RestartPolicy: ProcessRestartPolicyAlways` with `BackoffSeconds: 2`
and `MaxRestarts: 5`.

There is no `open-browser` process in the config — browser-opening is
handled by the launcher's main loop directly (see next section).

### Browser-open (Go code, not a process-compose process)

When the launcher's main loop polls `runner.GetProcessesState()` and
the result satisfies `state.IsReady()` for the first time during this
launcher's lifetime AND `--no-browser` was not passed, the launcher
calls `browser.OpenURL("http://localhost:5200")` from
`github.com/pkg/browser`.

A boolean `openedBrowserThisSession` guard ensures we open at most
once per launcher process. "Restart all" from the tray does NOT
reopen the browser — only the initial first-healthy moment does, plus
explicit user click of the "Open in browser" tray menu item.

### Tray status mapping (uses process-compose's own predicate)

The launcher's main loop polls `runner.GetProcessesState()` every 2 s
and renders one of three states. The predicate is process-compose's
own typed methods, NOT a hand-rolled "is_ready=true" string check
(which would be wrong — see v2 review report).

Source of truth for "is everything ready?":

```go
state, _ := runner.GetProcessesState()
if state.IsReady() {
    // ...all processes healthy per process-compose's own predicate
}
```

`(p *ProcessState) IsReadyReason() (bool, string)` is used for
per-process reasons in the tray tooltip / log output.

Tray color matrix — derived from process-compose's `Status` enum
(12 values) crossed with `Health` (3 values), collapsed into three
buckets:

| Bucket | Rule |
|---|---|
| 🟢 green | `state.IsReady() == true` (every supervised process Status ∈ {Running, Foreground, Launched, Completed} AND Health ∈ {Ready, Unknown}) |
| 🔴 red   | any process Status ∈ {Error} OR (Status == Restarting AND Restarts ≥ MaxRestarts) — only AFTER the 30 s post-launch grace window has elapsed |
| 🟡 amber | everything else — covers Pending, Launching, Restarting (within max), Terminating, Scheduled, AND any state during the first 30 s of post-launch elapsed time |

The 30 s post-launch "always amber" rule is the cold-start UX fix:
binaries take a few seconds to bind their ports during a fresh login;
a red flash before they go green would train users to ignore red.

### CLI surface

- `friday-launcher` — supervises + opens browser when healthy + tray icon
- `friday-launcher --no-browser` — supervises + tray icon, no browser open

That's it. No subcommands. The tray menu (Restart all / Quit / Open in
browser / View logs) is the user-facing surface; CLI users get the same
two flags.

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
- The `.app` lives in `~/.friday/local/Friday Studio.app` — extracted
  there by the Tauri installer, never copied to `/Applications`. The
  Done screen of the installer wizard explicitly tells the user
  "Friday Studio is installed in your home folder; find it via
  Spotlight or the menu-bar icon." This avoids the two-copies-out-of-sync
  problem that arises if the user drags it to `/Applications`.

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
     poll for pid disappearance every 500 ms, up to 30 s.
  4. Extract the new tarball.
  5. Spawn `friday-launcher` (no flag) detached, exit.
- On launcher shutdown (whether triggered by SIGTERM or tray-menu
  Quit): orderly handler calls `runner.ShutDownProject()` (which TERMs
  all supervised processes), removes the pid file, releases the
  lock, exits 0.
- The installer never needs to know the launcher's process-compose
  details (no port, no token, no REST surface exists at all).

### Hard-kill resilience (Job Object on Windows; cleanup-on-restart on Unix)

If the user kills `friday-launcher` from Activity Monitor / Task
Manager (SIGKILL), the supervised children must die with it — we
cannot leave them orphaned and ports held.

- **Windows:** at launcher startup, `CreateJobObject` +
  `AssignProcessToJobObject(self)` + set
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` via
  `SetInformationJobObject`. Child processes spawned by the launcher
  (and grandchildren, since process-compose runs in-process and spawns
  via `os/exec`) automatically inherit the Job. When the launcher
  process exits — gracefully or via TerminateProcess — the kernel
  kills every Job member. The pty-server PR (#3012) implemented this
  pattern at `tools/pty-server/jobobject_windows.go`; the launcher
  lifts the same code.
- **macOS / Unix:** kernel does not provide an equivalent guarantee
  (children are reparented to launchd/init when the parent dies).
  Two-part mitigation:
  - **In-process supervision:** since process-compose runs as a
    library inside the launcher PID, all supervised binaries are
    direct children of the launcher process group. SIGTERM of the
    launcher delivers an orderly shutdown via `runner.ShutDownProject()`.
    For SIGTERM specifically (the common case), no orphans.
  - **Cleanup-on-next-start:** the launcher writes the pids of every
    supervised binary it spawned into `~/.friday/local/pids/<name>.pid`.
    On a fresh launcher startup (e.g. after a SIGKILL'd previous
    instance), the launcher reads any pre-existing per-process pid
    files, sends SIGTERM to anything still alive whose start time
    matches what the pid file recorded, then deletes the stale files.
    This is best-effort; orphaned ports may be held briefly between
    SIGKILL and next launcher start.
- Documented as a known limitation: hard-killing the launcher on macOS
  may leave supervised binaries running until the next launcher start;
  graceful exit via tray menu / SIGTERM has no orphan risk.

### Tray UI

- `fyne.io/systray` for cross-platform tray icon + menu.
- macOS: regular `.app` bundle with both Dock and tray icon visible
  (NOT `LSUIElement`).
- Windows `.exe` built with `-ldflags="-H=windowsgui"` to suppress
  the console window flash.
- Tray polls `runner.GetProcessesState()` every 2 seconds; renders
  icon + status string per the Tray Color Matrix above.
- Menu items:
  - "Open in browser" → `pkg/browser.OpenURL("http://localhost:5200")`
  - "Restart all" → `runner.RestartProcess(name)` for each supervised
    process (loops over the typed `types.Project.Processes` list)
  - "View logs" → opens `~/.friday/local/logs/` in OS file browser
  - "Quit" → orderly shutdown handler (same path as SIGTERM)
- Dock-icon click (macOS) and taskbar-icon click (Windows) route
  through the "Open in browser" handler — same as the menu item.

### Launcher logging

- Launcher's own log: `~/.friday/local/logs/launcher.log` (rotated by
  the launcher itself with a 10 MB cap, 3 archived files).
- Per-supervised-process logs: process-compose collects stdout/stderr
  per process; configured to write to `~/.friday/local/logs/<name>.log`.
  Log rotation per process is out of scope for v1 (see Out of Scope).

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
- **Hides:** that process-compose is the supervisor under the hood;
  the typed `types.Project` configuration; per-platform health probes;
  the cold-start grace-period logic; the Job Object machinery on
  Windows; the orphan-cleanup pass on Unix; the browser-open timing.
- **Trust contract:** if `friday-launcher` holds the exclusive lock
  on `pids/launcher.pid`, Friday Studio is being supervised. SIGTERM
  brings everything down cleanly via process-compose's
  `ShutDownProject()`; SIGKILL on Windows still brings everything
  down via the Job Object; SIGKILL on macOS may leave supervised
  binaries running until the next launcher start, which performs an
  orphan cleanup.

#### Tauri installer

- **Interface:** wizard UI; final step spawns the launcher and
  writes the autostart entry via `tauri-plugin-autostart`.
- **Hides:** download + sha-verify + extract + autostart-mechanism
  details; arch detection; pid-file lock + start-time verification
  protocol.
- **Trust contract:** when the wizard's *Done* screen renders, the
  launcher is running and (if the user kept the checkbox) the OS will
  re-spawn it at next login.

#### process-compose (as a Go library dependency)

- **Interface:** `app.NewProjectRunner(opts) (*ProjectRunner, error)`,
  `runner.Run() error`, `runner.GetProcessesState() (*types.ProcessesState, error)`,
  `runner.RestartProcess(name string) error`, `runner.ShutDownProject() error`.
- **Hides:** restart policies, health probing, dependency ordering,
  signal forwarding to children, internal state machine.
- **Trust contract:** if `state.IsReady()` returns true, every
  supervised process responded successfully to its readiness probe
  within the last polling interval. `ShutDownProject()` returning nil
  means every supervised child exited cleanly.

## Testing Decisions

A good test exercises the launcher's *external* behavior: pid file
appears + disappears at the right times, tray status reflects
process-compose state, SIGTERM brings everything down cleanly, hard
kill on Windows brings everything down via Job Object, stale pid files
don't cause the installer to TERM unrelated processes, orphan cleanup
on Unix sweeps up SIGKILL'd survivors on next start.

Modules tested:

- **Launcher orderly shutdown**: integration test that wires up the
  launcher with a stub `types.Project` (3 trivial Go HTTP servers as
  the "supervised" set), verifies the pid file appears with expected
  `<pid> <start_time>` format, sends SIGTERM, asserts pid file is
  gone and all child pids exited within the timeout. Shape mirrors
  the existing pty-server `protocol_test.go` integration tests
  (real subprocesses, no mocks).
- **Hard-kill resilience (Windows)**: spawn the launcher, capture
  child pids, kill the launcher with `taskkill /F`, assert all child
  pids exited within ~5 s via Job Object.
- **Orphan cleanup (Unix)**: spawn the launcher, capture child pids,
  SIGKILL the launcher, assert children survive briefly (orphans),
  then start a fresh launcher and assert it sweeps the orphans within
  ~5 s.
- **Pid-file staleness handling**: write a stale pid file pointing
  at the test-harness's own pid (which won't match the recorded
  start_time), invoke the installer's stop-launcher routine, assert
  it cleans up the stale file without sending TERM to the harness.
- **Tray status mapping**: unit test against synthetic
  `types.ProcessesState` values — verifies the green / amber / red
  mapping is total (every state combination resolves to exactly one
  color), AND that within the 30 s post-launch grace window the
  predicate never returns red regardless of probe state, AND that
  IsReady() being true always maps to green (no false-amber on
  healthy state).
- **Browser-open guard**: unit test that the `openedBrowserThisSession`
  flag prevents repeated browser opens (one process-state change
  green→amber→green should NOT reopen the browser; only the first
  green wins).
- **Installer↔launcher handoff**: end-to-end smoke test on a real
  Mac that runs the installer, verifies the launcher pid file
  appears, then re-runs the installer and verifies the previous
  launcher exited before extract started.

Prior art:

- `tools/pty-server/protocol_test.go` — testify-style integration
  tests against real subprocesses, ~22 tests, passing with `-race`.
- `tools/pty-server/jobobject_windows.go` — direct prior art for
  the Job Object pattern used here.
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
  can configure per-process log rotation. Note: the launcher's OWN
  log IS rotated (10 MB cap, 3 archives) — only the supervised
  binaries' logs are unbounded.
- **Per-service tray status detail.** v1 tray collapses all five
  services into one tri-state icon. A follow-up can add a
  per-service submenu (`friday ●  link ●  playground ✕ restarting…`).
- **Hard-kill no-orphan guarantee on macOS.** v1 documents the
  limitation and provides cleanup-on-next-start as the mitigation;
  a follow-up can investigate launchd-managed process group support
  or kqueue-based parent-death notification.

## Further Notes

- The launcher binary size will be roughly the size of a Go binary
  with process-compose as a dep — measured from the process-compose
  repo's own `make build` (`CGO_ENABLED=0`): ~32 MB pre-codesign.
  Comparable to v2's "5 MB Go + 25 MB embed = 30 MB" estimate; the
  embed savings are offset by pulling in process-compose's dep tree
  (zerolog, cobra, gin, etc.). Net wash on size.
- All five service `/health` endpoints already exist (verified
  against current source — no follow-up commits needed before the
  launcher can ship).
- Tray icon on macOS supports template images (B/W rendering that
  adapts to dark/light mode); we should ship the icon as a template
  PNG. Same icon flipped to red/amber for status states. The Dock
  icon is the regular full-color app icon (separate asset).
- We can dogfood the launcher locally by running
  `go run ./tools/friday-launcher` after `deno task playground`
  builds the supervised binaries.
- process-compose at HEAD is `v1.103.0` (verified against
  `/Users/lcf/code/github.com/F1bonacc1/process-compose`). The Go
  module path is `github.com/f1bonacc1/process-compose` and the
  packages we import are `src/app` (for `NewProjectRunner` /
  `ProjectOpts`) and `src/types` (for `Project`, `ProcessesState`,
  `ProcessState`, status / health constants).
- The `Health` field's JSON tag is `is_ready` (string enum:
  `"Ready"` / `"NotReady"` / `"Unknown"`), NOT a bool. v2's
  proposed REST polling code would have failed to compile against
  the real type; the library-import path makes this moot since we
  use the typed Go struct directly.
