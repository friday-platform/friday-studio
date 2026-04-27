# Review report: 2026-04-27-installer-launcher-ux-fixes (v2)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v3.md`

## Context gathered (new threads, on top of v1 review)

- `pkg/processkit/orphans.go` — `SweepByBinaryPath` impl uses
  `ps -eo pid=,comm=` and prefix-matches the binary path. Treats
  binaryDir == "" or "/" as a refusal case. Already used at
  launcher startup (`main.go:127-136`) — so the launcher already
  reaps orphans on next-boot; the v2 plan adds the same sweep at
  shutdown; that's the missing half.
- `tools/friday-launcher/main.go:127-136` — startup sweeps run
  unconditionally:
  ```go
  processkit.SweepOrphans(pidsDir())
  processkit.SweepByBinaryPath(binDir)
  ```
  This is why the user's `kill 15341 + ./friday-launcher` flow
  doesn't leave permanent orphans across restarts: if you boot a
  new launcher, the orphans get reaped. But if you `--uninstall`
  without booting a launcher (the 2026-04-27 scenario), the sweep
  never runs.
- `tools/friday-launcher/setupSignalHandlers` (`main.go:191-218`):
  SIGTERM/SIGINT trigger `performShutdown` directly; this is the
  always-reliable shutdown driver. macOS Cmd+Q does NOT send
  SIGTERM to a foreground app — NSApp's terminate flow is
  separate. v2's "hook NSApp will-terminate" plan is correct.
- `tools/friday-launcher/paths.go:8` —
  `launchAgentLabel = "ai.hellofriday.studio"`. Distinct from the
  v3 .app bundle id `ai.hellofriday.studio-launcher`. Worth being
  explicit that these are two different identifiers (different
  systems, both legitimate); nothing to migrate on the LaunchAgent
  side.
- `tools/friday-launcher/autostart_darwin.go:53` — the LaunchAgent
  plist body uses `os.Executable()` for the program path. This
  means once the launcher is invoked from inside the .app, the
  next `--autostart enable` writes the new path automatically. No
  manual path-rewriting needed in the migration step.

## Five new ideas (v2 → v3 deltas)

### 1. POST /api/launcher-shutdown handler self-deadlock risk

**Problem in v2:** v2 introduces a `POST /api/launcher-shutdown`
endpoint that triggers `performShutdown`. But `performShutdown`
needs to close the HTTP server (otherwise the server keeps
running after every other resource is freed). Specifically:
`http.Server.Shutdown(ctx)` waits for in-flight handlers to
finish — and the handler calling Shutdown is itself in-flight.
Synchronous handler → deadlock until ctx times out.

**Three approaches considered:**
- **A**: Handler returns 202 Accepted immediately, kicks off
  performShutdown in a goroutine, returns. Caller polls
  `/api/launcher-health` for "shutting down" state OR watches
  `launcher.pid` for removal. No deadlock risk.
- **B**: Handler does full performShutdown synchronously,
  including `srv.Close()` (NOT `srv.Shutdown` which waits). TCP
  connection to caller drops mid-response; caller has to interpret
  EOF as "shutdown started successfully". Ugly but simple.
- **C**: Two-phase: 200 OK + flush, kick off shutdown async,
  return. Caller doesn't get a Location to poll — just trusts
  the 200.

**User decision:** ✅ Adopt **A**. Cleanest semantics; clear
"shutdown initiated, watch /api/launcher-health" contract.

### 2. v0.0.9 platform tarball breaks v0.1.15 installers in the wild

**Problem in v2:** v2 says "ship v0.0.9 platform first, then v0.1.16
installer". But v0.1.15 installers consume the same studio
manifest URL — when v0.0.9 manifest publishes, v0.1.15 fetches
it, downloads the new tarball, and tries to extract it with the
v0.1.15 `extract.rs` that only knows flat layout. The .app at
the tarball root would extract to `~/.friday/local/Friday
Studio.app/Contents/MacOS/friday-launcher`, which doesn't match
the launcher's binDir resolution. Existing installs break.

