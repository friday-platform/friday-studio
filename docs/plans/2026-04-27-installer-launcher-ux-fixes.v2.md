<!-- v2 - 2026-04-27 - Generated via /improving-plans from 2026-04-27-installer-launcher-ux-fixes.md -->

# Installer + Launcher UX Fixes (v2)

**Date:** 2026-04-27
**Branch:** declaw (per Atlas rule)
**Status:** Plan — implementation pending
**Supersedes:** v1 (`2026-04-27-installer-launcher-ux-fixes.md`)

## Problems (from user QA on v0.1.15)

1. **Launch step misleads** — wizard shows "Studio is open in your browser!"
   the moment `runLaunch` returns, but services are still booting. Clicking
   "Open in Browser" lands on a connection-refused page.
2. **Installer doesn't exit on Open in Browser** — wizard window lingers
   forever after the user has moved on to the browser.
3. **No unpack / verify progress** — wizard advances silently through SHA-256
   verification and tarball extraction; user sees the download bar at 100%
   then a blank pause until launch.
4. **Tray status menu still chevron-clipped** — the menu-item-as-status
   approach loses to macOS NSMenu's scroll-up chevron whenever the menu
   would render close to the screen edge. Status also stuck on "Starting…"
   even when all services are healthy.
5. **Friday Studio not in Spotlight** — the launcher binary isn't a `.app`,
   so macOS doesn't index it and `Cmd+Space → "Friday"` finds nothing.
6. **Quit doesn't stop services** — clicking "Quit" exits the tray but the
   supervised processes (friday, link, nats, etc.) keep running.
   `--uninstall` has the same bug: confirmed on 2026-04-27 that with
   the launcher already dead, `--uninstall` reports success while
   leaving `pty-server`, `webhook-tunnel`, and `playground` alive
   (had to `kill -9` each manually).

## Goals

- Wizard's "Launch" step honestly reflects whether services are usable.
- The wizard exits after handing the user off to the browser — its job
  is done.
- Every wizard step has visible state (no silent "100% then nothing").
- Tray status is **always visible** (not behind a chevron) and tells the
  truth (green when healthy, not stuck on "Starting…").
- Friday Studio launches from Spotlight like any other Mac app.
- Quit means quit — services down, ports free. Same contract for
  `--uninstall`: when it returns 0, every supervised binary's
  process is gone.
- A single source of truth for "which services exist and how do we check
  their health" — no list duplicated between launcher Go code and
  installer Rust code.

## Non-goals

- Re-architecting the launcher (still process-compose under the hood).
- Adding a tray UI for service-by-service status (status text in the
  menubar title is the contract; per-service status is exposed via HTTP
  for tools that want it).
- Per-file percent during tarball extract (running count is enough; see
  Issue 3 design).

---

## Cross-cutting: launcher's `/api/launcher-health` endpoint

This is new in v2 and unblocks Issues 1, 4, and 6.

The launcher today has no HTTP surface; the tray reads
`supervisor.State()` in-process and the installer's wizard has no way
to ask the launcher anything except "did the pid file appear". v2 adds
a small HTTP listener inside the launcher that becomes the **single
source of truth** for service health.

### Endpoint surface

```
GET  http://127.0.0.1:5199/api/launcher-health
GET  http://127.0.0.1:5199/api/launcher-health/stream   (SSE)
POST http://127.0.0.1:5199/api/launcher-shutdown
```

`GET /api/launcher-health` returns:

```json
{
  "uptime_secs": 14,
  "services": [
    { "name": "nats-server",    "status": "healthy", "since_secs": 12 },
    { "name": "friday",         "status": "starting", "since_secs": 4 },
    { "name": "link",           "status": "starting", "since_secs": 4 },
    { "name": "pty-server",     "status": "pending",  "since_secs": 0 },
    { "name": "webhook-tunnel", "status": "pending",  "since_secs": 0 },
    { "name": "playground",     "status": "pending",  "since_secs": 0 }
  ],
  "all_healthy": false
}
```

