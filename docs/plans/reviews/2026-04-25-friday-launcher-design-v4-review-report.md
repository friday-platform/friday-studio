# Review: 2026-04-25-friday-launcher-design.v4.md (v4)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review (3 parallel Explore agents — second pass against the same three external repos)
**Output:** v5 plan at `docs/plans/2026-04-25-friday-launcher-design.v5.md`
**Sources ground-truthed (HEAD/tag at review time):**
- `/Users/lcf/code/github.com/fyne-io/systray` (v1.12.0, HEAD `3266b44`)
- `/Users/lcf/code/github.com/F1bonacc1/process-compose` (v1.103.0-1, HEAD `bd885ad`)
- `/Users/lcf/code/github.com/tauri-apps/tauri-plugin-autostart` (v2.5.1, HEAD `08f1aa3`)

## Context Gathering

The user asked for a second-pass verification of v4's claims against the
three external repos. Three parallel Explore agents focused on what was
NEW in v4 vs v3, deliberately avoiding retreading the v3-review findings.

Headline result: **two hard issues found in v4** (one compile error, one
shutdown UX bug) plus three smaller refinements. v4's v3-derived sections
all hold up.

## Ideas Raised + Decisions

### 1. 🔥 `app.NewProjectOpts()` doesn't exist — v4 won't compile

**Reviewer recommendation:** Use `(&app.ProjectOpts{}).WithProject(p)...`
instead of the non-existent `app.NewProjectOpts().WithProject(p)...`.
Verified against `process-compose/src/cmd/project_runner.go:31` which
itself uses `prjOpts := app.ProjectOpts{}` then chains `.With…()` calls
off the receiver.

**Tradeoff against v4:** v4's code would not compile. The fix is a
one-liner in the launcher's setup function.

**User decision:** **Accepted (FIX IT).**

**Rolled into v5:** "Constructing `Project` and `ProjectOpts`"
subsection explicitly notes "there is NO `app.NewProjectOpts()`
constructor. The launcher MUST use" the struct-literal-then-builder
pattern. Module Boundaries' process-compose entry's interface list
updates to start with `(&app.ProjectOpts{}).WithProject(p)…`.

### 2. 🔥 `onExit` runs synchronously in the macOS NSApp event loop — `runner.ShutDownProject()` will hang the UI for 5–30 s

**Reviewer recommendation:** Split shutdown so `onExit` flips a
`shuttingDown atomic.Bool` flag, kicks off `runner.ShutDownProject()`
in a goroutine, and waits on a `done` channel with a 30 s safety
timeout. The tray-poll goroutine reads the flag and renders a
"Shutting down…" greyed icon during the wait. macOS sees `onExit`
return within bounded time.

**Tradeoff against v4:** v4 said "onExit calls `runner.ShutDownProject()`"
which is technically correct but blocks the NSApp event loop for the
duration. During shutdown the user sees a stuck tray icon, no Dock
animation, the OS may eventually mark the app as unresponsive.

**Three options presented:**
- A: split shutdown — `onExit` waits on goroutine with deadline (recommended)
- B: do nothing in `onExit`; let OS reap children. Loses graceful child shutdown.
- C: current v4 — synchronous shutdown in `onExit`. UI hangs.

**User decision:** **Accepted (option A).**

**Rolled into v5:** New "Shutdown — `onExit` does NOT block on
`runner.ShutDownProject()`" subsection with full Go code skeleton.
Tray Color Matrix gains a 4th row: 🔘 grey for `shuttingDown=true`.
User story #10 reworded to mention the "Shutting down…" feedback.
New "Shutdown timeout safety" test added to Testing Decisions.

### 3. `systray.Quit()` doesn't auto-exit the process — `main()` must end with `Run()` call (or explicit `os.Exit(0)` after)

**Reviewer recommendation:** Add a one-line clarification to v5's
Goroutine layout that `main()` should end with `systray.Run()`, no
code after, so the Go runtime exits naturally. Explicit `os.Exit(0)`
after `Run()` only if we ever need post-Run cleanup.

**Tradeoff against v4:** v4 didn't say what happens after `systray.Run()`
returns — implementer might forget that the runtime needs no live
non-daemon goroutines for natural exit, or add `os.Exit(0)` redundantly.

**User decision:** **Accepted (FIX IT).**

**Rolled into v5:** New "`main()` shape (mandatory)" subsection at the
top of "Imported process-compose library" shows the exact `main()`
template with a comment explaining the no-code-after rule.

### 4. `runner.RestartProcess(name)` doesn't respect dependency graph — `range project.Processes` map iteration order is random

