# Review: 2026-04-25-friday-launcher-design.v3.md (v3)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review (3 parallel Explore agents)
**Output:** v4 plan at `docs/plans/2026-04-25-friday-launcher-design.v4.md`
**Sources ground-truthed:**
- `/Users/lcf/code/github.com/fyne-io/systray` (v1.12.0, HEAD `3266b44`)
- `/Users/lcf/code/github.com/F1bonacc1/process-compose` (v1.103.0-1, HEAD `bd885ad`)
- `/Users/lcf/code/github.com/tauri-apps/tauri-plugin-autostart` (v2.5.1, HEAD `08f1aa3`)

## Context Gathering

The user requested I run a team of agents and verify v3's library
assumptions against three external repositories. Three parallel Explore
agents returned independent reports. Highlights:

### From `fyne.io/systray`

- **Public API matches v3:** `systray.Run(onReady, onExit)`,
  `systray.AddMenuItem(title, tooltip)`, `item.SetIcon(bytes)`,
  `item.ClickedCh`, `systray.Quit()` — all present.
- **`runtime.LockOSThread()` is called in package `init()`** (systray.go:36-38),
  not in `Run()`. `systray.Run()` blocks indefinitely on macOS NSApp loop.
  Implication: process-compose `runner.Run()` MUST be in a goroutine
  spawned from `onReady`.
- **Template-image support is correct.**
  `SetTemplateIcon(templateBytes, regularBytes)` (systray_darwin.go:26).
- **Regular `.app` (no `LSUIElement`) does support both Dock + tray icon
  visible.** v3 was right.
- **CRITICAL: NO `applicationShouldHandleReopen` hook.** fyne-io/systray
  does not implement it. `SetOnTapped` only fires on tray icon clicks,
  not Dock clicks. v3 user story #22 ("Dock icon click → 'Open in
  browser'") IS NOT FEASIBLE without external Cocoa integration.
- **Dependencies are lightweight:** godbus + golang.org/x/sys only. No
  Fyne framework pulled in.
- **Windows console flash:** `-ldflags="-H=windowsgui"` is sufficient;
  no manifest needed.

### From `F1bonacc1/process-compose`

- **`app.NewProjectRunner(opts) (*ProjectRunner, error)` is public**
  (project_runner.go:1270).
- **`runner.Run() error` is BLOCKING** — runs the supervisor loop until
  context cancelled. v3's "in a goroutine" pattern is correct.
- **`runner.GetProcessesState()`, `state.IsReady()`, `RestartProcess(name)`,
  `ShutDownProject()`** — all public and on `*ProjectRunner`. v3's API
  reference is correct.
- **`types.Project` has public fields** — buildable via struct literal.
- **CRITICAL: `app.ProjectOpts` has PRIVATE fields** (project_opts.go:8-20).
  `&app.ProjectOpts{...}` will NOT compile. Must use builder pattern
  (`NewProjectOpts().WithProject(p).WithIsTuiOn(false)...`).
- **Probe fields are `int` (seconds), not `time.Duration`** (probe.go:11-19).
  v3's `InitialDelay: 5s` notation is misleading — actual code is
  `InitialDelay: 5`.
- **Restart policy fields verified:** `RestartPolicyConfig` with
  `Restart`, `BackoffSeconds` (int), `MaxRestarts` (int);
  `RestartPolicyAlways` constant exists.
- **`LogLocation` field on ProcessConfig** confirmed (process.go:31).
- **`IsReady()` returns true for Disabled processes** —  not a problem
  since the launcher has no Disabled processes.
- **Heavyweight deps come along:** `gin`, `cobra`, `swag`, `tcell`,
  `tview`, `gopsutil`. ~32 MB pre-codesign estimate is realistic. Go
  linker dead-strips unused code at runtime — size hit is in artifact,
  not memory.
- **No global state conflicts** beyond zerolog's global logger
  configuration; manageable.

### From `tauri-apps/tauri-plugin-autostart`

- **Plugin name + version:** `tauri-plugin-autostart` v2.5.1 (Cargo.toml).
  Tauri 2 compatible.
- **`ManagerExt` trait + `app.autolaunch()` method:** confirmed
  (lib.rs:74-76).
- **`enable()`, `disable()`, `is_enabled()`:** all return `Result<()>`
  / `Result<bool>` and take **NO arguments** (lib.rs:52, 59, 66).
- **CRITICAL: Args are set ONCE at plugin init time, not per-call.**
  v3's `app.autolaunch().enable("--no-browser")` syntax does not
  exist. Args go through `Builder::new().args([...]).build()` at
  installer Rust setup. JS frontend cannot influence args at all.
- **macOS launcher mode:** default `MacosLauncher::LaunchAgent`. There's
  also `AppleScript` for Login-Items integration if we want that
  later.
- **Per-platform mechanisms verified:** macOS LaunchAgent plist,
  Windows HKCU registry Run key, Linux ~/.config/autostart .desktop.
- **CRITICAL: Capabilities required.** Three permissions must be
  declared in the installer's `capabilities/default.json`:
  `autostart:allow-enable`, `autostart:allow-disable`,
  `autostart:allow-is-enabled`. Without these, runtime calls return
  permission-denied. v3 doesn't mention this.

## Ideas Raised + Decisions

### 1. Fix the `enable("--no-browser")` API call (won't compile against actual API)

**Reviewer recommendation:** Initialize the autostart plugin in the
installer's Rust `main()` with `Builder::new().args(["--no-browser"]).build()`
once. The checkbox toggles `enable()` / `disable()` to control whether
the autostart entry exists; the args are always whatever was set at
plugin init time.

**Tradeoff against v3:** v3 said `app.autolaunch().enable("--no-browser")`
which doesn't exist. The fix preserves the desired UX (autostart is
silent, manual launch opens browser) — manual launches don't go through
the autostart entry, so they get no flag → default behavior.

