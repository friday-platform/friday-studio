# Review: 2026-04-25-friday-launcher-design.v8.md (v8)

**Date:** 2026-04-25
**Reviewer:** /improving-plans single-pass review (1 focused Explore agent — sixth pass against the same three external repos)
**Output:** No version bump. Single small gap was amended in-place into v8 (the literal `plistTemplate` XML constant). v8 file remains `docs/plans/2026-04-25-friday-launcher-design.v8.md`.
**Sources ground-truthed:**
- `howett.net/plist` (v1.0.1, 2023-10-24)
- `golang/go` standard library `os.Rename` Windows implementation
- `/Users/lcf/code/github.com/ljagiello/airdash` (LaunchAgent prior art)

## Context Gathering

The v7 review report explicitly called out diminishing returns: "The
plan has been thoroughly vetted against three external libraries...
Recommend moving to implementation against v8 unless a new external
library bump or scope change introduces fresh unknowns."

This sixth-pass review honored the skill's "do not gold plate" rule
by spawning ONE focused Explore agent (not three parallel) to verify
specifically what was NEW in v8 vs v7: the `howett.net/plist`
dependency, the `currentAutostartPath` implementation, the
`atomicWriteFile` helper, and the `plistTemplate` constant.

## Ideas Raised + Decisions

### 1. `plistTemplate` constant referenced but not defined

**Reviewer recommendation:** Inline the literal XML template into the
`autostart_darwin.go` snippet. v8's `enableAutostart()` uses
`fmt.Sprintf(plistTemplate, "ai.hellofriday.studio", exe, "--no-browser")`
with three `%s` slots, but the actual XML never appears in the plan.
An implementer would need to derive it from prose ("KeepAlive=false,
RunAtLoad=true, ProgramArguments=[exe, --no-browser], Label=…") and
get the DOCTYPE declaration / outer `<plist>` wrapper / `<true/>` vs
`<string>true</string>` boolean encoding right by reference to a
sample.

**Tradeoff:** Plan currently is honest about intent but vague about
form. Three options:
- A: inline the XML into v8 in-place (recommended) — small fix,
  doesn't justify a v9 bump
- B: bump to v9 with the addition — cleaner audit trail per round
- C: leave as-is, trust implementer

**User decision:** **Accepted (option A — inline into v8 directly,
skip v9).**

**Rolled into v8:** `autostart_darwin.go` snippet now begins with a
`const plistTemplate = ` block containing the literal 14-line plist
XML. Comment above the constant explains the three `%s` slots and
why `KeepAlive=false` / `RunAtLoad=true` are the right combination
for our supervised-children use case. The constant is sufficient
for an implementer to copy-paste with no further reference required.

## Verified-and-Unchanged (no new issues in v8)

These v8 claims were re-checked and found correct:

- **`howett.net/plist` library** — exists at the import path
  `howett.net/plist`. Last release v1.0.1 (October 24, 2023) — not
  abandoned. Pure Go (no cgo). 23 stdlib imports only. Function
  signature `Unmarshal(data []byte, v interface{}) (format int, err error)`
  matches v8's call site exactly. Safe to add to launcher's `go.mod`.
- **`os.Rename` Windows atomicity** — verified that Go's standard
  `os.Rename` on Windows calls `internal/syscall/windows.Rename` which
  calls `MoveFileEx(MOVEFILE_REPLACE_EXISTING)`. Existing destination
  files are atomically replaced. v8's comment "atomic on POSIX,
  atomic on modern NTFS" is correct without qualification.
- All carry-over claims from v3-v7 reviews remain valid. No regressions
  introduced by v8's targeted edits.

## Ideas Considered and Discarded

None this round. The single focused agent surfaced only the
plistTemplate gap; nothing else was worth raising.

## Unresolved Questions

None.

**Recommendation: stop reviewing, start implementing.**

This is the **sixth review pass**. v8 has been thoroughly vetted
against `fyne-io/systray`, `F1bonacc1/process-compose`,
`tauri-apps/tauri-plugin-autostart`, `golang.org/x/sys/windows/registry`,
`howett.net/plist`, and Go's standard library Windows-rename
implementation. The remaining unknowns are properly Out-of-Scope:

- process-compose Go API stability across versions (pin in `go.mod`)
- Auto-rebuild of the supervisor on unexpected exit (v2 consideration)
- Panic-in-internal-goroutine blind spot (documented; revisit if seen)
- `launchctl disable` false-positive (niche; revisit if user reports)

Further review rounds will produce diminishing returns. The plan is
ready to implement. If implementation surfaces unknowns, those should
be resolved by reading the actual library source at the point of
failure, not by another design-review round.
