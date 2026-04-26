# Review: 2026-04-25-friday-launcher-design.v5.md (v5)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review (3 parallel Explore agents — third pass against the same three external repos)
**Output:** v6 plan at `docs/plans/2026-04-25-friday-launcher-design.v6.md`
**Sources ground-truthed (HEAD/tag at review time):**
- `/Users/lcf/code/github.com/fyne-io/systray` (v1.12.0, HEAD `3266b44`)
- `/Users/lcf/code/github.com/F1bonacc1/process-compose` (v1.103.0-1, HEAD `bd885ad`)
- `/Users/lcf/code/github.com/tauri-apps/tauri-plugin-autostart` (v2.5.1, HEAD `08f1aa3`)

## Context Gathering

The user asked for a third-pass verification of v5's claims against the
three external repos. Three parallel Explore agents focused on what was
NEW in v5 vs v4 (split shutdown, two-pass restart, ProjectOpts builder
pattern, main() shape) plus a fresh end-to-end re-check of the
autostart story.

Headline result: **one 🔥 architectural defect found** (autostart
binary path resolution is broken in v5 as written), plus four smaller
refinements. v5's v4-derived sections (split shutdown, two-pass
restart, ProjectOpts builder, main() shape) all hold up against
source.

## Ideas Raised + Decisions

### 1. 🔥 `tauri-plugin-autostart` `enable()` writes the LaunchAgent plist pointing at the **installer** binary, not the launcher

**Reviewer recommendation:** Move autostart registration out of the
installer entirely. The launcher self-registers on first run by writing
the per-platform autostart entry directly in plain Go (no Tauri plugin,
no Tauri capabilities, ~150 LoC across `autostart_darwin.go` and
`autostart_windows.go`). A small JSON state file
`~/.friday/local/state.json` tracks `autostart_initialized: true` so
subsequent launcher starts don't rewrite the entry. A "Start at login"
checkbox in the tray menu and `--autostart enable|disable|status` CLI
flags expose toggle behavior post-install.

**Tradeoff against v5:** v5's installer calls
`tauri-plugin-autostart`'s `enable()` after copying `Friday Studio.app`
into place. The plugin reads `std::env::current_exe()` *at the time
`enable()` is called* and writes that path into the LaunchAgent plist's
`ProgramArguments`. Since `enable()` runs inside the installer's Tauri
process, the plist points at
`studio-installer.app/Contents/MacOS/studio-installer`, NOT at
`~/.friday/local/Friday Studio.app/Contents/MacOS/friday-launcher`.
**At next login the OS would re-run the installer**, never the
launcher. This is a hard correctness bug.

The plugin source has no `.app_path()` / `.executable_path()` builder
method to override the path; the `current_exe()` capture happens
inside `enable()`, not at Builder time. Three options presented:

- A: launcher self-registers on first run (recommended) — eliminates
  Tauri plugin + capabilities entirely; launcher knows its own path.
- B: installer rewrites plist after enable() — fights the plugin;
  macOS-only, Windows registry + Linux .desktop need separate
  post-processing logic; hacky.
- C: drop autostart from v1 — defer the feature.

**User decision:** **Accepted (option A — launcher self-registers).**

**Rolled into v6:** "Autostart registration" section completely
rewritten — header changed to "launcher self-registers — installer
does NOT use `tauri-plugin-autostart`". New subsections "When the
launcher writes the autostart entry" (state.json + tray checkbox +
CLI flags) and "Per-platform implementations (~150 LoC total)" with
Go skeletons for darwin and windows. New goroutine E in the
"Goroutine layout" diagram. New CLI flags: `--autostart enable`,
`--autostart disable`, `--autostart status`. Tray menu gains
"Start at login" checkbox item bound to `enableAutostart()` /
`disableAutostart()`. New user story #16 reworded to mention
"point at the launcher I just installed, not at the installer
binary". Module Boundaries' launcher entry adds the autostart
self-registration responsibility. Tauri installer changes section
gutted: `Launch.svelte` only spawns the launcher; capabilities/
default.json no longer needs autostart permissions; the install-time
"Start Friday Studio when I log in" checkbox is removed. Out of
Scope adds "tauri-plugin-autostart" with the rationale. Three new
tests in Testing Decisions: macOS plist self-registration, Windows
registry self-registration, tray-menu autostart toggle.

### 2. `runner.StopProcess(name)` returns immediately unless `ProcessConfig.ShutDownParams.ShutDownTimeout` is configured — v5's "synchronous — waits for exit" claim is misleading

**Reviewer recommendation:** Add `ShutDownParams.ShutDownTimeout = 10`
to every `ProcessConfig`. With this configured, `StopProcess` blocks
for up to N seconds while process-compose waits for the actual exit,
then SIGKILLs. Without it, `StopProcess` returns right after sending
the stop signal, which races with the subsequent `StartProcess(name)`
during Restart-all (port-in-use failures during teardown).

