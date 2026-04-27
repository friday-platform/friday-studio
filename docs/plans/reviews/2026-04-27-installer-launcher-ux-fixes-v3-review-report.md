# Review report: 2026-04-27-installer-launcher-ux-fixes (v3)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v4.md`

## Context gathered (new threads, on top of v1+v2 reviews)

- `tools/friday-launcher/integration_test.go` (TestUninstall) — the
  current test only verifies the launcher process exits and the
  autostart plist disappears. It doesn't spawn supervised stub
  processes and assert they die — exactly the gap the 2026-04-27
  bug exposed. v2's plan to extend this test is correct; v4
  carries it forward.
- `tools/friday-launcher/main.go:127-136` — startup sweep already
  runs `SweepOrphans` + `SweepByBinaryPath`. So orphans from a
  prior killed launcher get reaped on the NEXT boot. v3 builds on
  this: Cmd+Q-during-system-shutdown can leave orphans, but
  next-launcher-boot reaps them. Good lever.
- `fyne.io/systray@v1.12.1-0.20260116103033-9483f6fb4738` darwin
  backend (`systray_darwin.m`) — `applicationDidFinishLaunching`
  is what brings up NSApp + NSStatusBar. Before `systray.Run` is
  called, NSApp's runloop isn't spinning, so any cgo
  `[NSAlert runModal]` would either no-op or hang. This is the
  precise reason pre-flight needs a different dialog mechanism
  than the Quit confirmation modal.
- `tools/friday-launcher/supervisor.go` — `supervisor.State()`
  returns `*types.ProcessesState` from process-compose, where
  `IsReady` is a method, not a field. Each individual
  `ProcessState` has `Status` ("Running" / "Error" / etc.) and an
  `IsReady` flag that's true iff readiness probe is green. Plan's
  state-derivation logic (poll State() every 500ms, derive
  pending/starting/healthy/failed) is implementable.
- `tools/friday-launcher/supervisor.go:RestartAll` — bounces each
  supervised process via `StopProcess` + `StartProcess`. Doesn't
  touch the launcher's HTTP server (which is a non-supervised
  goroutine). v4 documents this lifecycle decoupling explicitly.

## Five new ideas — three asked, two baked in

### 1. Pre-flight NSAlert can't run before systray.Run brings up NSApp

**Problem in v3:** v3's pre-flight check (Issue 5 step 6) uses
"the same NSAlert cgo wrapper added for the Quit confirmation
modal". But pre-flight runs in `main()` BEFORE `systray.Run` —
NSApp isn't up yet. `[NSAlert runModal]` requires an active
NSApp event loop; without it the call either no-ops or hangs.
Quit confirmation runs AFTER `systray.Run` so it's fine, but
pre-flight is broken-by-construction in v3.

**Three approaches considered:**
- **A**: `osascript` via `exec.Command`. Spawns AppleScript,
  which has its own NSApp instance, returns user's choice via
  stdout. Pre-flight only; Quit confirmation can still use cgo
  NSAlert. Different code paths, but each tool fits its phase.
- **B**: Move pre-flight into `onReady` (after systray.Run starts
  NSApp). Tray briefly flashes broken state before alert pops.
  One NSAlert wrapper for both paths.
- **C**: Build a tiny dedicated NSApp for pre-flight, terminate
  on dismissal, fall through to systray.Run. Most code; matches
  macOS conventions strictly.

**User decision:** ✅ Adopt **A**. Each tool fits its phase; no
broken-state-flash; ~30 LOC for pre-flight osascript.

### 2. Wait-healthy 60s deadline is too aggressive for cold-start

**Problem in v3:** v3's wizard uses a flat 60s timeout for "all
services healthy". friday daemon's first-launch (Deno cold start
+ workspace bootstrap) can be 15-30s; combined with the other 5
services and slow disks (HDDs, antivirus scanning, network home
dirs), 60s is cutting close. Will fire prematurely on a slice of
real-world installs.

**Three approaches considered:**
- **A**: 60s soft + 90s hard with extension. At 60s, swap copy
  to "this is taking longer than usual" and show "Wait 60s more"
  button. Hard fail at 90s (or 150s if extended) with View Logs.
  Fast machines never see the longer message.
- **B**: Flat 90s, no progressive UX. Simpler.
- **C**: Stay at 60s. Aggressive timeout = support tickets.

**User decision:** ✅ Adopt **A**. Progressive UX accommodates
both fast and slow machines.

### 3. Wizard locked when 5/6 services are healthy

**Problem in v3:** v3 says "Open in Browser button is disabled
until every row is `healthy`". But if 5 are green and 1 is stuck
(e.g. webhook-tunnel waiting on cloudflared), the user is locked
into the wait/View Logs path — they can't try the browser even
though playground (the actual user-facing surface) is up.

**Three approaches considered:**
- **A**: After hard deadline, IF playground is healthy, show
  "Open anyway" alongside "View logs". Failed services stay
  visible in the tray. User decides whether the partial state
  is good enough for what they want to do.
- **B**: No escape hatch — must fix to proceed. Stricter.
- **C**: Always show "Open anyway" regardless of which services
  are stuck. Simpler; risks the case where playground itself is
  the broken one.

**User decision:** ✅ Adopt **A**. Conditioned on playground
health; user-facing surface is the right gate.

### 4. HealthCache state machine (baked in, no choice)

