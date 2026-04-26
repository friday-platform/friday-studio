# Review: 2026-04-25-friday-launcher-design.v7.md (v7)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review (3 parallel Explore agents — fifth pass against the same three external repos)
**Output:** v8 plan at `docs/plans/2026-04-25-friday-launcher-design.v8.md`
**Sources ground-truthed (HEAD/tag at review time):**
- `/Users/lcf/code/github.com/fyne-io/systray` (v1.12.0, HEAD `3266b44`)
- `/Users/lcf/code/github.com/F1bonacc1/process-compose` (v1.103.0-1, HEAD `bd885ad`)
- `/Users/lcf/code/github.com/tauri-apps/tauri-plugin-autostart` (v2.5.1, HEAD `08f1aa3`)
- `golang.org/x/sys/windows/registry` v0.42.0 (Go module cache)

## Context Gathering

The user asked for a fifth-pass verification. v7's targeted edits over
v6 were: `int(syscall.SIGTERM)` for the ShutDownParams.Signal field,
Windows registry `WRITE|READ` permissions, `os.Executable()`
staleness check on startup, and an Out-of-Scope note for the panic
blind spot.

This pass focused tightly on:
- Cross-platform compile of `int(syscall.SIGTERM)` (this is exactly the
  kind of detail that bites at build time, not design time)
- Correctness of the named registry constants (`registry.WRITE`,
  `registry.READ`, `registry.CURRENT_USER`)
- Specification gaps in `currentAutostartPath()` (referenced but not
  implemented in v7)
- File-write atomicity for `state.json` + the plist

Headline result: **one critical compile bug** (recurring pattern —
fourth round in a row that the Signal field has been wrong) plus
**two implementation gaps** that v7 hand-waved.

## Ideas Raised + Decisions

### 1. 🔥 `int(syscall.SIGTERM)` fails to compile on `GOOS=windows`

**Reviewer recommendation:** Use the literal `Signal: 15`. Verified
at `process-compose/src/command/stopper_unix.go:1` — the Unix-side
file is gated by `//go:build !windows` precisely because
`syscall.SIGTERM` is defined ONLY in Go's Unix syscall files. Writing
`syscall.SIGTERM` (or `int(syscall.SIGTERM)`) in cross-platform Go
fails with `undefined: syscall.SIGTERM` when compiling for Windows.

The literal `15` is the POSIX SIGTERM value and works on both
platforms with identical semantics:
- Unix: process-compose calls `syscall.Kill(pgid, syscall.Signal(15))`
  — value 15 IS SIGTERM, indistinguishable from `int(syscall.SIGTERM)`
- Windows: process-compose's `stopper_windows.go` accepts the `sig int`
  parameter but **discards it** — calls `taskkill /F /PID <n>`
  regardless. The int value is API-compatibility ballast.

This is the **fourth round** in which the Signal field has had a
problem (string in v5, missing in v6, wrong constant in v7). The fix
is now permanent and the rationale is documented in v8 to prevent a
fifth iteration.

**Tradeoff:** Magic number `15` in cross-platform code looks suspicious
to a reader. Two alternatives considered:
- A: literal `Signal: 15` with explanatory comment (recommended)
- B: build-tagged constant in `signal_unix.go` / `signal_windows.go`
- C: omit Signal entirely; rely on process-compose's internal default

**User decision:** **Accepted (option A — literal 15).**

**Rolled into v8:** ShutDownParams snippet uses `Signal: 15` with an
inline comment "POSIX SIGTERM value; cross-platform safe (see below)".
The explanatory paragraph below the code block now warns explicitly
NOT to use `int(syscall.SIGTERM)` and explains why with citations to
process-compose's stopper_unix/stopper_windows split.

### 2. `currentAutostartPath()` macOS implementation gap — pull in `howett.net/plist`

**Reviewer recommendation:** v7 references `currentAutostartPath()`
for the staleness-repair logic but doesn't show the implementation.
The macOS LaunchAgent plist is XML; reading `ProgramArguments[0]`
requires plist parsing. Three options:
- howett.net/plist library (~20 LoC clean unmarshal, single dep)
- Hand-rolled regex on plist file (~10 LoC, brittle)
- Shell out to `defaults read` (subprocess + text parse)

Neither process-compose nor fyne-io/systray pulls in a plist library,
so we'd be the first.

**Tradeoff:** v7 left the implementation "to the implementer", which
in a plan this thorough is a gap. Library is cleaner; hand-rolled is
fragile if the user hand-edits the plist.

**User decision:** **Accepted (howett.net/plist library).**

**Rolled into v8:** `autostart_darwin.go` Go skeleton expanded to
show:
- `import "howett.net/plist"`
- A `launchAgent` struct with plist tags
- Full `currentAutostartPath()` implementation
- `enableAutostart` / `disableAutostart` / `isAutostartEnabled` /
  `plistPath` helpers
- A paragraph below noting the library choice rationale: "stable,
  single-purpose, pure-Go, no transitive deps beyond stdlib".
