# Review: 2026-04-25-friday-launcher-design.v2.md (v2)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review
**Output:** v3 plan at `docs/plans/2026-04-25-friday-launcher-design.v3.md`
**Source ground-truthed:** `/Users/lcf/code/github.com/F1bonacc1/process-compose` (HEAD `bd885ad`, tag `v1.103.0-1`)

## Context Gathering

The user requested I read process-compose's actual source. Findings that
materially shift the design:

- **process-compose is importable as a Go library.** `src/app::NewProjectRunner(opts *ProjectOpts) (*ProjectRunner, error)` is public — the same constructor `cmd.Execute()` calls under the hood.
- **A typed Go client `PcClient` ships in `src/client/`** — `NewTcpClient(host, port, logLength)` and `NewUdsClient(sockPath, logLength)` — with methods like `GetProcessesState()`, `RestartProcess(name)`, `ShutDownProject()`. We never need to write our own REST wrapper if we go subprocess+REST.
- **The `Health` JSON field is a STRING ENUM** (`"Ready"` / `"NotReady"` / `"Unknown"`), not a bool. v2's "is_ready=true" code wouldn't compile against the real type.
- **`Status` enum has 12 values** (`Disabled`, `Foreground`, `Pending`, `Running`, `Launching`, `Launched`, `Restarting`, `Terminating`, `Completed`, `Skipped`, `Error`, `Scheduled`).
- **`ProcessesState.IsReady() bool` and `ProcessState.IsReadyReason() (bool, string)` are public methods** — process-compose's own predicate for "everything is ready", which we should defer to instead of rolling our own.
- **REST endpoint paths in v2 are wrong.** Plan says `POST /processes/restart`; actual route is `POST /process/restart/:name` (singular, with name in path). Verified against `src/api/routes.go`.
- **process-compose at HEAD is `v1.103.0`** (v2 cited `v1.85.x`).
- **process-compose has a TUI-internal browser-open helper** (`src/tui/open_browser.go`), so the YAML `open-browser` process trick isn't required even if we kept the subprocess model.

## Ideas Raised + Decisions

### 1. Embed process-compose as a Go library, not as an embedded binary 🔥

**Reviewer recommendation:** Pivot from v2's "embed the process-compose binary, exec it as a subprocess, talk to it over REST on a random loopback port" model to "import process-compose as a Go module, call `app.NewProjectRunner` directly, talk to it via typed Go method calls".

**Tradeoff matrix presented:**
- v2 model: ~25MB embed, port allocation, token file, REST polling, "what if process-compose dies" failure mode.
- New model: process-compose as a goroutine inside the launcher PID, no embed/extract, no port/token, direct typed method calls, no separate process to die. ~32MB final binary either way (the embed savings offset by pulling in process-compose's dep tree).

**Tradeoff against current plan:** the user's stated motivation for picking process-compose was *"easily extensible moving forward"*. Library import makes extension dramatically easier — we can wrap `NewProjectRunner`, intercept state events, customize spawn logic. The version-coupling risk is real but bounded: pin in `go.mod`, bump deliberately.

**User decision:** **Accepted (option B — import as library).**

**Rolled into v3:** Major rewrite. New "Imported process-compose library (NOT embedded binary)" section enumerates everything that disappears (embed.FS, sha-cache, port allocation, token file, REST polling, "what if process-compose dies" failure mode, `open-browser` YAML hack, `OpenCmd` template). New "Project configuration (typed Go struct, not YAML template)" section. Browser-open handled by Go code in launcher's main loop, gated on `state.IsReady()` and an `openedBrowserThisSession` flag. Launcher's module-boundary "hides" list updated. Module Boundaries' "process-compose subprocess" entry replaced with "process-compose (as a Go library dependency)".

User story #13 reworded ("Go library dependency, not separate embedded binary"). User story #15 reworded to refer to `IsReady()` predicate. User story #19 reworded ("typed `types.Project` struct" instead of YAML template).

**Cascading deletions:** v2's process-compose subprocess monitoring concern (open question from v1 review) is now moot — process-compose is a goroutine, not a child. v2's "30s wait for `process-compose down`" detail collapsed into "call `runner.ShutDownProject()`". v2's "OpenCmd platform-specific template variable" deleted.

### 2. Status × Health → tray color matrix needs to be explicit

**Reviewer recommendation:** Specify the exact mapping from process-compose's typed (`Status`, `Health`) state to tray (green / amber / red), and use `state.IsReady()` as the source-of-truth predicate for the "all ready?" question — never reimplement it in the launcher.

**Tradeoff against current plan:** v2 had a 3-row table that hand-waved "any service Pending/Starting → amber" without specifying which of the 12 Status values count as which color. Worse, v2's "is_ready=true" check wouldn't even compile.

**User decision:** **Accepted.**

**Rolled into v3:** New "Tray status mapping (uses process-compose's own predicate)" section with an explicit color-mapping table + Go pseudocode showing the predicate. Test for the predicate's totality + cold-start invariant added to Testing Decisions.

### 3. Fix v2's REST-API-shape errors (endpoint path + version)

**Reviewer recommendation:**
- Restart endpoint is `POST /process/restart/:name` (singular, with name path param), not `POST /processes/restart`.
- process-compose pinned version should be `v1.103.x`, not `v1.85.x`.

**User decision:** **Accepted.**

**Rolled into v3:** With the library-import pivot (#1) the REST endpoint detail becomes moot — the launcher calls `runner.RestartProcess(name)` directly on the typed `*ProjectRunner`. The version pin is now governed by `go.mod` resolution, not a string in the plan; v3 notes the current HEAD as v1.103 in Further Notes for reference.

## Cascading Plan Changes (Beyond the 3 Ideas)

The library-import pivot also let me clean up several unrelated v2 details
that were really workarounds for the subprocess model:

- **Hard-kill resilience section split into Windows + Unix paths.** v2
  applied "process group + Job Object" uniformly. With library import,
  the Windows Job Object can be set ONCE on the launcher process at
  startup, and supervised binaries inherit Job membership automatically.
  Unix doesn't have an equivalent; v3 documents the orphan limitation
  honestly and adds a "cleanup-on-next-start" pass that sweeps stale
  per-process pid files.
- **Per-process pid files come back.** v2 said "extract.rs reads only
  `pids/launcher.pid`, not every binary's pid". v3 keeps that for the
  installer↔launcher contract, but adds back per-process pid files —
  they're now used by the launcher itself for orphan cleanup on Unix
  hard-kill, not by the installer.
- **Launcher logging path specified explicitly** (`launcher.log` with
  10MB rotation cap, 3 archives) — v2 didn't say where the launcher
  logged.

## Ideas Considered and Discarded

- **process-compose's TUI browser-open helper as the open mechanism.**
  Found `src/tui/open_browser.go` which uses platform-specific exec
  commands. But it's tied to the TUI lifecycle and not exported as a
  standalone API. Better to use `pkg/browser` from the launcher's own
  Go code.
- **process-compose's WebSocket API.** Used for log streaming; doesn't
  emit state-change events directly. Not a fit for tray polling.
- **Forking process-compose to add hooks.** API is public enough that
  we don't need to fork for v1. Revisit if we hit a real upstream
  limitation.

## Unresolved Questions

None. All three recommendations were accepted as proposed.

One implementation-time risk to flag (already noted in v3's Further
Notes section):

- **process-compose Go API stability.** `app.NewProjectRunner` and
  `types.Project` are public APIs but evolve with releases. Bumps
  beyond `v1.103.x` should re-run the launcher integration tests
  before landing.