v3 enumerates the four states (`pending` / `starting` / `healthy`
/ `failed`) but doesn't specify state transitions. Implementers
will guess; tests will diverge from intent. v4 documents the
explicit state machine inline in the cross-cutting section:

- pending → starting: process spawned by supervisor
- starting → healthy: readiness probe returns 200; resets `since_secs`
- healthy → starting: process restarted by process-compose under
  MaxRestarts (transient amber pip in the wizard)
- * → failed: MaxRestarts exceeded (terminal until user-driven
  Restart all)
- failed → pending: only via tray Restart all

Also clarifies `since_secs` reference point: resets on every
state transition, NOT on launcher startup.

### 5. HTTP server lifecycle vs RestartAll (baked in, no choice)

v3 doesn't say what happens to the launcher's HTTP server during
`Restart all`. Reading the existing `supervisor.RestartAll` —
it only bounces the supervised processes — the answer is "HTTP
server keeps running". Future implementers might assume the HTTP
server is itself supervised and tear it down too. v4 documents
this lifecycle explicitly (HTTP server is decoupled from
RestartAll; only torn down once in performShutdown). SSE
subscribers see each service transition `healthy → starting →
healthy` during a restart-all.

## Issues spotted but NOT promoted to v4 changes

These were considered and discarded, recorded so future reviews
don't retread them:

### "Add HEAD /api/launcher-health for cheap polling"

WebView2 fallback case in v3 risk section. Considered: instead of
GET-and-parse-body, expose HEAD which returns 200 (all healthy)
or 503 (still starting) via headers only. Saves bandwidth.
Rejected: response payload is ~600 bytes; HEAD adds API surface
for negligible savings. WebView2 polling fallback is rarely-hit
anyway.

### "Validate the .app bundle id against existing macOS apps"

Considered: run `mdfind "kMDItemCFBundleIdentifier ==
'ai.hellofriday.studio-launcher'"` in CI to assert no collision.
Rejected: bundle id is unique enough that collision is
implausible; CI verification is over-engineering.

### "Generic notification listener for arbitrary launcher events"

Considered: extend `/api/launcher-health/stream` to also fan out
shutdown progress, restart-all events, autostart toggles, etc.
Rejected: scope creep. v4 sticks to "service health is the
contract; add more endpoints as concrete consumers arrive".

### "Quit confirmation modal as Tauri popup instead of cgo NSAlert"

Considered: spawn the installer's Tauri binary in dialog-only
mode (`tauri-plugin-dialog`) for Quit confirmation, reusing the
installer's existing cgo+notarization. Rejected: launcher and
installer are independent binaries with separate lifecycles;
inter-binary IPC for a confirmation dialog is heavier than a
40-line cgo wrapper.

### "Show service-by-service detail in the tray"

Considered: add a "View status…" tray menu item that opens a
small Tauri-Webview window showing the same checklist as the
wizard's wait step. Rejected: explicitly out-of-scope per the
non-goal "Adding a tray UI for service-by-service status". Users
who need detail can curl `/api/launcher-health` from a terminal,
which is exactly what `/api/launcher-health` exists for.

## Unresolved questions

None blocking — v4 is implementation-ready. Three things to
verify on real hardware during implementation:

1. **Spotlight + LSUIElement on macOS Sonoma+** (carried forward
   from v1+v2 reviews).
2. **EventSource on Windows WebView2** (carried forward from v2
   review).
3. **codesign --deep behavior with a duplicate flat binary at
   tarball root** (carried forward from v2 review).

New verification item for v4:

4. **`osascript` availability under MDM-restricted macOS.** Some
   corporate-managed Macs disable AppleScript via MDM policy. If
   pre-flight's osascript call fails, the launcher should log
   the error and exit cleanly (v4 documents this fallback). Test
   on a test machine with AppleScript disabled to verify the
   fallback path.

## Overlap with v3

v4 keeps unchanged from v3:
- The 6 problem statements
- The 7 goals (one bullet refined: broken-install reinstall
  dialog already in v3)
- The cross-cutting `/api/launcher-health` design
- The Quit confirmation modal design (cgo NSAlert post-systray.Run)
- The shutdown trace logging design
- The .app bundle id `ai.hellofriday.studio-launcher`
- The /Applications-only install with admin elevation
- The v0.0.8 → v0.0.9 migration sequence
- The `--uninstall` orphan-sweep fix
- Backwards-compatible v0.0.9 tarball
- Cmd+Q-during-system-shutdown acceptance + recovery via
  startup sweep
- LaunchAgent label vs bundle id non-goal

v4 changes from v3:
- Pre-flight dialog uses `osascript` instead of cgo NSAlert
  (separate code path from Quit confirmation)
- Wait-healthy deadline: 60s soft / 90s hard / +60s extendable
  (was flat 60s)
- "Open anyway" escape hatch when playground is healthy at
  hard deadline (was "block on all 6")
- New: explicit HealthCache state machine documented inline
- New: HTTP server lifecycle decoupled from RestartAll
  documented explicitly
- New risk: osascript availability under MDM restrictions
- New risk: extension-expired-but-playground-still-not-healthy
  edge case + "Wait again" link safety net
- File list adds `preflight_dialog_darwin.go` (osascript) +
  `preflight_dialog_windows.go` (MessageBoxW)
- Decisions list grows to 18 (was 14)
