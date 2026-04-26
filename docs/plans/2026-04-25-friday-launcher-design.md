# Friday Launcher — Design

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

The pid-tracking + manual TERM logic in `extract.rs::terminate_studio_processes`
also iterates every binary's pid file individually, which means each new
binary added to the platform tarball needs three places updated: build script,
launch.rs, extract.rs. The launcher pattern collapses that to one boundary.

## Solution

Introduce **`friday-launcher`** — a new cross-platform Go binary, shipped in
the studio platform tarball alongside the existing five binaries. It owns
the lifetime of Friday Studio after install: it supervises the five backends
via an embedded `process-compose`, renders a tray-icon UI (green / amber /
red), and exposes the platform to the user via the OS's autostart-at-login
mechanism (LaunchAgent on macOS, Startup-folder shortcut on Windows).

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

## Implementation Decisions

### New binary: `friday-launcher`

- Lives in `tools/friday-launcher/` as a new Go binary.
- Cross-compiles via the existing `GO_BINARIES` slot in
  `scripts/build-studio.ts` (the same path `pty-server` already uses),
  so it picks up the GOOS/GOARCH matrix and codesign loop for free.
- Ships in the studio platform tarball at the top level, alongside
  `friday`, `link`, `playground`, `pty-server`, `webhook-tunnel`.

### Embedded process-compose

- Per-platform `process-compose` release binaries embedded via Go's
  `embed` package + per-platform build tags. One binary per
  `(GOOS, GOARCH)` pair: `darwin/arm64`, `darwin/amd64`,
  `windows/amd64`. (`linux/*` follows when we ship Linux.)
- A new step in `scripts/build-studio.ts` fetches the right
  `process-compose` release asset per target and stages it into the
  launcher's `embed` directory before `go build` runs (mirroring the
  existing `EXTERNAL_CLIS` download pattern for `gh` and
  `cloudflared`).
- At first launch, the launcher extracts the embedded `process-compose`
  binary to `~/.friday/cache/process-compose-<sha>` (sha-keyed so old
  versions get cleaned up), `chmod 0755`'s it on Unix, and execs it.

### process-compose.yaml (Go template, rendered at first launch)

Configures the five binaries plus an `open-browser` process gated on
all five reporting `process_healthy`. Restart policy `always` with
2-second backoff and `max_restarts: 5`. Readiness probes:

- `friday`         — HTTP GET `localhost:8080/health`
- `link`           — HTTP GET `localhost:3100/health`
- `playground`     — HTTP GET `localhost:5200/api/health`
- `pty-server`     — HTTP GET `localhost:7681/health`
- `webhook-tunnel` — HTTP GET `localhost:9090/health`

Any binary missing a `/health` endpoint gets one added (two lines per
service); `process_started` is rejected as a fallback because it
doesn't actually verify the service is serving requests.

The `open-browser` process is `disabled: true` when `--no-browser` is
passed, so the LaunchAgent / Windows Startup path supervises silently.

### CLI surface

- `friday-launcher` — supervises + opens browser when healthy + tray icon
- `friday-launcher --no-browser` — supervises + tray icon, no browser open

That's it. No subcommands. The tray menu (Restart all / Quit / Open in
browser / View logs) is the user-facing surface; CLI users get the same
two flags.

### Autostart registration (installer-owned)

- Tauri installer's API Keys (or Done) step gains one checkbox: *"Start
  Friday Studio when I log in"*, default checked.
- If checked, the installer writes:
  - macOS: `~/Library/LaunchAgents/ai.hellofriday.launcher.plist`
    invoking `friday-launcher --no-browser` with `RunAtLoad: true`,
    `KeepAlive: true`.
  - Windows: a `.lnk` shortcut to `friday-launcher.exe --no-browser` in
    `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`.
- The launcher itself does not touch autostart files. Only the installer
  does.

### Installer↔launcher contract

- Single touchpoint: `~/.friday/local/pids/launcher.pid`.
- On install:
  1. Installer reads the existing pid file (if any), sends SIGTERM /
     `taskkill`, waits up to 10s for the pid to disappear.
  2. Extracts the new tarball.
  3. Spawns `friday-launcher` (no flag) detached, exits.
- On launcher shutdown (whether triggered by SIGTERM or tray-menu
  Quit): orderly handler runs `process-compose down` (which TERMs all
  children), removes the pid file, exits 0.
- The installer never needs to know the launcher's process-compose
  port or token.

### Tray UI

- `fyne.io/systray` for cross-platform tray icon + menu.
- macOS `.app` bundle with `LSUIElement=true` (menu-bar-only, no Dock).
- Windows `.exe` built with `-ldflags="-H=windowsgui"` to suppress the
  console window flash.
- Tray polls process-compose's `GET /processes` REST endpoint every
  ~2 seconds; renders icon + status string from the response.