`GET /api/launcher-health/stream` is the same payload as
text/event-stream — emits an event whenever any service's status
changes. Used by the installer wizard to render a live checklist
without polling.

`POST /api/launcher-shutdown` is the orderly-shutdown trigger —
performShutdown is invoked, the response returns once teardown
completes (or the 30s deadline hits). Replaces the installer's
SIGTERM-and-pid-poll dance in `extract.rs`.

### Why this earns its keep

- **Tray bucket logic** today reads `supervisor.State().IsReady()`
  which is process-compose's heuristic. With our own per-service
  tracking, the bucket logic moves to: read `services` array, return
  green iff all `healthy`. Removes the stuck-amber bug.
- **Wizard's Launch step** subscribes to the SSE endpoint and renders
  a 6-row checklist that updates live as services come up. No polling
  loop in Rust.
- **Installer extract step** uses POST `/api/launcher-shutdown`
  instead of `terminate_studio_processes`'s SIGTERM-and-poll dance.
  Cleaner shutdown semantics; same fall-through-and-extract-anyway
  safety net.
- **Single source of truth**: adding a new supervised service means
  adding one entry to `project.go`'s `supervisedProcesses` and
  nothing else. Tray, wizard, and shutdown all pick it up.

### Implementation

```go
// tools/friday-launcher/healthsvc.go (new)
func startHealthServer(sup *Supervisor) *http.Server {
    r := chi.NewRouter()
    r.Get("/api/launcher-health", handleHealth(sup))
    r.Get("/api/launcher-health/stream", handleHealthStream(sup))
    r.Post("/api/launcher-shutdown", handleShutdown(sup))
    srv := &http.Server{Addr: "127.0.0.1:5199", Handler: r}
    go srv.ListenAndServe()
    return srv
}
```

Service status derivation:
- `pending`: not yet started by supervisor (still in startup ordering)
- `starting`: process running, readiness probe not yet green
- `healthy`: process running AND readiness probe green
- `failed`: process in Error state OR exceeded MaxRestarts

Implementation polls `supervisor.State()` every 500ms internally to
update an in-memory cache; HTTP handlers serve from cache. SSE
handler subscribes to a channel and pushes on state-change.

**Files:**
- `tools/friday-launcher/healthsvc.go` (new — chi router, handlers,
  SSE channel)
- `tools/friday-launcher/main.go` (call `startHealthServer` after
  supervisor created; close it in onExit)
- `tools/friday-launcher/tray.go` (bucket logic reads health-cache
  instead of `supervisor.State().IsReady()`)

---

## Issue 1 + 2 + 3: Wizard Launch step rewrite

### Current behavior

```
extract → launch → done
                ↑
   runLaunch() spawns launcher daemon, returns immediately,
   wizard shows "Studio is open in your browser!" with a button
   that opens http://localhost:5200 even if it 502s.
```

### Target behavior

```
extract (with running entry count)
   ↓
verify (subtitle flips to "Verifying SHA-256…" before the call)
   ↓
launch (spawn launcher) — already exists
   ↓
wait-healthy: subscribe to launcher's /api/launcher-health/stream
              SSE; render a 6-row checklist updating live; up to 60s
              deadline (each service has its own row that goes from
              spinner → ✓ or ✗)
   ↓
done: enable "Open in Browser" button only when every row is green
   ↓
on click: openUrl(...) → getCurrentWindow().close() → installer
          process exits
```

### Implementation notes

- **`wait_for_services` Tauri command** is a thin SSE-relay in
  `apps/studio-installer/src-tauri/src/commands/wait_health.rs`.
  Connects to `http://127.0.0.1:5199/api/launcher-health/stream`,
  forwards each event to a Tauri Channel as `HealthEvent`.
  - **No hardcoded service list in installer Rust.** That list lives
    in `project.go` only. The installer just renders whatever the
    launcher reports.
  - Timeout: 60s deadline; if the launcher hasn't reported all
    services healthy in 60s, emit `HealthEvent::Timeout { stuck:
    [name] }` listing services that are still not green.
