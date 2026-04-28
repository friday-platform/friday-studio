# Review report: 2026-04-27-installer-launcher-ux-fixes (v11)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v12.md`

## Summary

v11 closed all three gaps from the v10 review. v12 picks up
three smaller-but-real issues: one correctness bug (the CAS
gate's scope was too narrow), one ergonomics gap (no log file
when pre-flight fires), and one precision improvement (bundle
ID instead of display name for `open`). All three trace back
to spec ambiguities the prior 11 reviews missed because each
focused on different layers of the system.

## Three new ideas, all baked in

### 1. Concurrent-shutdown CAS gate (Decision #33)

v11's `cache.shuttingDown.CompareAndSwap` lived inside
`handleShutdown` (the HTTP POST handler), not in `performShutdown`
itself. Three trigger paths spawn `performShutdown` independently:

- Tray Quit (after confirmation modal) → `performShutdown("systray:onExit")`
- NSApp will-terminate observer → `performShutdown("nsapp:willTerminate")`
- HTTP POST handler → `performShutdown("http:shutdown")`

If two trigger fire simultaneously (e.g. user clicks tray Quit
while the installer's update flow POSTs `/api/launcher-shutdown`),
the HTTP path's CAS gate fires once and returns 409 to subsequent
HTTP callers — but tray Quit and NSApp will-terminate **don't**
go through that gate. They each spawn full `performShutdown`
goroutines. Most of the inner work is idempotent
(`supervisor.Shutdown`, double-SIGTERM, `SweepByBinaryPath`), but
`srv.Shutdown(ctx)` returns ErrServerClosed on the second call
and pollutes logs.

**Fix in v12 (Decision #33):** hoist the CAS gate into
`performShutdown` itself. All three trigger paths call the
function directly; the function does the gate. The HTTP handler
keeps a `Load()` probe to return 409 to concurrent HTTP callers
(preserves the contract from Decision #10), but the actual
shutdown work is now gated function-level. Idempotent at the
level that matters.

Test matrix: new row (Stack 1) that spawns N goroutines all
calling `performShutdown` simultaneously; asserts the inner
work runs exactly once.

### 2. Pre-flight + bind-failure diagnostic log (Decision #34)

v11's startup-error dialogs (missing binaries, port-in-use)
show a message and exit. The user has nothing to share with
support beyond the message body. Normal launcher logs at
`~/.friday/local/logs/launcher.log` aren't usable because the
dialog fires *before* the supervisor starts (and the logs/ dir
might not exist on a half-broken install).

**Fix in v12 (Decision #34):** before showing the dialog, write
a one-line diagnostic to
`os.TempDir() + "/friday-launcher-startup.log"`. Format:

```
2026-04-27T14:32:01Z startup error: pre-flight
  missing_binaries: friday,link
  bin_dir: /Users/lcf/.friday/local/bin
  exe: /Applications/Friday Studio.app/Contents/MacOS/friday-launcher
  os: darwin/arm64
```

Append-mode open so repeated failures accumulate. Dialog body
gains a `"Diagnostic log: <path>"` line. Best-effort — if
`OpenFile` fails (permissions, disk full), the dialog still
shows. Same path used by both pre-flight (missing binaries)
and bind-failure (port-in-use) variants.

Test matrix: new row (Stack 3) verifies the log file is created,
contains the expected fields, and the dialog body embeds the
log path. Append-mode is exercised by invoking twice.

### 3. `open -a "Friday Studio"` → `open -b "ai.hellofriday.studio-launcher"` (Decision #29 update)

LaunchServices resolves `-a "Friday Studio"` by display name.
If the user has a stale .app on disk (e.g. an old copy in
`~/Downloads`, or a previous install in `~/Applications` that
the migration missed), LaunchServices's resolution order can
return the wrong one. Bundle-ID resolution via `-b
"ai.hellofriday.studio-launcher"` is deterministic. Decision #3
already commits to that bundle ID for code signing — using it
for `open` is just consistency.

**Fix in v12:** Decision #29 amended. Plist `ProgramArguments`
becomes `["/usr/bin/open", "-b",
"ai.hellofriday.studio-launcher", "--args", "--no-browser"]`.
Migration steps 9 (re-register autostart) and 10 (first launch)
both invoke `open -b`. CLAUDE.md, §Test before shipping, §Risks,
build/ship sequence, and the `autostart_darwin_test.go` test
row all updated. The autostart test gains a negative assertion
that the plist does NOT contain `-a` or "Friday Studio" (display-
name resolution would re-introduce stale-.app shadowing).

The v10 limitation note (`--args` only delivers on fresh
launches) still applies under `-b` — same Apple Event semantics
when the .app is already running.

## Issues considered and discarded

### "Add a `--launcher-config <path>` flag for declarative startup config"

Considered: replace CLI args entirely with a JSON config file.
Solves the `--args` arg-drop limitation by sidestepping it.

Rejected: massive scope creep. The launcher takes one CLI flag
(`--no-browser`); a config-file system is overkill. Revisit if
the args list ever grows past 3.

### "Health response includes a `url` field per service"

Considered: extend `/api/launcher-health` to include
`url: "http://127.0.0.1:5200"` per service entry, so the
wizard's "Open in Browser" button can open the URL directly
instead of hardcoding port 5200.

Rejected: borderline gold-plating. Friday Studio always serves
playground on 5200 by current convention. If we ever change
the port, both launcher and wizard would need to update —
exposing it through the API would let the wizard pick up the
change automatically, but the simpler hardcode is fine for
now.

### "IPv6 dual-stack listen on port 5199"

Considered: bind both `127.0.0.1:5199` and `[::1]:5199` so an
IPv4-disabled corporate Mac doesn't break the wizard.

Rejected: macOS defaults to dual-stack; the only way to break
this is a deliberate corporate config. Not in this product's
threat model.

### "Linux SweepByBinaryPath via /proc/<pid>/exe"

Considered: noticed that `scanProcessesByBinaryPath` reads
`ps -eo pid=,comm=` which on Linux returns just the basename
(not the full path). Path-prefix matching would fail on Linux,
so SweepByBinaryPath is effectively broken there.

Rejected: out of scope. Friday Studio's primary target is
macOS; the user's fleet is one macOS user (lcf). The plan's
v0.0.8 → v0.0.9 migration is macOS-only. Linux/Windows parity
is a future concern when the platform target list grows.

### "Tauri command lifecycle on wizard window close"

Considered: when the user manually closes the wizard window
during wait-healthy, the `wait_for_services` Tauri command
keeps running its SSE relay goroutine. The launcher is
unaffected (it's detached) but the wizard's Rust process
leaks goroutines until process exit.

Rejected: implementation detail. Tauri's command cancellation
on window close is a well-known concern; the implementer will
handle it via channel cancellation or `tokio::select!` on a
shutdown signal. Not a v12-level design decision.

## Unresolved questions

None. v12 is implementation-ready.

Verification items carried forward (all have documented
fallbacks if they fail):

1. Spotlight + LSUIElement on macOS Sonoma+
2. EventSource on Windows WebView2
3. codesign --deep on the .app bundle
4. osascript availability under MDM-restricted macOS
5. xattr -dr behavior on signed .apps
6. LICENSE file presence at pinned upstream URLs
7. `open -b` autostart end-to-end at boot (v9, refined v12)
8. Pinned GitHub raw URL availability (v9)
9. Migration negative-path: extract failure recovery (v9)
10. Crash-recovery negative test (v10)
11. Playground probe path matches browser load (v10)

No new verification items in v12 — all three fixes are unit-
testable in CI without test-hardware verification.

## Overlap with v11

v11 keeps unchanged from v10 in v12:
- TLDR section structure (with v12 changelog header noting
  what changed; v11 changelog rolled into "all v11 design
  decisions roll forward")
- All six problem statements
- All eight goals + four non-goals
- Cross-cutting `/api/launcher-health` endpoint surface;
  Caller response-handling table from v11 unchanged
- Service status state machine; auth-walled probe caveat
  from v11 unchanged
- Issue 1+2+3 wizard rewrite (unchanged)
- Issue 4 tray fix (unchanged)
- Issue 5 .app bundling (unchanged except for `open -a` →
  `open -b` swap in step 5's xattr path documentation)
- Issue 6 Quit/uninstall sweep semantics (flow text adjusted
  to reference Decision #33's CAS gate)
- Build sequence (unchanged; v0.1.16 still ships first)
- Stack 1/2/3 split + recommended order (unchanged)

v12 changes from v11:
- Cross-cutting § implementation block: `handleShutdown` now
  uses `Load()` probe; `performShutdown` shown with CAS gate
  + early-return log line; shutdown ordering list gains a
  step-1 CAS gate
- Pre-flight § implementation block: `writeStartupErrorLog`
  helper added; both `showMissingBinariesDialog` and
  `showPortInUseDialog` write the log + embed the path in
  the dialog body
- All `open -a "Friday Studio"` references → `open -b
  ai.hellofriday.studio-launcher` (TLDR, goals, cross-cutting
  SSE-race section, Issue 5 step 5, migration table, migration
  steps 9 + 10, §Test before shipping, CLAUDE.md, §Risks,
  build/ship sequence, test matrix)
- Test matrix: 2 new rows (concurrent-shutdown CAS test,
  startup-error log test); existing autostart_darwin_test row
  updated to assert bundle-ID args length 5 + negative
  assertion against display-name args
- Decisions: #29 amended (`-b` not `-a`), #33 added (CAS gate
  hoisted), #34 added (startup error log)
- TLDR counts: 32 → 34 decisions, 14 risks unchanged

## Recommendation

**Stop reviewing the plan; start writing the code.** v12 is the
last useful /improving-plans output. Eleven prior review passes
+ v12's three small fixes closed all the platform-parity,
failure-mode, implementer-ambiguity, and concurrency edges that
survived. Stack 1 (launcher HTTP server + Issue 6) still ships
the highest-confidence fix with the smallest blast radius;
implementation should start there.
