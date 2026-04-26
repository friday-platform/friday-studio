# Review: 2026-04-25-friday-launcher-design.v6.md (v6)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review (3 parallel Explore agents — fourth pass against the same three external repos)
**Output:** v7 plan at `docs/plans/2026-04-25-friday-launcher-design.v7.md`
**Sources ground-truthed (HEAD/tag at review time):**
- `/Users/lcf/code/github.com/fyne-io/systray` (v1.12.0, HEAD `3266b44`)
- `/Users/lcf/code/github.com/F1bonacc1/process-compose` (v1.103.0-1, HEAD `bd885ad`)
- `/Users/lcf/code/github.com/tauri-apps/tauri-plugin-autostart` (v2.5.1, HEAD `08f1aa3`)
- `/Users/lcf/code/github.com/golang/sys` (for `golang.org/x/sys/windows/registry`)
- `/Users/lcf/code/github.com/ljagiello/airdash` (Go LaunchAgent prior art)

## Context Gathering

The user asked for a fourth-pass verification of v6's claims against the
three external repos. The biggest v6 architectural shift was moving
autostart registration from the Tauri installer's `tauri-plugin-autostart`
call into the launcher itself in plain Go (~150 LoC for darwin + windows).
The three parallel Explore agents focused on:

- macOS LaunchAgent plist + activation semantics (agent 1)
- Windows registry permissions, fyne-io/systray Windows backend, manifest
  needs, fsnotify alternative (agent 2)
- process-compose `ShutDownParams` field types, `Run()` return semantics,
  state-cache behavior after Run() exits (agent 3)

Headline result: **two compile / correctness bugs** and **three smaller
refinements**. The v6 architectural shift (launcher self-registration) is
sound; the bugs are in the implementation details v6 sketched.

## Ideas Raised + Decisions

### 1. 🔥 `ShutDownParams.Signal` is `int`, NOT `string` — v6 won't compile

**Reviewer recommendation:** Change v6's `Signal: "SIGTERM"` to
`Signal: int(syscall.SIGTERM)`. Verified at
`process-compose/src/types/process.go:280-285`: the field is declared
as `Signal int` (a numeric `syscall.Signal` value). Strings would not
compile. The signal value 15 (SIGTERM) is what process-compose then
sends via the underlying `Stop()` call.

**Tradeoff against v6:** v6 would not compile. The fix is one line in
the ProcessConfig snippet plus an explanatory sentence so future
implementers don't repeat the mistake.

**User decision:** **Accepted (option A — int(syscall.SIGTERM)).**

**Rolled into v7:** "Project configuration" section's
`ShutDownParams` block updated. New paragraph immediately below the
code block: "**`Signal` is `int`, not `string`.** process-compose's
`ShutDownParams.Signal` field is typed as `int` (a numeric
`syscall.Signal` value, e.g. `syscall.SIGTERM == 15`), not a
human-readable string. Earlier drafts used `Signal: \"SIGTERM\"`
which would not compile. Always pass `int(syscall.SIGTERM)`."

### 2. 🔥 Windows registry `SET_VALUE` permission can write but not read

**Reviewer recommendation:** v6's `enableAutostart()` opens the Run
key with `registry.SET_VALUE`. But `isAutostartEnabled()` calls
`GetStringValue` which requires `KEY_QUERY_VALUE`. Verified in
`golang.org/x/sys/windows/registry`: `SET_VALUE` (0x2) and
`KEY_QUERY_VALUE` (0x1) are independent bit flags. Use
`registry.WRITE | registry.READ` on the CreateKey for the write path,
and a separate `registry.OpenKey` with `registry.READ` for the
read-only `isAutostartEnabled()` path.

**Tradeoff against v6:** v6's read path would silently fail with
"access denied" or return a misleading "key not found" error.

**Three options:**
- A: WRITE|READ on CreateKey + separate READ for isEnabled (recommended)
- B: KEY_ALL_ACCESS everywhere — broader perms, simpler

**User decision:** **Accepted (option A).**

**Rolled into v7:** `autostart_windows.go` Go skeleton expanded to
show the `enableAutostart()` (WRITE|READ) and `isAutostartEnabled()`
(READ) functions side-by-side, with a comment explaining
principle-of-least-privilege per call site. New paragraph below the
code block explains why `SET_VALUE` alone is insufficient.

### 3. macOS plist activation — `launchctl bootstrap` for live activation NOT needed

**Reviewer recommendation considered, then declined:** Writing a plist
to `~/Library/LaunchAgents/` registers it for the *next* login but
launchd doesn't auto-detect new files mid-session. v6 could shell out
to `launchctl bootstrap gui/$(id -u) <plist-path>` after writing for
immediate activation. Trade-off: the launcher is already running when
the tray "Start at login" checkbox is toggled, so the autostart entry
only needs to be active at NEXT login — and launchd picks it up
automatically then. The shell-out is unnecessary complexity.

**Tradeoff against v6:** Without the shell-out, the tray checkbox
semantics are "will start at next login" rather than "currently
active in launchd". Matches the user's mental model for autostart.

**User decision:** **Accepted (option A — skip launchctl shell-out).**

**Rolled into v7:** Tray menu "Start at login" description in goroutine
E's section adds: "Note: the OS picks up newly-written plists /
registry values at the *next* login, not mid-session, so the checkbox
semantics are 'will start at next login' — the currently-running
launcher is unaffected."

### 4. `os.Executable()` staleness if user moves Friday Studio.app