- **Launch.svelte** renders one row per service from the
  `services` array in the latest health event. Each row: service
  name + a status pill (`spinner` if pending/starting, `✓` if
  healthy, `✗` if failed). The "Open in Browser" button is disabled
  until every row is `healthy`. On timeout, failed rows turn red and
  a "View logs" button replaces the spinner.
- **Exit on Open in Browser click**: add `await
  getCurrentWindow().close()` (Tauri 2 API) immediately after the
  `openUrl` call. The launcher is already detached (setsid on Unix,
  DETACHED_PROCESS on Windows), so killing the wizard window doesn't
  kill the platform.
- **Extract progress (running count, no total)**: switch
  `extract_archive` from `tar::Archive::unpack()` (single sync call,
  no hooks) to manual iteration via `archive.entries()`. For each
  entry: call `entry.unpack_in(dest)`, increment a counter, emit a
  `Progress { entries_done: N }` event every ~200ms via a Channel.
  Wizard shows `Unpacking… 1247 files` (no percent — counting
  upfront would require a wasted second pass over the tarball).
  Same Channel approach as `download_file`.
- **Verify progress**: SHA-256 over 540 MB takes ~1.5s on M-series.
  No need for byte-level progress — just flip the subtitle to
  "Verifying download integrity…" *before* the verify call (today
  the flip happens after, so the user sees nothing). One-line fix
  in `Download.svelte`.

### Files to change

- `apps/studio-installer/src-tauri/src/commands/wait_health.rs` (new —
  SSE relay)
- `apps/studio-installer/src-tauri/src/commands/mod.rs` (register)
- `apps/studio-installer/src-tauri/src/lib.rs` (invoke_handler)
- `apps/studio-installer/src-tauri/src/commands/extract.rs` (Channel
  parameter; switch to manual `archive.entries()` iteration)
- `apps/studio-installer/src-tauri/Cargo.toml` (add `tokio-sse-codec`
  or `eventsource-client` for SSE consumption)
- `apps/studio-installer/src/lib/installer.ts` (`waitForServices`,
  `runExtract` with channel; expose per-service status via store)
- `apps/studio-installer/src/lib/store.svelte.ts` (new fields:
  `services: Array<{name, status, sinceSecs}>`,
  `extractEntriesDone`)
- `apps/studio-installer/src/steps/Launch.svelte` (per-service
  checklist, exit-on-click)
- `apps/studio-installer/src/steps/Extract.svelte` (running-count UI)
- `apps/studio-installer/src/steps/Download.svelte` (subtitle flip
  order)

---

## Issue 4: Tray status — chevron + "Starting…" stuck

### Why the previous fixes failed

- v1 (status as menu item, `.Disable()` called): NSMenu treated the
  disabled-first-item as un-anchorable and pushed it above the menubar
  → scroll chevron clipped it.
- v2 (status as menu item, no `.Disable()`): chevron still appears in
  some screen-edge layouts. NSMenu's scroll-up indicator isn't reliable
  to predict, and we can't override it via `fyne.io/systray`.
- v3 (committed in 22301429b1, not yet shipped): status moved to
  **menubar title text**. Verified compiles, not yet on the user's
  machine because v0.0.8 platform tarball was built from a commit
  that didn't have the title-text move yet.

### Why "Status: Starting…" sticks even when services are up

The bucket logic was using process-compose's `state.IsReady()`, which
requires every process's readiness probe to fire green AND every
state's `IsReady` to be non-nil. When even one probe fails (e.g.
`link`'s `/health` doesn't exist on this binary version), the
heuristic returns false forever.

### Fix plan

1. **Land the title-text fix in the next platform build (v0.0.9).**
   Already committed as `22301429b1`. Will ship with the next
   `studio-build.yml` run.