**Three approaches considered:**
- **A**: Backwards-compatible tarball — ship duplicate
  `friday-launcher` at tarball root AND inside .app. v0.1.15
  installers extract everything flat, get a working launcher at
  `~/.friday/local/friday-launcher` (the duplicate); the .app/
  subdir is dead weight but harmless. v0.1.16+ installers do
  split-destination, skip the duplicate at root, get the .app
  at /Applications. ~7 MB extra per macOS tarball; one-shot
  transition cost.
- **B**: Ship v0.1.16 installer first, then v0.0.9 platform. Risk:
  fleet may not be 100% on v0.1.16 when v0.0.9 lands. Today's
  fleet is ~1 user (lcf) so this risk is small, but doesn't
  scale.
- **C**: Accept the break, tell users to redownload the
  installer. Cheapest, worst UX.

**User decision:** ✅ Adopt **A**. ~7 MB is cheap insurance;
unblocks any rollout order; clean future-cleanup path (drop
duplicate once v0.1.15 is gone).

### 3. Spotlight-launched .app on a broken install (no binaries)

**Problem in v2:** v2 doesn't address the case where the .app
exists but `~/.friday/local/` is missing/corrupt (e.g. user
`rm -rf`'d it for disk space). Today's launcher would silently
restart-loop for ~10s (5 restarts × 2s backoff), then services
go to `failed` state forever. Tray would be red, browser would
501, no clear next step for the user.

**Three approaches considered:**
- **A**: Pre-flight check at startup + NSAlert. Before
  `NewSupervisor`, verify each supervised binary exists and is
  executable. If any are missing, show NSAlert with "Friday
  Studio is not fully installed" + download-page link + Quit
  button. Skip systray init entirely. ~50 LOC; reuses the
  NSAlert cgo wrapper that Issue 6's confirmation modal needs
  anyway.
- **B**: Tray red + "Reinstall" menu item. Launcher boots,
  supervisor fails, tray bucket goes red, add a "Reinstall…"
  menu item that opens download URL. User has to notice the red
  tray to discover the problem.
- **C**: Silent log + tray red. Launcher logs missing binaries,
  tray red, no special UI. Lowest effort, worst UX.

**User decision:** ✅ Adopt **A**. Bundles cleanly with the
existing NSAlert work for Issue 6.

### 4. NSApp Cmd+Q teardown budget

**Problem in v2:** v2 hooks
`NSApplicationWillTerminateNotification` to drive performShutdown
on Cmd+Q, but doesn't address the time budget. Apple's HIG
suggests willTerminate handlers run in ≤200ms; in practice the
OS typically waits several seconds for interactive Cmd+Q but may
hard-kill during system shutdown when launchd is racing through
everything. Our `performShutdown` blocks up to 30s.

**Three approaches considered:**
- **A**: Run full performShutdown synchronously, accept hard-kill
  on system shutdown. Interactive Cmd+Q gives plenty of time;
  Cmd+Q-during-system-shutdown is rare and orphans get reaped
  by next-startup `SweepByBinaryPath` (already implemented in
  `main.go:127-136`).
- **B**: Detached cleanup helper. willTerminate spawns a small
  helper process (launcher binary with a `--cleanup-after <pid>`
  flag) that survives even if macOS hard-kills the launcher.
  Adds a launcher subcommand and the goroutine wiring.
- **C**: Block willTerminate up to 30s, hope macOS waits.

**User decision:** ✅ Adopt **A**. Simplest; the
Cmd+Q-during-system-shutdown path is rare and self-recovering.

### 5. LaunchAgent label vs .app bundle id (decided without asking)

**Problem in v2:** v2 doesn't address whether the existing
LaunchAgent label `ai.hellofriday.studio` (in `paths.go`) should
be renamed to match the new .app bundle id
`ai.hellofriday.studio-launcher`. They're two different
identifiers serving two different systems (launchd vs LSAppId)
but a future maintainer might wonder "why don't they match?"

**Decision (no choice asked):** Keep
`ai.hellofriday.studio` as the LaunchAgent label. Bundle ids
identify .app bundles to LSServices; LaunchAgent labels identify
launchd jobs to launchctl. Different systems, different
namespaces, no functional reason to align them. Renaming would
force a migration step (unload old plist, remove old plist file,
load new plist) for cosmetic clarity. Keeping the label avoids
that work.

Documented as Decision #14 in v3 + a Non-goal bullet.

## Issues spotted but NOT promoted to v3 changes

### "Bundle id collision with existing macOS apps"

`ai.hellofriday.studio-launcher` is a unique enough string
that collision risk is negligible. Verified via `mdfind
"kMDItemCFBundleIdentifier == 'ai.hellofriday.studio-launcher'"`
returns nothing on a fresh macOS install. Skip.

### "App Translocation rewrites os.Executable() path"

When a .app is launched from `~/Downloads`, macOS translocates
it to `/private/var/folders/.../d/`. `os.Executable()` returns
the translocated path. Our binDir detection
(`strings.Contains(exe, "Friday Studio.app/Contents/MacOS/")`)
matches both real and translocated paths because the .app
substructure is preserved during translocation. No change
needed; documented as a comment in v3's `defaultBinDir` example.

### "Existing startup sweep is broken under heavy load"

Considered: what if `ps -eo pid=,comm=` returns truncated lines
on machines with many processes? `comm` is limited to 16 chars
on Linux but unlimited on macOS. The current implementation
splits on the first whitespace and treats the rest as the path,
which is correct for macOS's full-path output but would break
on Linux's truncated comm. Since we don't ship Linux today,
defer this to a Linux-specific commit when we add Linux
support. Not a v3 change.

### "Health-cache concurrency might hot-loop the supervisor.State() call"

The plan says "poll every 500ms". 500ms × 6 services × in-process
read is trivial. No risk. Skip optimization.

### "/api/launcher-shutdown should require a CSRF token"

We're loopback-only (`127.0.0.1:5199`). Anyone who can already
make HTTP requests from your loopback interface can also send
SIGTERM directly. CSRF is irrelevant for loopback IPC. Skip.

## Unresolved questions

None blocking — v3 is implementation-ready. Three things to verify
on real hardware during implementation:

1. **Spotlight + LSUIElement on macOS Sonoma+.** v3 carries
   forward v2's 5-minute test recommendation.
2. **EventSource on Windows WebView2.** v3 carries forward v2's
   fallback-to-polling note.
3. **codesign --deep behavior with a duplicate flat binary at
   tarball root.** The duplicate `friday-launcher` outside the
   .app needs to be signed separately as a flat Mach-O. Verify
   that `codesign --deep --sign <id> Friday\ Studio.app` plus
   `codesign --sign <id> friday-launcher` produces a valid
   notarization request. Concern: notarization treats them as
   one upload; if the staple step expects a single artifact, we
   may need to staple separately.

## Overlap with v2

v3 keeps unchanged from v2:
- The 6 problem statements (with the 2026-04-27 confirmed-bug
  callout for `--uninstall`)
- The 7 goals (one bullet added: broken-install reinstall dialog)
- The cross-cutting `/api/launcher-health` design (extended with
  async-shutdown + concurrency-model + ordering-risk specifics)
- The Quit confirmation modal design
- The shutdown trace logging design
- The .app bundle id `ai.hellofriday.studio-launcher`
- The /Applications-only install with admin elevation
- The v0.0.8 → v0.0.9 migration sequence (extended with the
  cutover-tarball cleanup step)
- The `--uninstall` orphan-sweep fix

v3 changes from v2:
- POST `/api/launcher-shutdown` is async (202 + Location header)
- New: HTTP server shutdown ordering inside `performShutdown`
  (close LAST, after sweep + supervisor.Shutdown)
- New: tarball ships duplicate `friday-launcher` at root for
  v0.1.15 cutover compatibility
- New: pre-flight check for missing binaries → NSAlert + Quit
- New: explicit "Cmd+Q during system shutdown may hard-kill us"
  failure mode + acceptance + recovery path documented
- New: LaunchAgent label vs bundle id non-goal documented
- New: Concurrency model for HealthCache (RWMutex, single
  writer + many readers, non-blocking SSE fan-out)
- New: future-cleanup section (drop duplicate launcher once
  v0.1.15 fleet is gone)
- New: open-via-LaunchServices on first-launch in migration
  (registers .app with LSServices for immediate Spotlight
  indexing)
- Risks section gains: HTTP shutdown self-deadlock,
  Cmd+Q-during-system-shutdown, pre-flight false-positive
  guard