**User decision:** **Accepted (option A — fix the wiring).**

**Rolled into v4:** Rewrote "Autostart registration" section. New
"Plugin initialization (args are baked in here)" subsection shows the
Builder pattern. Out of Scope updated with "Per-call autostart args"
(plugin doesn't support; if we ever need per-user runtime config it
goes in a config file the launcher reads on startup).

### 2. Dock-icon click → "Open in browser" via SIGUSR1 / sentinel-file single-instance trick

**Reviewer recommendation:** Use the pid-lock infrastructure (already
specified for installer↔launcher coordination) to also handle Dock
clicks. When a second `friday-launcher` process starts and finds the
lock held, it sends SIGUSR1 (Unix) or writes a sentinel file
`~/.friday/local/.wake` (Windows) to the running launcher, then exits.
The running launcher's signal handler / poller routes that to
`pkg/browser.OpenURL`.

**Tradeoff against v3:** v3 user story #22 promised Dock-click → open
browser, but fyne.io/systray doesn't expose the macOS `applicationShouldHandleReopen`
callback. Three options:
- (a) SIGUSR1 + sentinel-file single-instance trick (recommended).
- (b) Accept limitation; Dock click does nothing.
- (c) Fork fyne-io/systray + add Cocoa cgo. Long-tail maintenance.

The SIGUSR1 trick reuses pid-lock infrastructure already chosen,
preserves the user-facing UX from #22, and the implementation is
small (one signal handler + one polling goroutine on Windows).

**User decision:** **Accepted (option A — SIGUSR1 trick).**

**Rolled into v4:** New top-level "Single-instance handling
(Dock-click wake-up)" section explains the lock-then-wake protocol.
User story #22 reworded to make the mechanism explicit ("clicking the
Dock icon for an already-running Friday Studio"). Module Boundaries'
launcher entry adds SIGUSR1 (Unix) and sentinel file (Windows) to
the interface list. New tests for second-instance handshake added to
Testing Decisions (Unix and Windows variants). Browser-open guard
test updated to allow SIGUSR1 / sentinel wakeup to bypass the
once-per-session flag.

### 3. Goroutine layout subsection — `systray.Run()` blocks main, runner.Run() also blocks

**Reviewer recommendation:** Add a one-paragraph "Goroutine layout"
subsection inside "Imported process-compose library" that pins down
which goroutine owns which blocking call. Without this an implementer
trying to call `systray.Run()` and `runner.Run()` in sequence would
deadlock on the second call.

**Tradeoff against v3:** v3 implicitly assumed implementers would
figure it out. fyne-io/systray's `init()`-time `runtime.LockOSThread()`
+ blocking `Run()` is a well-known macOS NSApp constraint but not
something a Go-only developer would intuit.

**User decision:** **Accepted.**

**Rolled into v4:** New "Goroutine layout (mandatory)" subsection
inside "Imported process-compose library" lists exactly which
goroutine runs each blocking call. Signal handler routes specified
(SIGTERM/SIGINT → orderly shutdown via `systray.Quit()`; SIGUSR1 →
open browser).

### 4. ProjectOpts builder pattern (struct literal won't compile)

**Reviewer recommendation:** Note explicitly that `ProjectOpts` has
private fields and must be constructed via `NewProjectOpts().With…()`
chain. `types.Project` separately has public fields and can be a
struct literal.

**Tradeoff against v3:** v3 said "Project configuration is built
programmatically as a typed `types.Project` struct" which is true —
but `ProjectOpts` is the *outer* type passed to `NewProjectRunner`,
and that one needs the builder.

**User decision:** **Accepted.**

**Rolled into v4:** New "Constructing `Project` and `ProjectOpts`"
subsection inside "Imported process-compose library" shows both
patterns side by side. Module Boundaries' process-compose entry
updates the interface list to start with `app.NewProjectOpts()`
builder.

### 5. Tauri 2 capabilities for autostart plugin

**Reviewer recommendation:** Add the three required permission strings
(`autostart:allow-enable`, `autostart:allow-disable`,
`autostart:allow-is-enabled`) to the installer's
`apps/studio-installer/src-tauri/capabilities/default.json`. Without
them, runtime calls fail with permission-denied.

**Tradeoff against v3:** v3 didn't mention capabilities at all. This
is a hard runtime failure if missed.

**User decision:** **Accepted (FIX IT).**

**Rolled into v4:** New "Required Tauri 2 capabilities" subsection
inside "Autostart registration" with the exact JSON snippet. Tauri
installer changes section also updated to include
`capabilities/default.json` in the list of files modified.

## Ideas Considered and Discarded

- **Switching from `LaunchAgent` to `AppleScript`** macOS launcher
  mode. AppleScript adds via Login Items and avoids LaunchAgent plist
  files, but LaunchAgent is the Tauri default and is more reliable
  cross-version. No reason to deviate for v1.
- **Stripping unused process-compose deps via build tags** (gin, swag,
  tcell, tview, gopsutil). Go linker already dead-strips them at
  runtime. The build-artifact size cost is real but ~32 MB is fine
  compared to the 1.1 GB platform tarball.
- **Named-pipe IPC on Windows instead of sentinel file** for the
  second-instance wake-up. More elegant but the polling latency of
  the sentinel file is well within "feels instant" and avoids
  Windows-specific named-pipe code.

## Unresolved Questions

None. All five recommendations were accepted as proposed.

One implementation-time risk to flag (already noted in v4's Further
Notes section):

- **process-compose Go API stability across versions.**
  `app.NewProjectRunner` and `types.Project` are public APIs but
  evolve with releases. Bumps beyond `v1.103.x` should re-run the
  launcher integration tests before landing.
