# Review report: 2026-04-27-installer-launcher-ux-fixes (v14)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass — focused on alignment with
current repository shape (post-cleanup on `main`)
**Output:** `2026-04-27-installer-launcher-ux-fixes.v15.md`

## Summary

User specifically asked for this pass to focus on alignment
between v14 and the current codebase post-cleanup. Found four
real divergences — two are existing infrastructure the plan
didn't acknowledge (so an implementer would have written
duplicate code), one is pseudocode that doesn't match the
established pattern, one is implicit replace-vs-extend ambiguity
in a §Files-to-change line. v15 brings the plan in line with
what's actually on disk.

These aren't new design ideas; they're "the plan must stop
describing things that already exist as if they were new."

## Four alignment fixes, all baked in

### 1. `installed_marker.rs` exists — wire it into the migration (Decision #37)

The post-cleanup repo has
`apps/studio-installer/src-tauri/src/commands/installed_marker.rs`
with `write_installed(version)` + `read_installed()` that
manage `~/.friday/local/.installed` JSON marker
`{ version, installed_at }`.

In v13 review I'd raised a "layout-version marker file" idea
and the user (correctly at the time) rejected it on
"no backwards compat needed" grounds. But the cleanup added the
file infrastructure independently — so v15 just wires it up:

- New migration step 11: `write_installed("0.0.9")` after
  successful migration
- Decision #37 added — uses the existing module, no new file
- Test matrix gains an idempotency test: pre-seed the marker,
  rerun installer, assert migration is skipped

v0.0.8 → v0.0.9 still uses Mach-O sniff because v0.0.8 predates
the marker. From v0.0.9 onward, future migrations dispatch on
the marker.

### 2. Decision #33 must align with the existing two-atomic pattern

`tools/friday-launcher/main.go` already has:
- `shutdownStarted atomic.Bool` (line 56) — the **one-shot
  CAS gate** in `performShutdown` (line 270:
  `shutdownStarted.CompareAndSwap(false, true)`)
- `shuttingDown atomic.Bool` (line 48) — the **visibility
  flag** set by `performShutdown` (line 274:
  `shuttingDown.Store(true)`), read by the tray-poll goroutine

v14's cross-cutting § showed pseudocode using
`cache.shuttingDown.CompareAndSwap` for both gating AND
visibility — conflating roles. An implementer following v14
literally would either:
- Replace the existing `shutdownStarted` with a single
  `cache.shuttingDown` (works but rewrites stable code), OR
- Add `cache.shuttingDown.CompareAndSwap` ALONGSIDE the
  existing `shutdownStarted.CompareAndSwap` (two CAS gates
  in one shutdown path; redundant + confusing).

**Fix in v15:** pseudocode rewritten to match the existing
pattern. HTTP handler reads `shuttingDown.Load()` for the 409
probe (using a `*atomic.Bool` passed into HealthCache).
`performShutdown` uses the existing `shutdownStarted` CAS —
no new gate added. Decision #33 body explicitly says: "the
existing pattern already covers concurrent triggers; just
don't add a redundant CAS in the HTTP handler."

The only new bit: `srv.Shutdown(ctx)` becomes the LAST step in
`performShutdown` (after sweep, before `releasePidLock`).

### 3. `launch.rs` already resolves .app paths — no rewrite needed

`apps/studio-installer/src-tauri/src/commands/launch.rs:32-54`:

```rust
fn launcher_path(install_dir: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    {
        let app_path = install.join("Friday Studio.app")
            .join("Contents").join("MacOS").join("friday-launcher");
        if app_path.exists() { return app_path; }
    }
    // ... fall back to flat install_dir/friday-launcher ...
}
```

This is exactly what Issue 5's Stack 3 work needs on the
consumer side — and it's already done. The implementer's work
is on the **build-script side** (`scripts/build-studio.ts`
emitting the .app). v14 didn't acknowledge this, so an
implementer might rewrite the resolution code that already
exists.

**Fix in v15:** Issue 5 § gains an "Already done (v15
alignment note)" callout. §Files to change for Stack 3 lists
`launch.rs` with "**already has .app-bundle resolution** —
no changes needed. Listed here for cross-reference so
implementers don't rewrite it."

### 4. `extract.rs` is a rewrite, not an extension

The current `extract.rs` does whole-install-dir `.bak`
rollback (`dest_path.with_extension("bak")` →
`~/.friday/local.bak/`) plus `terminate_studio_processes`
(SIGTERM-and-poll launcher pid). The plan's split-destination
+ per-component staging + atomic-swap + HTTP-shutdown flow is
structurally incompatible — you can't extend the existing
function, you have to replace it.

