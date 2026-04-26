<!-- v8 - 2026-04-25 - Generated via /improving-plans from docs/plans/2026-04-25-friday-launcher-design.v7.md -->

# Friday Launcher — Design (v8)

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
a tray-icon UI (green / amber / red), and registers itself with the OS's
autostart-at-login mechanism on first run (LaunchAgent on macOS, registry
entry on Windows).

The Tauri installer's only role at install-time becomes "extract files,
spawn the launcher, exit." All the supervision + restart-on-crash +
health-aware browser-open + autostart-registration behavior lives in one
place the user can see in their menu bar and reach via the tray menu.

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
   stops every supervised process and brings them back up cleanly in
   dependency order, so the user-visible state goes amber → green
   without any intermediate red flicker.

9. As a Friday Studio user debugging a problem, I want a "View logs" tray
   menu item that opens the launcher's log directory in my OS file
   browser (Finder on macOS, Explorer on Windows), so I can ship logs to
   support without hunting paths.

10. As a Friday Studio user who wants to stop the platform, I want a
    "Quit" tray menu item that gracefully shuts down every supervised
    process before exiting, so I don't leave orphan binaries holding
    ports — and I want the tray icon to reflect "Shutting down…"
    during the wait so the UI doesn't appear hung.

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
    out of the autostart behavior at install time — and I want the
    autostart entry, when written, to point at the launcher I just
    installed, not at the installer binary.

17. As a Friday Studio user uninstalling Studio, I want the autostart
    entry removed so Studio stops trying to launch after I've removed
    it. (Out of scope for first implementation — see Out of Scope.)

18. As a Friday Studio developer, I want to be able to invoke the
    launcher from the command line (`friday-launcher`,
    `friday-launcher --no-browser`, `friday-launcher --autostart enable`,
    `friday-launcher --autostart disable`) so I can iterate locally
    without going through the installer.

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