2. **Replace bucket logic with the launcher's own health-cache.**
   The cross-cutting `/api/launcher-health` work above gives the
   launcher its own per-service status tracking. Bucket logic
   becomes:
   ```go
   func (t *trayController) computeBucket() trayBucket {
       if t.shuttingDown.Load() { return bucketGrey }
       if t.sup.SupervisorExited() { return bucketRed }
       cache := healthCache.Snapshot()
       if cache.AllHealthy() { return bucketGreen }
       if cache.AnyFailed() && cache.Uptime() > 30*time.Second {
           return bucketRed
       }
       return bucketAmber  // pending/starting in cold-start grace
   }
   ```
   No more `state.IsReady()` indirection through process-compose.
3. **Don't blindly trust readiness probes.** Each service's
   `status: starting → healthy` transition uses our own probe of its
   declared health endpoint (HTTP GET, expect 200). If a probe is
   misconfigured (wrong port/path), the service reports `starting`
   forever — that's visible in the wizard's checklist and surfaces
   as "this one service won't go green" instead of an opaque amber
   tray.

### Files to change

- `tools/friday-launcher/tray.go` (already moved status to title in
  commit 22301429b1; now also: bucket logic reads health-cache;
  needs new platform build to ship)
- `tools/friday-launcher/healthsvc.go` (the per-service polling +
  cache from cross-cutting work)

---

## Issue 5: Spotlight integration

### Current state

The `friday-launcher` binary lives at
`~/.friday/local/friday-launcher` — it's a flat ELF/Mach-O, not an
`.app` bundle. Spotlight indexes `/Applications`, `~/Applications`, and
`~/Downloads` for `.app` bundles by default; flat binaries are
invisible.

### Fix plan

1. **Wrap the launcher in a `.app` bundle in the platform tarball.**
   `scripts/build-studio.ts` currently emits flat binaries. Add a
   macOS-only branch that packages `friday-launcher` as
   `Friday Studio.app/Contents/MacOS/friday-launcher` with:
   - `Contents/Info.plist` (CFBundleName, CFBundleIdentifier
     `ai.hellofriday.studio-launcher`, CFBundleIconFile,
     LSUIElement=1 for menubar-only apps so it doesn't show in the
     Dock)
   - `Contents/Resources/AppIcon.icns` (Friday logo, sourced from
     `apps/studio-installer/src-tauri/icons/`)
   - `Contents/_CodeSignature/` (created by `codesign --deep` in CI)
2. **Tarball layout (macOS).**
   ```
   tarball-root/
     Friday Studio.app/
       Contents/MacOS/friday-launcher
       Contents/Info.plist
       Contents/Resources/AppIcon.icns
     friday
     link
     nats-server
     pty-server
     webhook-tunnel
     cloudflared
     gh
     playground
   ```
   The supervised binaries stay flat at the tarball root. Windows
   and Linux tarballs keep the existing flat layout — the `.app`
   wrapper is macOS-only.
3. **Installer extract — split-destination logic.** Today
   `extract_archive` unpacks to a single dest (`~/.friday/local/`).
   The new layout requires:
   - `Friday Studio.app/` extracts to `/Applications/Friday Studio.app`
     (with admin-elevation prompt if needed; see step 4)
   - All other entries extract to `~/.friday/local/`
   Implementation: iterate the archive once, dispatch each entry by
   its top-level component. Same `archive.entries()` iterator used
   for progress reporting.
4. **`/Applications` install with admin elevation.** Always target
   `/Applications/Friday Studio.app`. If the write fails with
   permission-denied, surface a Tauri dialog asking the user to
   authenticate; on confirm, retry the copy via
   `osascript -e 'do shell script "..." with administrator
   privileges'` (one prompt per install). On most modern macOS
   machines `/Applications` is user-writable and no prompt fires.
   - `~/Applications` is *not* a fallback — it doesn't exist by
     default and Spotlight indexing is best-effort there. We commit
     to one canonical location.