**Tradeoff against v5:** v5's "synchronous — waits for exit" wording
is technically wrong against process-compose's actual behavior. The
two-pass restart pattern v5 added depends on the wait being real;
otherwise the second pass starts before the first pass's stops have
landed.

**Three options presented:**
- A: configure ShutDownTimeout on each ProcessConfig (recommended) —
  smallest fix; uses the framework as designed
- B: launcher polls GetProcessesState until status flips —
  less reliance on framework internals but more code
- C: leave imprecise — accept the race window

**User decision:** **Accepted (option A).**

**Rolled into v6:** "Project configuration" section's restart-policy
block now also shows `ShutDownParams: types.ShutDownParams{
ShutDownTimeout: 10, Signal: "SIGTERM" }` as REQUIRED on every
process, with explanatory paragraph. "Restart order" subsection
clarifies the StopProcess wait is bounded by the per-process
ShutDownTimeout. Module Boundaries' process-compose entry's trust
contract gains an explicit note: "`StopProcess(name)` honors
`ProcessConfig.ShutDownParams.ShutDownTimeout` — without a timeout
configured, the call returns immediately after sending the stop
signal (we always configure one)." New "StopProcess blocks on exit"
test in Testing Decisions. Further Notes section gains a paragraph
explaining the StopProcess semantics + why we set ShutDownTimeout.

### 3. If `runner.Run()` exits unexpectedly, `GetProcessesState()` returns stale cached data forever — tray would show GREEN over five dead binaries

**Reviewer recommendation:** Wrap `runner.Run()` in a goroutine
function that, on return, sets a `supervisorExited atomic.Bool` and
stores the error. Tray-poll checks this flag first on each tick;
when set, render RED with tooltip "Friday supervisor exited
unexpectedly: <err>". Restart-all menu item disabled (you cannot
StartProcess on a dead runner). Quit still works — `systray.Quit()`
runs the normal `onExit` path.

**Tradeoff against v5:** v5's goroutine A is just `go runner.Run()`
with no observation of return. If Run() exits early (panic recovered
upstream, external context cancellation, unhandled internal error),
GetProcessesState() keeps returning the last cached state map
indefinitely. The user would see GREEN forever with five dead
binaries underneath, no way to discover the breakage without
opening the browser to a 404.

**Three options presented:**
- A: watch Run() return + tray-poll honors flag (recommended) —
  fastest user feedback; preserves graceful Quit
- B: treat unexpected exit as fatal, call os.Exit and let
  launchd/autostart re-spawn — simpler but loses crash-state
  diagnostics
- C: accept the staleness — relies on user noticing the failure
  through other means

**User decision:** **Accepted (option A).**

**Rolled into v6:** New "Detecting unexpected supervisor exit"
subsection inside "Imported process-compose library" with the
`runAndWatchSupervisor` Go skeleton + atomic.Bool/Pointer. Goroutine
A renamed in the layout diagram from `runner.Run()` to
`runAndWatchSupervisor()`. Tray Color Matrix gains a precondition:
RED if `supervisorExited.Load() == true`, regardless of cached
IsReady() result. Tray UI section adds: "Restart all" menu item
disabled when `supervisorExited.Load() == true`. New user story
#26 added: "if the process-compose supervisor inside the launcher
unexpectedly exits ... I want the tray icon to immediately go red
with a 'supervisor exited' tooltip". New "Supervisor exit watchdog"
test in Testing Decisions. Out of Scope adds an explicit note that
v6 does NOT auto-rebuild the runner — recovery is "user Quits and
relaunches".

### 4. Hard-coded stopOrder/startOrder slices vs `ProcessConfig.DependsOn` — keep hard-coded

**Reviewer recommendation:** Keep v5's hard-coded slices. Trade-off
analysis: process-compose's `ProcessConfig.DependsOn` only governs
*initial* start order anyway — it does NOT power dependency-aware
restart-all (process-compose has no native dependency-ordered
restart). So adopting DependsOn would still leave the launcher's
two-pass restart logic in place; it would just add a second source
of truth (the dep edges in ProcessConfig.DependsOn AND the
stopOrder/startOrder slices). Five binaries make the hard-coded
slices grep-able and self-documenting.

**Tradeoff against v5:** v5 already does the right thing here. The
review confirms the choice rather than changing it.

**Three options presented:**
- A: keep hard-coded slices (recommended) — simpler, single source
  of truth
- B: populate DependsOn AND keep restart-all slices — most thorough,
  small redundancy