22. As a Friday Studio user clicking the Dock icon (macOS) for an
    already-running Friday Studio, I want the browser to open to
    Studio (same as the tray menu's "Open in browser") instead of
    nothing happening, so the affordance behaves consistently with
    other macOS apps that supervise background services.

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

26. As a Friday Studio user, if the process-compose supervisor inside
    the launcher unexpectedly exits (panic, crash), I want the tray
    icon to immediately go red with a "supervisor exited" tooltip,
    so I'm not lulled by stale-but-stuck "everything green" state.

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

- `github.com/f1bonacc1/process-compose` — pinned via `go.mod`.
  Resolution happens at `go build` time; HEAD as of plan writing is
  v1.103.0.
- Public entry point: `app.NewProjectRunner(opts *app.ProjectOpts) (*app.ProjectRunner, error)`.
  This is the same constructor `cmd.Execute()` uses internally.

#### `main()` shape (mandatory)

Because `systray.Run()` blocks until `systray.Quit()` is called, and
because nothing happens automatically after it returns, the launcher's
`main()` MUST follow this exact shape:

```go
func main() {
    parseFlags()
    setupLogging()
    if *autostartFlag != "" {
        // --autostart enable|disable runs as a one-shot CLI, no tray
        runAutostartCommand(*autostartFlag)
        return
    }
    setupSignalHandlers()  // installs SIGTERM, SIGINT, SIGUSR1 handlers
    systray.Run(onReady, onExit)  // BLOCKS until tray Quit fires
    // No code after — Go runtime exits when main returns and
    // no non-daemon goroutines remain. If we ever need post-Run
    // cleanup, add an explicit os.Exit(0) here.
}
```

The signal handler running in its own goroutine routes:
- `SIGTERM` / `SIGINT` → `systray.Quit()` (which fires `onExit`)
- `SIGUSR1` (Unix only) → `pkg/browser.OpenURL("http://localhost:5200")`
  (the "wake" path used by single-instance handling)

#### Goroutine layout

```
main goroutine    : systray.Run(onReady, onExit)        // blocks
  onReady spawns:
    goroutine A   : runAndWatchSupervisor()              // wraps runner.Run(), sets exit flag on return
    goroutine B   : tray-poll loop (runner.GetProcessesState every 2s)
    goroutine C   : signal handler (SIGTERM/SIGINT/SIGUSR1)
    goroutine D   : sentinel-file watcher (Windows only — see Single-instance handling)
    goroutine E   : autostart-self-register (one-shot, see Autostart below)
  onExit          : orderly-shutdown handler (see "Shutdown" below)
```

#### Detecting unexpected supervisor exit

`runner.Run()` is supposed to block for the lifetime of the launcher, but
nothing prevents it from returning early — a panic recovered upstream, an
external context cancellation, an unhandled internal error all bring it
back. If we just `go runner.Run()` and forget, `runner.GetProcessesState()`
keeps returning the last cached map indefinitely; the tray would render
GREEN forever with five dead binaries underneath.

Goroutine A wraps `runner.Run()` so we observe its return:

```go
var (
    supervisorExited atomic.Bool
    supervisorErr    atomic.Pointer[error]
)

func runAndWatchSupervisor(runner *app.ProjectRunner) {
    err := runner.Run()
    if !shuttingDown.Load() {
        // Run() returned but WE didn't initiate shutdown.
        log.Error().Err(err).Msg("process-compose supervisor exited unexpectedly")
        supervisorErr.Store(&err)
        supervisorExited.Store(true)
    }
}
```

The tray-poll goroutine checks `supervisorExited` first on each tick; when
set, it forces the tray to RED with a tooltip
"Friday supervisor exited unexpectedly: <err>". The "Restart all" menu
item is disabled in this state (you cannot StartProcess on a dead runner).
"Quit" still works — `systray.Quit()` runs the normal `onExit` path,
which is now a fast no-op for ShutDownProject (already cancelled context).

Recovery from this state requires the user to Quit and relaunch. v6 does
not auto-restart the supervisor; the assumption is unexpected exit means
a bug worth surfacing, not transparently swallowing.

#### Shutdown — `onExit` does NOT block on `runner.ShutDownProject()`

`systray`'s `onExit` is invoked synchronously on the macOS NSApp event
loop thread. If we block it for the duration of
`runner.ShutDownProject()` (which can take 5–30 s while it TERMs each
supervised child and waits for them to exit), the OS thinks the
launcher has hung — the tray icon stays visible, the Dock icon doesn't
react, the user sees nothing happening.

Split the shutdown so `onExit` returns promptly while the actual
process-compose teardown runs in a goroutine:

```go
var shuttingDown atomic.Bool
shutdownDone := make(chan struct{})

func onExit() {
    shuttingDown.Store(true)         // tray-poll goroutine reads this
                                     // and renders "Shutting down…"
    go func() {
        runner.ShutDownProject()     // 5–30 s typical
        close(shutdownDone)
    }()
    select {
    case <-shutdownDone:              // graceful, every child TERMed cleanly
    case <-time.After(30 * time.Second): // safety: don't hang forever
        log.Warn("ShutDownProject did not complete in 30s; exiting anyway")
    }
}
```

The tray-poll goroutine reads `shuttingDown` on each tick; when set,
it renders the icon as a fading-grey "shutting down" variant and the
status string as "Shutting down…" so the user gets feedback during
the wait. After `onExit` returns, `systray.Run()` returns, `main()`
returns, the process exits.

#### Constructing `Project` and `ProjectOpts`

`types.Project` has public fields and is built via struct literal:
```go
project := &types.Project{
    Version:   "0.5",
    Name:      "Friday Studio",
    Processes: types.Processes{
        "friday": types.ProcessConfig{ /* ... */ },
        // ... four more
    },
}
```

`app.ProjectOpts` has private fields BUT exposes a chained-builder
API on the `*ProjectOpts` receiver. `process-compose` itself starts
from a plain struct literal — there is NO `app.NewProjectOpts()`
constructor. The launcher MUST use:
```go
opts := (&app.ProjectOpts{}).
    WithProject(project).
    WithIsTuiOn(false).
    WithOrderedShutdown(true)
runner, err := app.NewProjectRunner(opts)
```

#### What disappears compared to v2's embed-binary model

- No `embed.FS` of per-platform process-compose binaries (-20 MB).
- No sha-keyed extract to `~/.friday/cache/process-compose-<sha>`.
- No port allocation (`net.Listen("tcp", "127.0.0.1:0")` dance).
- No token file or `--token-file` flag plumbing.
- No REST polling — direct typed Go method calls instead.
- No "what if process-compose dies" failure mode — process-compose
  is a goroutine inside our PID, not a child process.
- No `open-browser` YAML process with platform-specific `OpenCmd`.
  Browser-open is one Go line in the launcher's main loop.

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

Probe tuning to avoid the cold-start RED flash. Field types are `int`
(seconds), NOT `time.Duration`:

```go
ReadinessProbe: &health.Probe{
    InitialDelay:     5,    // seconds
    PeriodSeconds:    2,
    FailureThreshold: 5,
    HttpGet: &health.HttpProbe{
        Host: "127.0.0.1", Port: "8080", Path: "/health",
    },
}
```

Restart policy AND shutdown configuration on every supervised process:
```go
RestartPolicy: types.RestartPolicyConfig{
    Restart:        types.RestartPolicyAlways,
    BackoffSeconds: 2,
    MaxRestarts:    5,
},
ShutDownParams: types.ShutDownParams{
    ShutDownTimeout: 10, // seconds; SIGKILL after this
    Signal:          15, // POSIX SIGTERM value; cross-platform safe (see below)
},
```

`ShutDownTimeout` is REQUIRED on every process so that `StopProcess()`
blocks for up to N seconds waiting for the actual exit instead of
returning immediately after sending the stop signal. Without it, the
two-pass restart described below would race — `StartProcess(friday)`
could fire while a previous `StopProcess(friday)` was still tearing
down the old instance, causing port-in-use failures.

**`Signal` is `int`, but DO NOT use `int(syscall.SIGTERM)`.** Although
the field is `int` (verified at `process-compose/src/types/process.go`),
`syscall.SIGTERM` is defined ONLY in Go's Unix-side syscall files
(`//go:build !windows`). Writing `int(syscall.SIGTERM)` in cross-
platform launcher code produces `undefined: syscall.SIGTERM` when
compiled for `GOOS=windows`. Use the literal `15` (the POSIX SIGTERM
value) instead.

This is correct because:
- On Unix, process-compose's `stopper_unix.go` calls
  `syscall.Kill(pgid, syscall.Signal(15))` — value 15 IS SIGTERM, the
  same thing you'd get from `int(syscall.SIGTERM)`.
- On Windows, process-compose's `stopper_windows.go` accepts the
  `sig int` parameter but **discards it** entirely; it calls
  `taskkill /F /PID <n>` regardless. Windows doesn't have POSIX
  signals; the int value is API-compatibility ballast.

So `15` works on both platforms with identical effective semantics.
Earlier drafts used `Signal: "SIGTERM"` (won't compile, wrong type)
and `Signal: int(syscall.SIGTERM)` (won't compile on Windows). The
literal `15` is the correct value.

There is no `open-browser` process in the config — browser-opening is
handled by the launcher's main loop directly (see next section).

#### Restart order (used by Restart-all + by clean restarts after install update)

The launcher hard-codes the dependency order in a slice (we own the
project; no need to compute topological order at runtime, and the
self-documenting nature of two named slices beats threading
`ProcessConfig.DependsOn` through five entries for a graph that fits
on one screen):

```go
// stop in REVERSE-dependency order; start in dependency order
var stopOrder  = []string{"playground", "pty-server", "webhook-tunnel", "friday", "link"}
var startOrder = []string{"friday", "link", "pty-server", "webhook-tunnel", "playground"}
```

The Tray menu's "Restart all" action runs:
1. For each name in `stopOrder`: `runner.StopProcess(name)` —
   blocks up to `ShutDownTimeout` (10 s) per process while
   process-compose waits for the actual exit. Without
   `ShutDownTimeout` configured this would return immediately;
   see "Project configuration" above for the required
   `ShutDownParams.ShutDownTimeout` field.
2. For each name in `startOrder`: `runner.StartProcess(name)` —
   waits for the process to be re-spawned by process-compose.

The two passes are run sequentially from a single goroutine. We do
NOT serialize against concurrent `RestartProcess` calls (process-compose
coalesces those internally), but we also do NOT dispatch concurrent
`StopProcess`/`StartProcess` on the same name from different goroutines —
v1 has only one entry point that mutates process state (the Restart-all
menu item), and that path is single-threaded.

This avoids the v4-baseline behavior where calling `RestartProcess(name)`
in a `range project.Processes` loop (random map iteration order) could
leave `playground` running while `friday` was being restarted, causing
playground's health probes to fail and the tray to flash amber→red→amber
during what should be a clean restart.

The launcher's tray-poll loop honors process-compose's `Restarting`
status as amber (per the Tray Color Matrix) so the user sees a brief
amber window during Restart all, then green.

### Browser-open (Go code, not a process-compose process)

When the launcher's tray-poll goroutine reads `runner.GetProcessesState()`
and the result satisfies `state.IsReady()` for the first time during this
launcher's lifetime AND `--no-browser` was not passed, the launcher
calls `browser.OpenURL("http://localhost:5200")` from
`github.com/pkg/browser`.

A boolean `openedBrowserThisSession` guard ensures we open at most
once per launcher process. "Restart all" from the tray does NOT
reopen the browser — only the initial first-healthy moment does, plus
explicit user click of the "Open in browser" tray menu item, plus
SIGUSR1 / sentinel-file wakeups from a second-launcher instance (see
Single-instance handling).

### Single-instance handling (Dock-click wake-up)

`fyne.io/systray` does NOT expose macOS's `applicationShouldHandleReopen`
callback, so a Dock click on a running Friday Studio normally does
nothing. We implement single-instance + Dock-click handling
ourselves through the same pid-lock infrastructure used for
installer↔launcher coordination:

**On launcher startup:**
1. Try to take an exclusive `flock` (Unix) / `LockFileEx` (Windows) on
   `~/.friday/local/pids/launcher.pid`.
2. **If the lock succeeds:** we're the first instance. Write
   `<pid> <start_time_unix>` into the file, hold the lock for the
   process lifetime, proceed with normal startup (process-compose,
   tray, etc.).
3. **If the lock fails:** another instance is running. Wake it up,
   then exit silently:
   - **Unix (macOS / Linux):** read the running pid from the file,
     send `SIGUSR1` to it, `exit(0)`. The running launcher's signal
     handler routes `SIGUSR1` → `pkg/browser.OpenURL`. The user sees:
     Dock click → browser opens, no second tray icon, no flicker.
   - **Windows:** write a touch-file at `~/.friday/local/.wake` with
     the current timestamp, `exit(0)`. The running launcher's Windows
     goroutine D polls that path every 500 ms; on detection it
     deletes the file and opens the browser. (Named-pipe IPC would be
     more elegant but the polling is simpler and the latency is
     well within "feels instant.")

**Effect:** Spotlight relaunch, Dock click, double-click in Finder, and
"open another launcher binary" all converge on the same outcome — the
already-running launcher pops the browser. The user can never have
two launchers fighting for the same ports.

### Tray status mapping (uses process-compose's own predicate)

The launcher's tray-poll goroutine calls `runner.GetProcessesState()`
every 2 s and renders one of four states. The predicate is
process-compose's own typed methods, NOT a hand-rolled "is_ready=true"
string check. Before calling `GetProcessesState`, the loop checks
`supervisorExited.Load()` — if true, the supervisor goroutine returned
from `runner.Run()` unexpectedly and the cached state is stale; render
RED with a "supervisor exited" tooltip and skip the predicate.

Source of truth for "is everything ready?":
```go
if supervisorExited.Load() {
    renderRed("Friday supervisor exited unexpectedly")
    return
}
state, _ := runner.GetProcessesState()
if state.IsReady() {
    // ...all enabled processes are ready per process-compose's predicate
}
```

`(p *ProcessState) IsReadyReason() (bool, string)` is used for
per-process reasons in the tray tooltip / log output. Note:
`IsReady()` returns `true` for `Disabled` processes (treated as not
blocking). We have no `Disabled` processes in the launcher's project,
so this doesn't affect us — but if we add one in the future, we
inherit process-compose's "disabled = ready" semantics.

Tray color matrix:

| Bucket | Rule |
|---|---|
| 🟢 green | `state.IsReady() == true` AND `shuttingDown.Load() == false` AND `supervisorExited.Load() == false` |
| 🔴 red   | `supervisorExited.Load() == true` OR (any process Status ∈ {Error} OR (Status == Restarting AND Restarts ≥ MaxRestarts)) — only AFTER the 30 s post-launch grace window has elapsed AND `shuttingDown.Load() == false` |
| 🟡 amber | everything else — covers Pending, Launching, Restarting (within max), Terminating, Scheduled, AND any state during the first 30 s of post-launch elapsed time |
| ⚪ grey  | `shuttingDown.Load() == true` — render with a fading "Shutting down…" status string until the process exits |

The 30 s post-launch "always amber" rule is the cold-start UX fix:
binaries take a few seconds to bind their ports during a fresh login;
a red flash before they go green would train users to ignore red.

#### Tray icon assets

`fyne.io/systray` has no runtime tint API — each color requires its own
PNG asset. The launcher ships four tray icon PNGs embedded via Go's
`embed` directive:

```
tools/friday-launcher/assets/
  tray-green.png    // 22x22 (macOS template not used; we want color)
  tray-amber.png
  tray-red.png
  tray-grey.png     // shutting down
```

On macOS, these are NON-template PNGs because we want color signal in
the menu bar regardless of dark/light mode (template images would render
B/W, defeating the green/amber/red coding). The tray-poll loop swaps
the icon by calling `systray.SetIcon(<bytes>)` whenever the bucket
changes; identical-bucket polls do nothing.

Dock icon (`Friday Studio.icns`) is a separate full-color asset built
from the standard app-icon PSD; it does not change at runtime.

### CLI surface

- `friday-launcher` — supervises + opens browser when healthy + tray icon
- `friday-launcher --no-browser` — supervises + tray icon, no browser open
- `friday-launcher --autostart enable` — write the OS autostart entry
  pointing at THIS binary's path (`os.Executable()`), then exit 0
- `friday-launcher --autostart disable` — remove the OS autostart entry,
  then exit 0
- `friday-launcher --autostart status` — print "enabled" / "disabled" to
  stdout, then exit 0

The `--autostart` subcommands are the SAME code path the launcher uses
internally on first-run self-registration (see "Autostart registration"
below); exposing them via CLI gives developers a way to test it without
the GUI and gives advanced users a way to toggle without re-running the
installer.

The tray menu (Restart all / Quit / Open in browser / View logs / Start
at login) is the user-facing surface; CLI users get the flags.

### macOS app bundling (Dock + Spotlight visible)

- The launcher ships as a regular `.app` bundle (NOT `LSUIElement`) so
  the user can find "Friday Studio" via Spotlight, Launchpad, and the
  Dock — the same way Slack / Docker Desktop are reachable after the
  user has quit the tray.
- Both Dock icon and tray icon are visible. Clicking the Dock icon
  spawns a second launcher process which (per Single-instance handling
  above) sends SIGUSR1 to the running launcher and exits; the running
  launcher opens the browser.
- Quit from the Dock (right-click → Quit, or `⌘Q` from the Dock app
  menu) sends SIGTERM to the launcher, which routes through the same
  orderly-shutdown handler as the tray menu's Quit item.
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

### Autostart registration (launcher self-registers — installer does NOT use `tauri-plugin-autostart`)

**The Tauri installer does NOT register autostart anymore.** Earlier
designs (v3–v5) had the installer call `tauri-plugin-autostart`'s
`enable()` after extracting files. That doesn't work: the plugin reads
`std::env::current_exe()` at the moment `enable()` is called, so the
LaunchAgent plist would point at the *installer* binary
(`studio-installer.app/Contents/MacOS/studio-installer`), not the
launcher at
`~/.friday/local/Friday Studio.app/Contents/MacOS/friday-launcher`.
At next login the OS would re-run the installer (which then either
re-installs Friday or does nothing useful), never the launcher.

v6 moves autostart registration **into the launcher itself**, written
in plain Go — no Tauri plugin, no Tauri capabilities, no plist
post-processing dance. The launcher knows its own path because it
*is* the binary that should be re-launched at login.

#### When the launcher writes the autostart entry

Three paths converge on `enableAutostart()`:

1. **Goroutine E — first-run self-registration AND staleness repair.**
   On every launcher startup, the goroutine reads
   `~/.friday/local/state.json`:
   - If the file is missing or `autostart_initialized != true`, call
     `enableAutostart()` (writes the OS-native entry pointing at
     `os.Executable()` with `--no-browser`), set
     `autostart_initialized = true`, write the file back. This makes
     the install→tray→relaunch-on-reboot experience work with zero
     installer involvement.
   - If `autostart_initialized == true`, also call
     `currentAutostartPath()` (reads the registered path from the
     plist / registry) and compare it to `os.Executable()`. If they
     differ — e.g. the user moved `Friday Studio.app` from
     `~/.friday/local/` to `/Applications` — call `enableAutostart()`
     to rewrite the entry with the current path. Cheap (string compare
     + occasional file rewrite) and prevents the silent-broken-autostart
     mode where the next login tries to launch a binary that no longer
     exists at the recorded path.
2. **Tray menu "Start at login"** — a checkbox menu item bound to
   `enableAutostart()` / `disableAutostart()`. Initial check state
   read from `isAutostartEnabled()` at tray-build time. Toggling
   persists immediately. Note: the OS picks up newly-written
   plists / registry values at the *next* login, not mid-session, so
   the checkbox semantics are "will start at next login" — the
   currently-running launcher is unaffected.
3. **CLI** — `friday-launcher --autostart enable|disable|status`
   wires through the same functions for headless / scripting use.

#### Atomic file writes (state.json AND the plist)

Both `~/.friday/local/state.json` and the macOS LaunchAgent plist file
are written via a temp-file-then-rename pattern, NOT a direct
`os.WriteFile`. If the launcher is killed mid-write (kill -9, power
loss, OOM), a direct write can land partial bytes and corrupt the
file; the next launcher startup's JSON or plist parse fails with no
clean recovery path.

```go
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
    tmp := path + ".tmp"
    if err := os.WriteFile(tmp, data, perm); err != nil {
        return err
    }
    return os.Rename(tmp, path) // atomic on POSIX, atomic on modern NTFS
}
```

All sites that write `state.json` or the plist call `atomicWriteFile`,
not `os.WriteFile` directly. The Windows registry path doesn't need
this — registry writes are transactional at the OS level. Only the
file-backed paths (macOS plist, state.json on both platforms) use
the helper.

#### Per-platform implementations (~150 LoC total)

```go
// tools/friday-launcher/autostart_darwin.go
import "howett.net/plist"

// plistTemplate has three %s slots: Label, executable path, first arg.
// KeepAlive=false because the launcher's process-compose handles
// child restart internally; we only want launchd to (re-)launch us
// at login. RunAtLoad=true triggers that.
const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>%s</string>
  <key>ProgramArguments</key>
  <array>
    <string>%s</string>
    <string>%s</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
</dict>
</plist>`

type launchAgent struct {
    Label            string   `plist:"Label"`
    ProgramArguments []string `plist:"ProgramArguments"`
    RunAtLoad        bool     `plist:"RunAtLoad"`
    KeepAlive        bool     `plist:"KeepAlive"`
}

func enableAutostart() error {
    exe, _ := os.Executable()
    body := fmt.Sprintf(plistTemplate, "ai.hellofriday.studio", exe, "--no-browser")
    return atomicWriteFile(plistPath(), []byte(body), 0644)
}
func disableAutostart() error  { return os.Remove(plistPath()) }
func isAutostartEnabled() bool { _, err := os.Stat(plistPath()); return err == nil }

// currentAutostartPath returns the executable path currently registered
// in the LaunchAgent plist, or "" if no plist exists / unreadable.
// Used by goroutine E to detect staleness when the user has moved
// Friday Studio.app to a new location.
func currentAutostartPath() string {
    data, err := os.ReadFile(plistPath())
    if err != nil {
        return ""
    }
    var agent launchAgent
    if _, err := plist.Unmarshal(data, &agent); err != nil {
        return ""
    }
    if len(agent.ProgramArguments) == 0 {
        return ""
    }
    return agent.ProgramArguments[0]
}

func plistPath() string {
    return filepath.Join(os.Getenv("HOME"),
        "Library/LaunchAgents/ai.hellofriday.studio.plist")
}
```

Plist parsing uses **`howett.net/plist`** — a stable, single-purpose,
pure-Go library with no transitive deps beyond stdlib. We add it to
the launcher's `go.mod`. Hand-rolled XML/regex parsing was considered
and rejected: 10 LoC saved, 100 LoC of brittleness paid back if a
user ever hand-edits the plist. process-compose and fyne-io/systray
do not pull in plist libraries; this is a launcher-only dep.

```go
// tools/friday-launcher/autostart_windows.go
func enableAutostart() error {
    exe, _ := os.Executable()
    // WRITE|READ so the same key handle could be reused; we still open
    // a separate READ-only handle in isAutostartEnabled() to follow
    // principle of least privilege per call site.
    k, _, _ := registry.CreateKey(registry.CURRENT_USER,
        `Software\Microsoft\Windows\CurrentVersion\Run`,
        registry.WRITE|registry.READ)
    defer k.Close()
    return k.SetStringValue("FridayStudio", fmt.Sprintf(`"%s" --no-browser`, exe))
}

func isAutostartEnabled() bool {
    k, err := registry.OpenKey(registry.CURRENT_USER,
        `Software\Microsoft\Windows\CurrentVersion\Run`, registry.READ)
    if err != nil {
        return false
    }
    defer k.Close()
    _, _, err = k.GetStringValue("FridayStudio")
    return err == nil
}
// disable: registry.DeleteValue (needs WRITE)
```

`registry.SET_VALUE` alone (which earlier drafts used) is insufficient
because `GetStringValue` requires `KEY_QUERY_VALUE`. Use
`registry.WRITE|registry.READ` on writes so the resulting handle is
usable for both, and a separate `registry.READ` handle for the read-
only `isAutostartEnabled()` path.

The plist template embeds `KeepAlive=false` (we want re-launch only at
login, not after user quit) and `RunAtLoad=true`. Bundle id is
`ai.hellofriday.studio` to match the Tauri installer's app bundle id
convention.

#### What the installer does for autostart now

**Nothing.** The installer just spawns the launcher detached. The
launcher self-registers on first run. Removing the
`tauri-plugin-autostart` dep + capabilities + plugin-init code shrinks
the installer's Tauri config and removes a moving part.

### Installer↔launcher contract

- Single touchpoint: `~/.friday/local/pids/launcher.pid`.
- pid file format: `<pid> <start_time_unix_seconds>` (two fields,
  space-separated), so a stale pid pointing at a recycled OS PID can
  be distinguished from a real launcher.
- File-locking: launcher takes an exclusive `flock` (Unix) /
  `LockFileEx LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY`
  (Windows) on the pid file while running. Installer takes an
  exclusive lock with timeout — failure to acquire = launcher is
  alive; success = stale pid file. (Note: this is the same lock
  Single-instance handling uses for Dock-click wake-up; both consumers
  share the file + lock semantics.)
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
  Quit): orderly handler in `onExit` flips the `shuttingDown` flag
  for the tray, kicks off `runner.ShutDownProject()` in a goroutine,
  and waits on the done channel with a 30 s deadline; then removes
  the pid file, releases the lock, returns. `systray.Run()` returns,
  `main()` returns, the process exits.
- The installer never needs to know the launcher's process-compose
  details (no port, no token, no REST surface exists at all) and now
  also never touches autostart (launcher self-registers).

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

- `fyne.io/systray` (v1.12.0+) for cross-platform tray icon + menu.
- macOS: regular `.app` bundle with both Dock and tray icon visible
  (NOT `LSUIElement`).
- Windows `.exe` built with `-ldflags="-H=windowsgui"` to suppress
  the console window flash.
- Tray-poll goroutine calls `runner.GetProcessesState()` every 2 s;
  renders icon + status string per the Tray Color Matrix above. Before
  each call, the loop checks `supervisorExited.Load()` and short-
  circuits to RED if true.
- Icons: four full-color tray PNGs (green / amber / red / grey) shipped
  via Go `embed` directive — see "Tray icon assets" above. Dock icon is
  a separate `Friday Studio.icns` asset.
- Menu items:
  - "Open in browser" → `pkg/browser.OpenURL("http://localhost:5200")`
  - "Restart all" → two-pass loop: stop in `stopOrder`, then start in
    `startOrder` (see "Restart order" above). Disabled when
    `supervisorExited.Load() == true`.
  - "View logs" → opens `~/.friday/local/logs/` in OS file browser.
    NOT `pkg/browser.OpenURL("file://...")` — that opens the directory
    listing in the user's web browser, not Finder. Instead shell out
    to the per-platform reveal command:
    - macOS: `exec.Command("open", logsDir).Run()` → Finder window
    - Windows: `exec.Command("explorer.exe", logsDir).Run()` → Explorer
    - Linux: `exec.Command("xdg-open", logsDir).Run()` → default file mgr
  - "Start at login" → checkbox bound to `enableAutostart()` /
    `disableAutostart()`; initial state from `isAutostartEnabled()`.
  - "Quit" → `systray.Quit()` (which fires onExit → split shutdown
    handler)
- Dock-icon click (macOS) is handled by the Single-instance
  handling section's SIGUSR1 trick, not by a fyne-io/systray
  callback.

### Launcher logging

- Launcher's own log: `~/.friday/local/logs/launcher.log` (rotated by
  the launcher itself with a 10 MB cap, 3 archived files).
- Per-supervised-process logs: process-compose collects stdout/stderr
  per process; `ProcessConfig.LogLocation` set per process to
  `~/.friday/local/logs/<name>.log`. Log rotation per process is out
  of scope for v1 (see Out of Scope).
- The launcher uses `zerolog` for its own logging (matching
  process-compose's choice) so log lines from both components share
  formatting and the global logger is configured exactly once.

### Tauri installer changes

- `Launch.svelte` becomes a "spawn launcher and close" step, no
  progress UI needed.
- `commands/launch.rs` shrinks dramatically — spawn the launcher
  detached, return. **No autostart code, no `tauri-plugin-autostart`
  dep, no health polling, no pid bookkeeping, no browser-open.**
- The "Start Friday Studio when I log in" checkbox is removed from
  the installer UI; the launcher self-registers autostart on first
  run and the user toggles it via the tray's "Start at login" menu
  item if they want to disable it.
- `commands/extract.rs::terminate_studio_processes` reads only
  `pids/launcher.pid` (not every binary's pid). Uses the lock-file +
  start-time-verification protocol described in the contract above.
- `capabilities/default.json` does NOT need autostart permissions
  (plugin removed entirely).

### Module Boundaries

#### `friday-launcher` binary

- **Interface:** CLI flags (`--no-browser`, `--autostart enable|disable|status`),
  pid file at `~/.friday/local/pids/launcher.pid` with
  `<pid> <start_time>` format and exclusive flock semantics,
  SIGTERM/TERM as the shutdown signal, SIGUSR1 (Unix) / sentinel file
  (Windows) as the Dock-click wake-up signal, OS-native autostart
  entry written by the launcher pointing at its own `os.Executable()`
  path. Tray icon + Dock icon visible to the user.
- **Hides:** that process-compose is the supervisor under the hood;
  the typed `types.Project` configuration; per-platform health probes;
  the cold-start grace-period logic; the Job Object machinery on
  Windows; the orphan-cleanup pass on Unix; the browser-open timing;
  the second-launcher-instance signal-handshake; the split-shutdown
  goroutine that prevents the macOS NSApp loop from blocking; the
  per-platform autostart entry shape (LaunchAgent plist /
  HKCU registry / .desktop file); the supervisor-exit watchdog that
  flips the tray to RED when `runner.Run()` returns unexpectedly.
- **Trust contract:** if `friday-launcher` holds the exclusive lock
  on `pids/launcher.pid`, Friday Studio is being supervised. SIGTERM
  brings everything down cleanly via process-compose's
  `ShutDownProject()`; SIGKILL on Windows still brings everything
  down via the Job Object; SIGKILL on macOS may leave supervised
  binaries running until the next launcher start, which performs an
  orphan cleanup. Spotlight / Dock relaunch is idempotent: the
  second invocation handshakes with the running one and exits. If
  the launcher is the active autostart target, it knows its own
  binary path is what's registered (it wrote the entry itself).

#### Tauri installer

- **Interface:** wizard UI; final step spawns the launcher detached
  and exits.
- **Hides:** download + sha-verify + extract details; arch detection;
  pid-file lock + start-time verification protocol.
- **Trust contract:** when the wizard's *Done* screen renders, the
  launcher is running. The launcher takes care of autostart on its
  own first-run pass.

#### process-compose (as a Go library dependency)

- **Interface:** `(&app.ProjectOpts{}).WithProject(p).With…()` builder,
  `app.NewProjectRunner(opts) (*ProjectRunner, error)`,
  `runner.Run() error` (blocking),
  `runner.GetProcessesState() (*types.ProcessesState, error)`,
  `runner.StopProcess(name string) error` (blocks up to per-process
  `ShutDownTimeout` waiting for actual exit),
  `runner.StartProcess(name string) error`,
  `runner.RestartProcess(name string) error`,
  `runner.ShutDownProject() error`.
- **Hides:** restart policies, health probing, dependency ordering,
  signal forwarding to children, internal state machine.
- **Trust contract:** if `state.IsReady()` returns true, every
  enabled supervised process responded successfully to its readiness
  probe within the last polling interval. `ShutDownProject()`
  returning nil means every supervised child exited cleanly.
  `StopProcess(name)` honors `ProcessConfig.ShutDownParams.ShutDownTimeout` —
  without a timeout configured, the call returns immediately after
  sending the stop signal (we always configure one).

## Testing Decisions

A good test exercises the launcher's *external* behavior: pid file
appears + disappears at the right times, tray status reflects
process-compose state, SIGTERM brings everything down cleanly, hard
kill on Windows brings everything down via Job Object, stale pid files
don't cause the installer to TERM unrelated processes, orphan cleanup
on Unix sweeps up SIGKILL'd survivors on next start, second-instance
launches wake the running launcher instead of fighting for ports,
shutdown returns from `onExit` within 30 s even if a child binary
ignores SIGTERM, autostart entry written by the launcher points at the
launcher's own binary path, supervisor-exit watchdog flips the tray
to RED when `runner.Run()` returns unexpectedly.

Modules tested:

- **Launcher orderly shutdown**: integration test that wires up the
  launcher with a stub `types.Project` (3 trivial Go HTTP servers as
  the "supervised" set), verifies the pid file appears with expected
  `<pid> <start_time>` format, sends SIGTERM, asserts pid file is
  gone and all child pids exited within the timeout. Shape mirrors
  the existing pty-server `protocol_test.go` integration tests
  (real subprocesses, no mocks).
- **Shutdown timeout safety**: stub a "supervised" process that
  ignores SIGTERM. Send SIGTERM to the launcher, assert `onExit`
  returns within 30 s + a small jitter, the launcher process exits,
  and the stuck child is killed by the OS reaper / Job Object.
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
- **Second-instance handshake (Unix)**: spawn a launcher, then spawn
  a second launcher binary; assert the second exits with code 0
  within 1 s, and that the running launcher received SIGUSR1 (verify
  by patching the open-browser handler with a counter under test).
- **Second-instance handshake (Windows)**: spawn a launcher, then
  spawn a second; assert sentinel file appears at
  `~/.friday/local/.wake`, then the running launcher's poller
  consumes it within 1 s and the open-browser counter increments.
- **Tray status mapping**: unit test against synthetic
  `types.ProcessesState` values — verifies the green / amber / red /
  grey mapping is total (every state combination resolves to exactly
  one color), AND that within the 30 s post-launch grace window the
  predicate never returns red regardless of probe state, AND that
  IsReady() being true always maps to green (no false-amber on
  healthy state), AND that `shuttingDown=true` always overrides to
  grey, AND that `supervisorExited=true` always overrides to red
  even when state.IsReady() returns true (tests stale-state-after-
  exit handling).
- **Browser-open guard**: unit test that the `openedBrowserThisSession`
  flag prevents repeated browser opens on state oscillation
  (green→amber→green should NOT reopen the browser; only the first
  green wins). Wakeup via SIGUSR1 / sentinel file IS allowed to
  open the browser regardless of the guard.
- **Restart-all order**: unit test that the Restart all loop calls
  `StopProcess` in `stopOrder` then `StartProcess` in `startOrder`,
  verified via a runner mock that records call order.
- **StopProcess blocks on exit**: integration test that asserts
  `StopProcess(name)` does NOT return until the supervised binary's
  PID has actually exited, verifying the per-process
  `ShutDownTimeout` configuration is wired correctly (process-compose
  returns immediately if ShutDownTimeout is zero).
- **Autostart self-registration (macOS)**: spawn a fresh launcher
  with a clean `~/.friday/local/state.json`, assert that
  `~/Library/LaunchAgents/ai.hellofriday.studio.plist` is created,
  the plist's `ProgramArguments` first entry equals the launcher's
  own binary path (`os.Executable()`), and `state.json` records
  `autostart_initialized: true`. Spawn a second launcher; assert it
  does NOT rewrite the plist (idempotency).
- **Autostart self-registration (Windows)**: same flow, asserting
  `HKCU\Software\Microsoft\Windows\CurrentVersion\Run\FridayStudio`
  is set to a quoted path matching `os.Executable() --no-browser`.
- **Autostart toggle from tray menu**: simulate "Start at login"
  checkbox uncheck → assert plist / registry entry removed; recheck
  → assert it's restored with the same content.
- **Autostart path-staleness repair**: write a state.json with
  `autostart_initialized: true` and a plist / registry entry pointing
  at `/tmp/old-launcher-path`. Spawn the launcher with a different
  `os.Executable()`; assert the entry is rewritten to the new path
  during goroutine E's startup pass, and `state.json` is unchanged
  (still `autostart_initialized: true`).
- **Supervisor exit watchdog**: stub a `runner.Run()` that returns
  after 1 s with an error; assert `supervisorExited.Load()` becomes
  true, the next tray-poll renders the RED bucket with the error
  string in the tooltip, the "Restart all" menu item is disabled,
  and "Quit" still cleanly exits the launcher process.
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
  matching the existing studio-build matrix. Autostart Linux code
  (writing `~/.config/autostart/friday-studio.desktop`) is implemented
  behind a `linux` build tag for forward-compatibility but not
  shipped in v1.
- **Uninstall flow.** Removing the autostart entry on uninstall is
  important but not part of v1 — currently we don't have an
  uninstaller at all. Manual workaround: tray menu's "Start at login"
  → uncheck before deleting Friday Studio.app.
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
- **Per-call autostart args.** The launcher always writes
  `--no-browser` into the autostart entry. If we ever want a per-user
  runtime config (e.g. `--open-browser-on-login`), it has to live in
  a config file the launcher reads on startup, not in the autostart
  command line.
- **Windows tray-icon ghost on hard-kill.** If the launcher is
  killed without a chance to call `Shell_NotifyIcon(NIM_DELETE)`
  (taskkill /F, crash, OOM), the icon may persist in the
  notification area until Windows polls and notices the owning
  process is gone — typically up to 30 s, or until the user hovers
  over the notification area. The kernel reaps child processes
  immediately via the Job Object; only the parent's tray icon takes
  time to disappear. This is intrinsic to Windows tray-icon
  semantics and inherent to every tray app, not specific to us.
- **Auto-restart of the process-compose supervisor on unexpected
  exit.** If `runner.Run()` returns when we didn't initiate shutdown,
  the launcher surfaces the RED tray state and disables Restart-all,
  but does not transparently rebuild the runner. Recovery is "user
  Quits and relaunches". Auto-rebuild (drop the runner, build a new
  one with a fresh `app.ProjectOpts`, `Run()` it again) is a v2
  consideration.
- **Panic-in-internal-goroutine blind spot in the supervisor watchdog.**
  v7's watchdog catches `runner.Run()` returning, but verified against
  `process-compose/src/app/project_runner.go:88-184`, Run()'s top-level
  loop only exits on context cancellation, all-processes-completed, or
  scheduled-only states — there is no top-level `defer recover()`. If
  one of process-compose's *internal* per-process supervision
  goroutines panics without propagating to the main loop, Run() stays
  blocked forever and `supervisorExited` never fires. The tray would
  keep showing the cached state for the surviving processes; the
  panicked one would silently freeze. We cannot wrap process-compose's
  internal goroutines from the launcher, and adding our own probe
  ("call GetProcessesState every N seconds; if it hangs longer than
  M, assume internal deadlock") would be paranoid for v1. Documented
  here so a future maintainer who sees a stuck-but-not-RED tray icon
  has a starting hypothesis. Revisit if observed in the field.
- **`tauri-plugin-autostart`.** Removed entirely. Earlier design
  versions used it; the plugin's `current_exe()`-at-call-time
  semantics meant the autostart entry would point at whichever
  binary called `enable()` (the installer), not at the launcher.
  Plain Go writing the per-platform entry is simpler, more direct,
  and removes a Tauri capability + dep.

## Further Notes

- The launcher binary size will be roughly the size of a Go binary
  with process-compose as a dep — measured from the process-compose
  repo's own `make build` (`CGO_ENABLED=0`): ~32 MB pre-codesign.
  Some dep-tree members (`gin`, `cobra`, `swag`, `tcell`, `tview`)
  come along even though we don't import them; Go's linker dead-strips
  unreferenced code, so runtime cost is minimal — the size hit is
  in the build artifact, not memory.
- All five service `/health` endpoints already exist (verified
  against current source — no follow-up commits needed before the
  launcher can ship).
- Tray icons are NOT macOS template images: we ship four full-color
  PNGs (green/amber/red/grey, 22×22) embedded via Go `embed`, and
  swap with `systray.SetIcon(<bytes>)`. `fyne.io/systray` has no
  runtime tint API; without separate assets per state, color signal
  in the menu bar is impossible. The Dock icon is the regular
  full-color app icon (separate `Friday Studio.icns` asset).
- `runner.RestartProcess(name)` exists but does NOT respect the
  dependency graph (it kills + restarts only the named process). v6
  uses `StopProcess` + `StartProcess` in two passes for the
  Restart-all path; `RestartProcess` is reserved for any future
  per-service restart UI where users explicitly want only one
  process touched.
- `runner.StopProcess(name)` blocks for up to
  `ProcessConfig.ShutDownParams.ShutDownTimeout` seconds while
  process-compose waits for the actual exit, then SIGKILLs and
  returns. If `ShutDownTimeout` is zero (the default), `StopProcess`
  returns immediately after sending the stop signal, which would
  race with the subsequent `StartProcess`. v6 sets `ShutDownTimeout
  = 10` on every supervised process for this reason.
- Concurrent `StopProcess(X)` + `StartProcess(X)` from different
  goroutines is NOT serialized by process-compose (only
  `RestartProcess` coalesces). v6 dispatches restart-all from a
  single goroutine and treats it as the only mutator of process
  state, so this is not currently a hazard. If we ever expose
  per-process tray controls, they need explicit serialization.
- We can dogfood the launcher locally by running
  `go run ./tools/friday-launcher` after `deno task playground`
  builds the supervised binaries.
- process-compose's `Health` JSON tag is `is_ready` (string enum:
  `"Ready"` / `"NotReady"` / `"Unknown"`), NOT a bool. The
  library-import path makes this transparent — we never see the JSON;
  we use `ProcessState.Health` (which is typed) and `IsReady()` /
  `IsReadyReason()` predicates directly.
- `fyne.io/systray` v1.12.0 has no Fyne-framework dependency despite
  the import path — it's a standalone OS-binding package
  (godbus + golang.org/x/sys only). No GUI runtime overhead.
- LaunchAgent plist bundle id `ai.hellofriday.studio` matches the
  Tauri installer's app id convention. If we ever switch the
  installer to a different bundle id, update the launcher's plist
  template to match (it doesn't need to be the same id as the
  installer, but consistency makes uninstall scripts simpler).