5. **Launcher's `binDir` resolution updated for .app context.** When
   the launcher runs from `Friday Studio.app/Contents/MacOS/`, the
   supervised binaries are NOT siblings — they're in
   `~/.friday/local/`. Update `tools/friday-launcher/main.go`'s
   `binDir` default:
   ```go
   func defaultBinDir() string {
       exe, _ := os.Executable()
       // If our exe path contains "/Friday Studio.app/Contents/MacOS/",
       // we're running from the .app bundle; supervised binaries
       // live in ~/.friday/local/.
       if strings.Contains(exe, "Friday Studio.app/Contents/MacOS/") {
           return filepath.Join(homeDir(), ".friday", "local")
       }
       // Otherwise, supervised binaries are siblings of the launcher
       // (legacy flat layout, Linux/Windows, dev runs).
       return filepath.Dir(exe)
   }
   ```
6. **`--uninstall` updated.** Remove
   `/Applications/Friday Studio.app` *after* the launcher process
   has exited — the running binary can't delete its own .app bundle
   on macOS without macOS killing the process mid-removal. Spawn a
   detached cleanup helper that waits for `launcher.pid` to
   disappear, then `rm -rf /Applications/Friday Studio.app`.

### Files to change

- `scripts/build-studio.ts` (macOS .app bundling — staging tree
  restructure; emit Info.plist + AppIcon.icns + .app/Contents/MacOS/)
- `.github/workflows/studio-build.yml` (codesign at the bundle level
  with `codesign --deep`; notarize the bundle, not individual
  binaries)
- `tools/friday-launcher/main.go` (binDir default for .app context)
- `tools/friday-launcher/uninstall.go` (spawn detached cleanup
  helper to remove .app post-exit)
- `apps/studio-installer/src-tauri/src/commands/extract.rs`
  (split-destination iteration; admin-elevation copy for .app)
- `apps/studio-installer/src-tauri/src/commands/install_dir.rs`
  (return tuple: app dir + binaries dir)

### Spotlight + LSUIElement de-risk

Before merging the .app branch, build a stub LSUIElement=1 .app on a
test macOS box and verify `mdfind -name "Friday"` finds it. If
Sonoma+ Spotlight skips LSUIElement apps, drop LSUIElement and
accept the Dock icon — that's a 5-minute test that prevents a
"surprise it doesn't work" debug session post-ship.

---

## Issue 6: Quit doesn't actually stop services (and `--uninstall` doesn't either)

### Two failing code paths share one root cause

**Tray Quit path** (`tools/friday-launcher/main.go:269`):
```
tray "Quit" click
  → systray.Quit()
    → onExit() (macOS only, on NSApp event loop)
      → performShutdown("systray:onExit")
        → supervisor.Shutdown() (process-compose ShutDownProject)
          → SIGTERM each supervised process, 10s grace, then SIGKILL
        → releasePidLock()
        → closeJob() (no-op on macOS)
```

**`--uninstall` path** (`tools/friday-launcher/uninstall.go`):
```
runUninstall()
  → if launcher pid alive: SIGTERM + wait 35s for exit
  → disableAutostart()
  → remove state.json + pids/
  → exit
```

The `--uninstall` path NEVER sweeps supervised binaries. Confirmed
on 2026-04-27: with the launcher already dead but its children
(`pty-server`, `webhook-tunnel`, `playground`) still running,
`--uninstall` reports `✓ launcher already stopped` and exits
successfully, leaving the orphans alive. User had to `kill -9` each
of them manually.

### Why it fails in practice (most likely)

1. **One or more supervised processes ignore SIGTERM.** Specifically
   suspect the Deno binaries (friday, link, playground) — Deno
   `process.on("SIGTERM")` handlers may not be wired into the runtime
   entry point.
2. **process-compose doesn't kill grand-children.** If friday daemon
   spawns child workers, those become orphans of init when the
   parent dies, and process-compose has no record of them.
3. **onExit doesn't fire on Cmd+Q.** If the user closes the launcher
   via Cmd+Q on the menubar app rather than the Quit menu item,
   NSApp may terminate without invoking systray's onExit.