- C: use DependsOn only — would require recreating ProjectRunner per
  restart-all (process-compose can't be re-run after ShutDownProject)

**User decision:** **Accepted (option A — keep hard-coded slices).**

**Rolled into v6:** No change to the order config itself, but
"Restart order" subsection's prose now explicitly justifies the
hard-coded approach over `ProcessConfig.DependsOn`: "self-documenting
nature of two named slices beats threading `ProcessConfig.DependsOn`
through five entries for a graph that fits on one screen". The
relative merits of the two approaches are now addressable on review.

### 5. Smaller corrections: `pkg/browser` doesn't open Finder; concurrent Stop+Start race documentation; spell out the 4 PNG asset files

**Reviewer recommendation:** Three small fixes that don't fit
elsewhere:

- **View-logs bug:** v5 says "View logs → opens
  `~/.friday/local/logs/` in OS file browser" implying `pkg/browser`.
  But `browser.OpenURL("file:///path/to/dir")` opens the directory
  listing in the user's web browser, not in Finder/Explorer.
  Switch to per-platform shell-out: `open` (macOS) /
  `explorer.exe` (Windows) / `xdg-open` (Linux).
- **Concurrent Stop+Start race:** process-compose's `RestartProcess`
  coalesces concurrent calls but `StopProcess` + `StartProcess` on
  the same name from different goroutines does NOT serialize. v5
  is fine because Restart-all is single-threaded, but a one-line
  note in the plan prevents future per-process tray controls from
  introducing the race silently.
- **4 PNG asset files:** `fyne.io/systray` has no runtime tint API;
  each tray color requires its own embedded PNG. v5 says "tray
  status updates" without spelling out the asset list. Make the four
  PNGs explicit: `tray-green.png`, `tray-amber.png`, `tray-red.png`,
  `tray-grey.png`. NOT macOS template images (we want color signal
  in the menu bar regardless of dark/light mode).

**Tradeoff against v5:** Three small clarifications; no
behavior changes (except View-logs which is an actual bug).

**User decision:** **Accepted (all three roll in).**

**Rolled into v6:** Tray UI's "View logs" menu item rewritten to
shell out per-platform with the exact `exec.Command` invocations
shown. New "Tray icon assets" subsection inside "Tray status
mapping" lists the four PNG asset paths and explains why they are
NOT template images. Further Notes section's tray-icon paragraph
rewritten to match. Further Notes adds a paragraph documenting the
concurrent Stop+Start non-coalescing behavior, why v6 isn't
affected, and the future hazard if per-process tray controls are
ever added.

## Verified-and-Unchanged (no new issues in v5)

These v5 claims were re-checked and found correct against current
source:

- `(&app.ProjectOpts{}).WithProject(p).WithIsTuiOn(false).WithOrderedShutdown(true)`
  builder pattern compiles against process-compose v1.103.0
  (`src/cmd/project_runner.go:31` does the same).
- Split-shutdown pattern (`onExit` flips atomic.Bool, kicks off
  `runner.ShutDownProject()` in goroutine, waits with 30s deadline)
  is the right shape for the macOS NSApp event-loop constraint.
- Two-pass restart with hard-coded `stopOrder` and `startOrder`
  slices is the right shape for our 5-binary dep graph (with the
  ShutDownTimeout fix from idea #2).
- `main()` shape (no code after `systray.Run()`) is correct —
  Go runtime exits naturally when no non-daemon goroutines remain.
- All 5 `/health` endpoints still correct.
- `fyne.io/systray` v1.12.0 API surface unchanged.
- macOS `.app` bundle without `LSUIElement` works for both Dock
  and tray icon visibility.
- SIGUSR1 (Unix) / sentinel-file (Windows) single-instance
  Dock-click wake-up trick is sound.
- Job Object on Windows for hard-kill resilience matches
  pty-server's working implementation.
- pid file format `<pid> <start_time_unix>` + flock + start-time
  verification is sound for the installer↔launcher contract.

## Ideas Considered and Discarded

- **Auto-rebuild the supervisor on unexpected exit.** Tempting:
  if `runner.Run()` returns, build a new ProjectRunner (the old one
  is unusable because its context is cancelled), call `Run()` again.
  Discarded because the path is hostile to debuggability — silent
  recovery from a state we don't understand papers over real bugs.
  v6 surfaces the failure (RED tray + tooltip) and requires explicit
  user action. Revisit if we see this happening in the field for
  innocuous reasons.
- **Use `ProcessConfig.DependsOn` to power restart-all.** Discussed
  in idea #4. process-compose's DependsOn only affects initial start
  ordering; it does not enable a dependency-aware restart action.
  Adding it would not let us delete the hard-coded restart slices.
- **Named-pipe IPC on Windows for second-instance wake-up.** v3
  review already considered + discarded; the sentinel-file polling
  is fine.
- **Replace `tauri-plugin-autostart` with `kardianos/service`.**
  `kardianos/service` is for headless services, not user-session
  GUI apps. Wrong tool. Plain Go writing the per-platform autostart
  entry (~150 LoC) is the right size of solution.

## Unresolved Questions

None. All five recommendations were accepted as proposed.

Two implementation-time risks remain flagged in Further Notes:

- **process-compose Go API stability across versions.** `app.NewProjectRunner`
  and `types.Project` are public APIs but evolve with releases. Bumps
  beyond `v1.103.x` should re-run the launcher integration tests
  before landing.
- **Auto-rebuild of the supervisor on unexpected exit.** v6 surfaces
  RED tray + disables Restart-all but requires user Quit + relaunch.
  If we see Run() exits in the field, revisit auto-rebuild as a v2
  consideration.