- Menu items:
  - "Open in browser" → `pkg/browser.OpenURL("http://localhost:5200")`
  - "Restart all" → POST `/processes/restart` for each non-`open-browser`
    service
  - "View logs" → opens `~/.friday/local/logs/` in OS file browser
  - "Quit" → orderly shutdown handler (same path as SIGTERM)

### Tauri installer changes

- `Launch.svelte` becomes a "spawn launcher and close" step, no progress
  UI needed.
- `commands/launch.rs` shrinks dramatically — spawn the launcher
  detached, register the autostart entry per the user's checkbox,
  return. No more health polling, pid bookkeeping, or browser-open.
- `commands/extract.rs::terminate_studio_processes` reads only
  `pids/launcher.pid` (not every binary's pid).

### Module Boundaries

#### `friday-launcher` binary

- **Interface:** two CLI flags (`--no-browser`), pid file at
  `~/.friday/local/pids/launcher.pid`, SIGTERM/TERM as the shutdown
  signal. Tray icon visible to the user.
- **Hides:** the existence of `process-compose`, the YAML schema, the
  random local port + token, the embed/extract dance, the per-platform
  health probes, the browser-open trick, the per-service restart
  policy.
- **Trust contract:** if `friday-launcher` is running (pid file present
  and reachable), Friday Studio is being supervised. SIGTERM brings
  everything down cleanly.

#### Tauri installer

- **Interface:** wizard UI; final step spawns the launcher and writes
  the autostart entry.
- **Hides:** download + sha-verify + extract + autostart-mechanism
  details; arch detection.
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
process-compose state, SIGTERM brings everything down cleanly.

Modules tested:

- **Launcher orderly shutdown**: integration test that spawns the
  launcher with a stub `process-compose.yaml` (3 trivial Go HTTP
  servers as the "supervised" set), verifies the pid file appears,
  sends SIGTERM, asserts pid file is gone and all child pids exited
  within the timeout. Same shape as the existing pty-server
  `protocol_test.go` integration tests (real subprocesses, no
  mocks).
- **Embed/extract**: unit test that the embedded `process-compose`
  bytes match the expected sha for the host platform, and that
  extraction is idempotent (running the launcher twice doesn't
  re-write the cache file).
- **Tray status predicate**: unit test against captured JSON from
  `process-compose`'s `/processes` endpoint — verifies the green /
  amber / red mapping is total (every state combination resolves to
  exactly one color).
- **Installer↔launcher handoff**: end-to-end smoke test on a real
  Mac that runs the installer, verifies the launcher pid file
  appears, then re-runs the installer and verifies the previous
  launcher exited before extract started.

Prior art:

- `tools/pty-server/protocol_test.go` — testify-style integration
  tests against real subprocesses, ~22 tests, passing with `-race`.
- `apps/studio-installer/src-tauri/src/commands/*.rs` — existing Rust
  command tests in the installer.

## Out of Scope

- **Auto-update of the studio tarball.** The launcher does not download
  or apply platform updates; the Tauri installer keeps that
  responsibility for the first ship. Sparkle-style auto-update from the
  launcher is a follow-up.
- **Linux platform target.** macOS arm/intel + Windows only, matching
  the existing studio-build matrix.
- **Uninstall flow.** Removing the autostart entry on uninstall is
  important but not part of v1 — currently we don't have an uninstaller
  at all.
- **Windows EV-cert signing for SmartScreen.** Same as the rest of the
  platform — we ship with a self-signed cert and accept the SmartScreen
  warning.
- **Running as a system-level service** (root launchd LaunchDaemon /
  Windows Service). User-session only, because tray icons require an
  active session.
- **Logging out + back in mid-update.** If the user logs out during a
  Tauri-installer-driven update, the launcher autostarts at next login
  and may collide with extraction. We assume the user keeps their
  session alive while the wizard is running.

## Further Notes

- The launcher binary size will be roughly the size of a Go binary
  (~5 MB) plus the embedded `process-compose` (~20 MB) plus the
  `fyne.io/systray` runtime — call it 30 MB pre-codesign. Well within
  the noise of the existing 1.1 GB platform tarball.
- The `process-compose` subprocess does NOT need to know it's embedded.
  It reads our YAML, exposes its REST API to the launcher only on the
  loopback address, and exits when we tell it to. The launcher is the
  only consumer of its REST surface — no public network port is opened.
- Tray icon on macOS supports template images (B/W rendering that
  adapts to dark/light mode); we should ship the icon as a template
  PNG. Same icon flipped to red/amber for status states.
- The pty-server / webhook-tunnel `/health` endpoints — if they don't
  exist today, that's a small follow-up commit per service before the
  launcher can ship. Each endpoint is two lines of HTTP-handler code.
- We can dogfood the launcher locally by running
  `go run ./tools/friday-launcher` after `deno task playground` builds
  the supervised binaries.