**Reviewer recommendation:** Two-pass restart — stop in
reverse-dependency order, then start in dependency order. Hard-code
the order in the launcher (we own the project; no need to compute
topological order at runtime). Use `runner.StopProcess(name)` and
`runner.StartProcess(name)` rather than `RestartProcess(name)` so we
control sequencing.

**Tradeoff against v4:** v4's "loop over Project.Processes calling
runner.RestartProcess(name)" iterates Go map in random order. If
playground gets restarted before friday/link, playground's health
probes fail during the window where dependencies are down, the tray
flashes amber→red→amber, the user sees a flicker.

**Three options presented:**
- A: topological-sort restart in two passes (recommended by user)
- B: ShutDownProject + recreate runner. Cleaner but runner can't be
  re-Run() once exited.
- C: random map iteration order, accept self-heal flicker. Simpler.

**User decision:** **Accepted (option A — topological-sort restart).**

**Rolled into v5:** New "Restart order" subsection inside "Project
configuration" hard-codes `stopOrder` and `startOrder` slices. Tray
UI menu "Restart all" now described as "two-pass loop". Module
Boundaries' process-compose entry adds `StopProcess` and
`StartProcess` to the interface list. Restart-all order test added
to Testing Decisions. User story #8 reworded to mention "in
dependency order, so user-visible state goes amber → green without
intermediate red flicker".

### 5. Windows tray-icon ghost on hard-kill — acknowledge as inherent limitation

**Reviewer recommendation:** Add to Out of Scope. Windows requires the
process to call `Shell_NotifyIcon(NIM_DELETE)` for clean removal,
which fyne-io/systray does on graceful exit but cannot do on
hard-kill (no chance to run cleanup code). The icon may persist up to
~30 s until the Windows shell polls notification-area owners. Inherent
to every Windows tray app, not specific to us.

**Tradeoff against v4:** v4 didn't mention this. It's not a bug we can
fix; documenting it sets correct expectations.

**User decision:** **Accepted (ok).**

**Rolled into v5:** New Out-of-Scope entry "Windows tray-icon ghost
on hard-kill" with the explanation. Job Object handles child-process
cleanup; only the parent's tray icon is affected.

## Verified-and-Unchanged (no new issues in v4)

These v4 claims were re-checked and found correct:

- All five `/health` endpoints still match (no source drift since v3).
- `app.NewProjectRunner(opts)`, `runner.Run() error` (blocking),
  `GetProcessesState`, `RestartProcess(name)`, `ShutDownProject()` —
  all signatures correct.
- `types.Project`, `types.ProcessConfig`, `types.RestartPolicyAlways`
  field/constant names correct.
- `health.Probe` + `health.HttpProbe` field types: `int` (seconds)
  and `string` (Port) correct.
- `tauri-plugin-autostart` Builder API: `Builder::new()`,
  `.args(["--no-browser"])`, `.app_name(...)`, `.build()` — all exact
  signatures correct. Capability strings `autostart:allow-enable` /
  `:allow-disable` / `:allow-is-enabled` correct.
- `MacosLauncher::LaunchAgent` is the default enum variant.
- `fyne.io/systray` `SetTemplateIcon(templateBytes, regularBytes)`
  signature + parameter order correct. Both global and menu-item
  variants exist. Template-only-on-macOS behavior confirmed.
- systray installs no signal handlers — our SIGTERM/SIGUSR1 handler
  is unconflicted.
- macOS `.app` bundle works without `LSUIElement` (Dock + tray both
  visible) — README explicitly notes LSUIElement is optional.
- Per-process `LogLocation` field on `ProcessConfig` confirmed.

## Ideas Considered and Discarded

- **Windows named-pipe IPC instead of sentinel-file polling for
  Dock/Spotlight wake-up.** More elegant but the polling latency
  is ~500 ms, well within "feels instant", and avoids
  Windows-specific named-pipe code. Sentinel file stays.
- **Stripping unused process-compose deps via build tags.** Go linker
  dead-strips at runtime; the build-artifact size cost (~32 MB) is
  fine compared to the 1.1 GB platform tarball.
- **Per-process tray submenu** (showing each binary's status). Already
  in Out of Scope from v3 review; no reason to revisit for v5.

## Unresolved Questions

None. All five recommendations were accepted as proposed.

One implementation-time risk remains flagged in Further Notes:
- **process-compose Go API stability across versions.** `app.NewProjectRunner`
  and `types.Project` are public APIs but evolve with releases. Bumps
  beyond `v1.103.x` should re-run the launcher integration tests
  before landing.