4. **`--uninstall` doesn't run a path-based sweep.** When the
   launcher is already dead (crashed, `kill -9`, or just-quit
   without graceful shutdown), its children are orphans that
   uninstall has no record of. The current code only signals the
   launcher's pid and trusts that to cascade — but a dead launcher
   has nothing to cascade.

### Fix plan

1. **Confirmation modal on Quit click.** Before tearing anything
   down, show a small native dialog (cgo to NSAlert on macOS,
   windows-sys MessageBoxW on Windows). Two buttons: **Quit**
   (default, runs shutdown) and **Cancel** (no-op). Title: "Quit
   Friday Studio?". Body: "Friday Studio will stop all running
   services and shut down. This may take up to 30 seconds." On
   confirm, swap menubar title to "Stopping…" and run shutdown.
2. **Shutdown trace logging.** Add a per-step log line: `quit
   clicked` → `confirmation accepted` → `systray.Quit returned` →
   `onExit entered` → `performShutdown invoked` → `ShutDownProject
   started` → `each process: status before/after SIGTERM` → final.
   When the user reports "quit didn't work", the log tells us
   exactly which step broke.
3. **Lean on `processkit.SweepByBinaryPath` after `ShutDownProject`.**
   No `Setpgid` plumbing — that path required either a
   process-compose fork or a setpgid-wrapper binary, and the actual
   correctness hammer is the path-based sweep we already wrote. After
   `supervisor.Shutdown()` returns (or its 30s deadline hits), call
   `processkit.SweepByBinaryPath(homeDir() + "/.friday/local")` —
   kills any lingering process whose executable path is under the
   install dir, regardless of process group state.
4. **Hook NSApp termination.** On macOS, register an
   NSApplicationWillTerminateNotification observer (cgo + small
   Objective-C shim) that calls `performShutdown("nsapp:
   willTerminate")`. Today only systray.Quit triggers onExit; Cmd+Q
   bypasses it. The confirmation modal does NOT show on this path
   — Cmd+Q is a power-user signal, honor it immediately.
5. **Replace installer's `terminate_studio_processes` with HTTP
   call.** With the new `POST /api/launcher-shutdown` endpoint, the
   installer's update-flow shutdown becomes a single HTTP call with
   a 35s timeout instead of SIGTERM + pid-poll. Cleaner semantics,
   shares the same teardown code path as tray-Quit.
6. **`--uninstall` runs `SweepByBinaryPath` unconditionally.**
   Today it only signals the launcher pid and trusts cascading
   shutdown. New flow:
   1. Try graceful shutdown via `POST /api/launcher-shutdown` (new
      HTTP endpoint). If it returns 200 within 35s, services are
      down via the supervised teardown path.
   2. If the HTTP call fails (launcher dead, endpoint not bound),
      fall back to the existing SIGTERM-launcher-pid-and-wait path.
   3. **Always** run `processkit.SweepByBinaryPath(binDir)` after
      step 1 or 2 — catches orphans whose parent (the launcher)
      was killed externally and never got a chance to clean up.
   4. **Then** disable autostart, remove state.json, remove pids/.
   The order matters: sweep BEFORE removing pids/ so a stale
   launcher.pid doesn't survive into the next install attempt.

### Files to change

- `tools/friday-launcher/tray.go` (Quit handler shows confirmation
  modal first; on confirm, set menubar title to "Stopping…", then
  call systray.Quit)
- `tools/friday-launcher/confirm_darwin.go` + `confirm_darwin.m`
  (NSAlert wrapper, cgo)
- `tools/friday-launcher/confirm_windows.go` (MessageBoxW wrapper,
  windows-sys)
- `tools/friday-launcher/main.go` (NSApp will-terminate hook;
  post-shutdown SweepByBinaryPath; shutdown-trace logging)
- `tools/friday-launcher/uninstall.go` (try HTTP shutdown first,
  fall back to SIGTERM, then unconditionally
  SweepByBinaryPath + emit a clear "killed N orphan processes"
  line per process)