**Fix in v15:** §Files to change lines for `extract.rs`
explicitly say "**rewritten end-to-end**" instead of just
"extend". Migration §Where the migration code lives reframes:
"the existing `extract_archive` function (with its whole-
install-dir `.bak` rollback) and `terminate_studio_processes`
are **rewritten end-to-end**, not extended." Saves the
implementer hours of "wait, do I keep the old code path?"
ambiguity.

## Issues considered and discarded

### "`scripts/build-studio.ts` and Go's `launcherBundleID` const can drift"

Decision #35 catches Info.plist mismatches at build time, but
doesn't ensure the TS plist template constant matches the Go
`autostart_darwin.go` constant. They're in different
languages, hand-typed.

Discarded as a v15 design decision: implementation-hygiene
concern, already documented in v12 review's discarded list.
The two assertions (TS Info.plist + Go autostart plist test)
together cover both languages — drift between them gets caught
at the runtime/test layer, not by a shared constant.

### "Migration sequence: 15s `poll_launcher_alive` + 20s SSE-connect deadline stack"

`launch.rs:114-138` does `poll_launcher_alive(15)` after
spawning the launcher — 15s wait for `launcher.pid` to
appear. The plan's wait-healthy 20s SSE-connect deadline runs
AFTER that. Total handoff window: 35s before the wizard's
60s soft / 90s hard deadlines start.

Discarded: not a bug, just sequencing. The pid-poll confirms
the launcher acquired flock; it does NOT confirm port 5199 is
bound (HTTP server starts after that, in `onReady`). So both
timeouts serve different purposes and stack legitimately.
Worth noting in code comments at implementation time but not a
v15 design decision.

### "Plan should reference launcher.go line numbers for context"

Considered: the plan describes patterns that are already
implemented (CAS gate, `SweepByBinaryPath` startup call, etc.)
without pointing at the existing line numbers. An implementer
might re-derive them.

Rejected: line numbers go stale fast. The plan should describe
patterns + function names, leaving an implementer to grep. v15
DOES reference specific line numbers for the
shutdownStarted/shuttingDown atomics in Decision #33 because
that's load-bearing for understanding the alignment fix; the
rest stays generic.

### "Tray controller's `state.IsReady()` heuristic"

Confirmed: `tools/friday-launcher/tray.go:202` currently uses
`state.IsReady() && len(state.States) > 0` for the green-
bucket check, with a 30s cold-start grace fallback to amber.
The plan's Issue 4 fix correctly identifies this and proposes
replacing it with health-cache-driven logic.

Already covered in earlier reviews; not a v15 fix.

## Unresolved questions

None. v15 is implementation-ready and now structurally aligned
with the post-cleanup codebase.

Verification items unchanged from v13 review.

## Overlap with v14

v15 keeps unchanged from v14:
- TLDR section structure (with v15 changelog header)
- All six problem statements, eight goals, four non-goals
- Cross-cutting `/api/launcher-health` endpoint surface;
  Caller response-handling table; state machine
- Issues 1+2+3, 4, 6 (unchanged)
- Issue 5 — only adds a "Already done" alignment note;
  existing fix plan + step list is unchanged
- Migration steps 1-10 unchanged; new step 11 added for
  `.installed` marker write
- Build sequence (unchanged; v0.1.16 still ships first)
- Stack 1/2/3 split + recommended order (unchanged)

v15 changes from v14:
- Cross-cutting § implementation block: pseudocode aligned
  with existing two-atomic pattern; HealthCache reads global
  `shuttingDown` instead of holding its own
- Issue 5 §: "Already done (v15 alignment note)" callout
  about `launch.rs:32-54`
- Migration § step 11: write `~/.friday/local/.installed`
- Migration § "Where the migration code lives": explicit
  rewrite-not-extend note
- §Files to change for `extract.rs` (Issue 1+2+3 + Issue 5):
  "**rewritten end-to-end**" wording
- §Files to change for Issue 5: `installed_marker.rs` listed
  as "**already exists**"; `launch.rs` listed as "**already
  has .app-bundle resolution**"
- Decision #33 body: aligned with existing code; explicit
  "don't add a new CAS in the HTTP handler"
- Decision #37 added (installed marker)
- Test matrix: new row for `.installed` marker + idempotency
- TLDR counts: 36 → 37 decisions, 14 risks unchanged

## Recommendation

**Stop reviewing the plan; start writing the code.** v15 is
the last useful /improving-plans output. After 14 review
passes — including this final alignment sweep against the
post-cleanup codebase — the plan is in lockstep with what's
on disk. Stack 1 (launcher HTTP server + Issue 6) ships the
highest-confidence fix with the smallest blast radius;
implementation should start there.