- Notes process-compose / fyne-io/systray do NOT pull a plist lib;
  this is launcher-only.

### 3. `state.json` (and plist) atomic-write gap

**Reviewer recommendation:** Add a one-paragraph + 5-line helper
specifying that all file-backed state writes go through a
temp-file-then-rename pattern. POSIX `os.Rename` is atomic; on
modern Windows NTFS, the same call is atomic too.

**Tradeoff:** v7 left atomicity unspecified. If the launcher is killed
mid-write (kill -9, power loss, OOM), the file lands partial; next
startup's JSON / plist parse fails. Three options:
- A: specify temp-file + rename pattern (recommended) — small fix,
  prevents real bug
- B: leave to implementer — relies on judgment
- C: drop state.json entirely; check OS autostart entry directly

**User decision:** **Accepted (option A — specify the pattern).**

**Rolled into v8:** New "Atomic file writes (state.json AND the
plist)" subsection inside goroutine E's autostart section. Includes
the `atomicWriteFile` helper code and a note that:
- All writes to state.json AND the macOS plist use atomicWriteFile
- Windows registry writes are transactional at the OS level — no
  helper needed for that path
- Both `enableAutostart` (darwin) and any state.json writes call the
  helper, not `os.WriteFile` directly

## Verified-and-Unchanged (no new issues in v7)

These v7 claims were re-checked and found correct:

- All Windows registry constants verified at
  `golang.org/x/sys@v0.42.0/windows/registry/key.go`:
  - `registry.CURRENT_USER` (line 61) — exists as named
  - `registry.READ = 0x20019` (line 42) — exists as named
  - `registry.WRITE = 0x20006` (line 46) — exists as named
  - Bitwise OR (`registry.WRITE | registry.READ`) is correct usage
- All Windows registry function signatures verified:
  - `CreateKey(k Key, path string, access uint32) (Key, bool, error)` — correct
  - `OpenKey(k Key, path string, access uint32) (Key, error)` — correct
  - `SetStringValue(name, value string) error` — correct
  - `GetStringValue(name string) (string, uint32, error)` — correct
  - `DeleteValue(name string) error` — correct
- `ShutDownParams` field ordering and types confirmed at
  `process-compose/src/types/process.go` — `ShutDownTimeout int`,
  `Signal int`, `ParentOnly bool`, `ShutDownCommand string`.
- `runner.Run()` blocking semantics + return paths confirmed at
  `process-compose/src/app/project_runner.go:88-184` — only exits on
  `ctxApp.Done()`, all-processes-completed, or scheduled-only states;
  no top-level `defer recover()`.
- `GetProcessesState()` cache freezes after Run() exits — confirmed
  at `project_runner.go:298-351`.
- v7's path-staleness check semantics (compare `os.Executable()` to
  `currentAutostartPath()` on every startup; rewrite if different)
  are sound; no logic changes needed.

## Ideas Considered and Discarded

- **`launchctl disable user/$(id -u)/<label>` false-positive on macOS.**
  A user can disable the LaunchAgent via CLI without deleting the
  plist; `isAutostartEnabled()` (which checks file existence) would
  then return true even though autostart is inactive. Niche edge
  case — most users toggle via tray checkbox. Documenting it without
  fixing it adds noise; fixing requires shelling out to `launchctl
  list` and parsing output. Skip for v1.
- **Embed Windows app manifest for DPI awareness.** Plan's existing
  pattern (pty-server) doesn't embed one; sticking with that.
- **Use `os.Interrupt` instead of literal 15.** `os.Interrupt` is
  cross-platform but resolves to SIGINT (value 2) on Unix and
  CTRL_BREAK_EVENT on Windows. Wrong signal — we want SIGTERM
  semantics on Unix.
- **Build-tagged signal constants in our own code.** Cleaner than a
  magic number but adds two files. The literal `15` with explanatory
  comment is sufficient for a one-off ProcessConfig field.

## Unresolved Questions

None. All three recommendations were accepted as proposed.

This is the **fifth review pass**. The plan has been thoroughly
vetted against three external libraries (fyne-io/systray,
F1bonacc1/process-compose, tauri-apps/tauri-plugin-autostart) plus
`golang.org/x/sys/windows/registry`. Remaining implementation-time
risks:

- **process-compose Go API stability across versions.** Pin in
  `go.mod`; bump deliberately and re-run launcher integration tests.
- **Auto-rebuild of the supervisor on unexpected exit** — v8 surfaces
  RED tray + disables Restart-all but requires user Quit + relaunch;
  v2 consideration.
- **Panic-in-internal-goroutine blind spot** — documented in
  Out-of-Scope; revisit if observed in the field.
- **`launchctl disable` false-positive** — niche, undocumented;
  revisit if a user reports the surprise.

The plan is approaching ready-to-implement. Diminishing returns on
further review rounds; recommend moving to implementation against v8
unless a new external library bump or scope change introduces fresh
unknowns.