- `tools/friday-launcher/healthsvc.go` (POST /api/launcher-shutdown
  handler — see cross-cutting work)
- `apps/studio-installer/src-tauri/src/commands/extract.rs`
  (replace terminate_studio_processes with HTTP POST to launcher's
  shutdown endpoint; keep SIGTERM fallback for the case where the
  HTTP server didn't bind)
- `tools/friday-launcher/integration_test.go` (extend `TestUninstall`
  to spawn a stub supervised process before invoking `--uninstall`,
  assert it's dead afterward — would have caught the 2026-04-27
  bug)

---

## Migration: v0.0.8 → v0.0.9 layout

**This is a hard correctness gap in v1 — must-do, not a choice.**

### What changes between versions

| Item                     | v0.0.8 (current)                          | v0.0.9 (target)                                   |
|--------------------------|-------------------------------------------|---------------------------------------------------|
| Launcher binary          | `~/.friday/local/friday-launcher`         | `/Applications/Friday Studio.app/Contents/MacOS/` |
| LaunchAgent target path  | `~/.friday/local/friday-launcher`         | `/Applications/Friday Studio.app/Contents/MacOS/` |
| Supervised binaries      | `~/.friday/local/{friday,link,…}`         | unchanged                                         |
| pid files                | `~/.friday/local/pids/launcher.pid`       | unchanged                                         |
| Friday Studio.app        | absent                                    | `/Applications/Friday Studio.app`                 |

### Migration logic in installer (extract.rs)

Before the new tarball is unpacked:

1. **Detect old layout.** `os.path.exists(~/.friday/local/friday-launcher)`
   AND `that file is a Mach-O executable`.
2. **Stop the old launcher.** Same as today — read launcher.pid,
   SIGTERM, wait. (After this PR, fall back to the SIGTERM path
   when the HTTP shutdown endpoint isn't bound — the old launcher
   doesn't have it.)
3. **Disable old autostart.** Run `launchctl unload ~/Library/
   LaunchAgents/ai.hellofriday.studio.plist` if present, then remove
   the plist file.
4. **Remove old launcher binary.** `rm
   ~/.friday/local/friday-launcher`. Clean up the cruft so a future
   sweep doesn't pick up a stale match.
5. **Extract new tarball.** `Friday Studio.app/` → `/Applications/`,
   binaries → `~/.friday/local/`.
6. **Re-register autostart.** New LaunchAgent points at
   `/Applications/Friday Studio.app/Contents/MacOS/friday-launcher`.
   Launcher's `--autostart enable` already does this; the new
   binary's path is correctly resolved by `os.Executable()`.
7. **First launch.** Spawn the new launcher (`open -a "Friday
   Studio"` instead of direct execution — uses LaunchServices, which
   is what Spotlight Enter does, so we exercise the same path).

### Where the migration code lives

`apps/studio-installer/src-tauri/src/commands/extract.rs`. The
existing `terminate_studio_processes` is the natural seam — extend
it to also disable autostart and remove the old binary on macOS.

### Test before shipping

Take a v0.0.8-installed machine (lcf has one), run the v0.1.16
installer through Update mode end-to-end, verify:
- LaunchAgent plist points at the new path
- `~/.friday/local/friday-launcher` is gone
- `/Applications/Friday Studio.app` is present
- `mdfind -name "Friday"` returns the .app
- Quit + relaunch via Spotlight works
- Reboot: autostart fires the .app launcher, not the old binary

---

## Build + ship sequence

The fixes span both binaries and the build pipeline:

1. **Cross-cutting: launcher's HTTP health server (Cross-cutting
   section above).** Lives entirely in the launcher; ships in the
   v0.0.9 platform tarball. Trigger `studio-build.yml` after
   committing.
2. **Installer-only fixes (Issues 1, 2, 3, plus migration logic):**
   trigger `studio-installer-build.yml` — produces v0.1.16
   installer .zip. Note: the installer fixes consume the launcher's
   new HTTP endpoint, so they require the v0.0.9 platform tarball
   to exist first.
3. **Launcher fixes (Issues 4, 5, 6):** trigger
   `studio-build.yml` — same v0.0.9 build that contains the HTTP
   server; .app bundling happens here too.
4. **Test order:** ship v0.0.9 platform first, then ship v0.1.16
   installer. Install fresh v0.1.16 → it pulls v0.0.9 manifest →
   migration logic moves old install to new layout → unpacks .app
   to /Applications + binaries to ~/.friday/local → launcher
   exposes /api/launcher-health → wizard's wait step subscribes →
   tray bucket reads health-cache → Spotlight finds the .app → Quit
   tears it all down.

## Risks

- **Spotlight + LSUIElement interaction**: `LSUIElement=1` .app is
  invisible from the Dock but still indexed by Spotlight on
  Sonoma+. **Verify on test machine before shipping** (5 min: build
  a stub .app, check `mdfind`).
- **codesign --deep + notarization**: bundle-level signing is
  different from single-binary signing. The studio-build.yml
  workflow needs a non-trivial update (entitlements file, hardened
  runtime, deep signing of nested binaries inside the .app). Risk
  of "works locally, fails in CI" is moderate.
- **HTTP port 5199 collision**: hardcoded port for the launcher's
  health server. Document the port in CLAUDE.md so it doesn't
  silently get reused. If something else is already on 5199,
  launcher startup fails with a clear error and we move it.
- **HTTP server listens on 127.0.0.1 only**: not exposed to the
  network. No auth needed (loopback-only). Don't accept POST
  /api/launcher-shutdown from anywhere else, ever.
- **Migration is one-shot**: if it fails halfway (e.g. autostart
  unload succeeds but binary remove fails), the user could end up
  with no autostart AND no working launcher. Wrap migration in the
  existing rollback-on-error pattern from extract.rs (rename
  install dir to .bak first, revert if extract fails).
- **EventSource SSE on Tauri WebView**: macOS's WKWebView
  EventSource implementation is solid; verify on Windows
  (WebView2) before shipping. If WebView2 chokes, fall back to
  polling `/api/launcher-health` every 500ms — same UX, slightly
  more network chatter.

## Decisions (confirmed 2026-04-27, v2 pass)

1. **Per-service progress** during launch — wizard shows a 6-row
   live checklist driven by SSE from launcher.
2. **Quit confirmation modal** — native dialog before shutdown,
   "Stopping…" in menubar title while teardown runs.
3. **Bundle id** — `ai.hellofriday.studio-launcher`.
4. **Launcher exposes `/api/launcher-health` (HTTP + SSE)** —
   single source of truth for service status; consumed by tray
   bucket logic, wizard wait step, and update-flow shutdown.
5. **Drop `Setpgid`; rely on `processkit.SweepByBinaryPath`
   alone** — process-compose doesn't expose Setpgid cleanly and
   the path-based sweep already exists.
6. **Extract progress: running count, no total** — switch
   `extract_archive` to manual `archive.entries()` iteration; show
   `Unpacking… 1247 files` (no percent). Skipped the build-time
   sidecar — counting via second pass would cost ~3-5s; running
   count is enough UX.
7. **`/Applications` only, prompt for admin if needed** — no
   `~/Applications` fallback. Standard macOS app location;
   Spotlight indexes reliably.
8. **v0.0.8 → v0.0.9 migration is mandatory** — explicit
   detect-old-layout / disable-old-autostart / remove-old-binary /
   extract-new-layout / re-register-autostart sequence in
   extract.rs.
9. **`--uninstall` always runs `SweepByBinaryPath`** —
   confirmed-broken on 2026-04-27: when the launcher had already
   been killed externally, its supervised children survived
   `--uninstall` and had to be `kill -9`'d manually. New flow:
   try HTTP `/api/launcher-shutdown`, fall back to SIGTERM,
   **then unconditionally** sweep the install dir for orphans
   before removing pids/. Integration test extended to assert
   no supervised binary survives `--uninstall`.