**Reviewer recommendation:** On every launcher startup, compare the
current `os.Executable()` to the path recorded in the plist /
registry; if they differ, rewrite the entry. ~5 LoC. Prevents the
silent-failure mode where a user moves Friday Studio.app from
`~/.friday/local/` to `/Applications` and discovers months later
that autostart hasn't fired since the move.

**Tradeoff against v6:** v6 explicitly scopes the app to
`~/.friday/local/` and the Done screen tells users not to move it.
But UI guidance is weaker than runtime guarantees; this 5-line check
makes the system self-healing for free.

**User decision:** **Accepted (option A — add staleness check + document panic limitation).**

**Rolled into v7:** Goroutine E's responsibilities expanded from
"first-run self-registration" to "first-run self-registration AND
staleness repair". The narrative now lists two cases:
- `autostart_initialized != true` → write entry, set flag, save state.json
- `autostart_initialized == true` → ALSO call `currentAutostartPath()`
  (reads the registered path) and compare to `os.Executable()`; if
  different, call `enableAutostart()` to rewrite. Cheap and prevents
  the silent-broken mode.

New "Autostart path-staleness repair" test added to Testing Decisions.

### 5. `runner.Run()` panic blind spot in the supervisor watchdog

**Reviewer recommendation:** Document as Out-of-Scope. Verified at
`process-compose/src/app/project_runner.go:88-184`: Run()'s top-level
`for { select { ... } }` loop only exits on `ctxApp.Done()`, all-
processes-exited (`runProcCount == 0`), or scheduled-only states.
There is NO top-level `defer recover()`. If one of process-compose's
internal per-process supervision goroutines panics without propagating
to the main loop, Run() stays blocked forever and `supervisorExited`
never fires.

The launcher cannot wrap process-compose's internal goroutines, and
adding our own "is the supervisor still alive" probe (call
GetProcessesState every N seconds, assume deadlock if it hangs) would
be paranoid for v1.

**Tradeoff against v6:** v6 implies the watchdog is sufficient. It
catches Run() *exits* but not internal-goroutine *deadlocks*. A future
maintainer seeing a stuck-but-not-RED tray icon needs this hypothesis
documented somewhere.

**User decision:** **Accepted (document as Out-of-Scope).**

**Rolled into v7:** New Out-of-Scope entry "Panic-in-internal-
goroutine blind spot in the supervisor watchdog" with the explanation,
verification reference, and "revisit if observed in the field" note.

## Verified-and-Unchanged (no new issues in v6)

These v6 claims were re-checked and found correct against current
source:

- `runner.GetProcessesState()` returns frozen cached state after Run()
  exits — verified at `process-compose/src/app/project_runner.go:298-351`.
  No API flag for "supervisor alive" exists; the watchdog is the only
  signal.
- `ShutDownTimeout` blocks `StopProcess` for up to N seconds, then
  SIGKILLs — verified at `process-compose/src/app/process.go:466-488`.
- `runner.Run()` is genuinely blocking — verified the supervisor loop
  at `process-compose/src/app/project_runner.go:151-183`.
- fyne-io/systray's Windows `SetIcon` accepts PNG bytes (not just ICO)
  — verified at `fyne-io/systray/systray_windows.go`. The library
  converts PNG/JPG/ICO via `iconBytesToFilePath` + Windows `LoadImage`.
- LaunchAgent plist template (`KeepAlive=false` + `RunAtLoad=true`)
  matches kardianos-style prior art (e.g. airdash) for the
  "run-at-login, no auto-restart" use case.
- Bundle id `ai.hellofriday.studio` (launcher LaunchAgent label) does
  not collide with installer's `ai.hellofriday.installer` —
  LaunchAgent `Label` and app `CFBundleIdentifier` are independent
  keys.
- Sentinel-file polling on Windows: fsnotify exists and works on
  Windows, but 500 ms polling is acceptable for single-instance
  wake-up. Trade-off explicit in v6's text.
- `golang.org/x/sys/windows/registry` is the correct import path.

## Ideas Considered and Discarded

- **Embed Windows app manifest for DPI awareness / common-controls v6.**
  pty-server (PR #3012, the launcher's prior art for Windows builds)
  doesn't embed a manifest either. The platform's existing pattern is
  "no manifest"; the launcher follows suit. If we later need
  per-monitor DPI awareness for the tray icon's hi-res rendering,
  revisit.
- **Replace sentinel-file polling with fsnotify on Windows.** fsnotify
  works but adds a dep. Polling is fine for the wake-up use case.
  v6's trade-off discussion already covered this.
- **Add `currentAutostartPath()` returning `(string, error)` for
  symmetry with isAutostartEnabled().** v7's added staleness-repair
  logic introduces this helper implicitly; the test in
  Testing Decisions exercises it. Don't need to surface it in the
  module boundaries.

## Unresolved Questions

None. All five recommendations were resolved as proposed (4 accepted
into v7, 1 discarded with rationale).

Two implementation-time risks remain flagged in Further Notes /
Out of Scope:

- **process-compose Go API stability across versions.** Pin a specific
  version in `go.mod`; bump deliberately and re-verify launcher
  integration tests pass.
- **Auto-rebuild of the supervisor on unexpected exit.** v7 surfaces
  RED tray + disables Restart-all but requires user Quit + relaunch.
  Auto-rebuild (drop the runner, build a new ProjectOpts, Run again)
  is a v2 consideration.
- **Panic-in-internal-goroutine blind spot.** Documented in
  Out-of-Scope. Revisit if observed in the field.
