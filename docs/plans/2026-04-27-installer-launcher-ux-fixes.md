# Installer + Launcher UX Fixes

**Date:** 2026-04-27
**Branch:** declaw (per Atlas rule)
**Status:** Plan — implementation pending

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

## Goals

- Wizard's "Launch" step honestly reflects whether services are usable.
- The wizard exits after handing the user off to the browser — its job
  is done.
- Every wizard step has visible state (no silent "100% then nothing").
- Tray status is **always visible** (not behind a chevron) and tells the
  truth (green when healthy, not stuck on "Starting…").
- Friday Studio launches from Spotlight like any other Mac app.
- Quit means quit — services down, ports free.

## Non-goals

- Re-architecting the launcher (still process-compose under the hood).
- Per-service progress in the wizard (one aggregate "all healthy" check
  is enough for v1; per-service granularity can wait).
- Adding a tray UI for service-by-service status (status text in the
  menubar title is the contract).

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
extract (with progress)
   ↓
verify (with "Verifying SHA-256…" indicator)
   ↓
launch (spawn launcher) — already exists
   ↓
wait-healthy: poll http://localhost:5200/api/health every 500ms
              up to 60s, with a counter so the wizard can show
              "Starting Friday Studio… 14s" instead of a hung spinner
   ↓
done: enable "Open in Browser" button
   ↓
on click: openUrl(...) → exit installer
```

### Implementation notes

- **New Tauri command `wait_for_services(timeout_secs, on_progress)`** in
  `apps/studio-installer/src-tauri/src/commands/wait_health.rs`.
  Polls each of the 6 service endpoints (per
  `tools/friday-launcher/project.go`) at 500ms cadence and emits
  per-service status events via a Channel:
  ```rust
  enum HealthEvent {
    ServiceUpdate {
      name: String,         // "nats" | "friday" | "link" | ...
      status: ServiceStatus // Pending | Starting | Healthy | Failed
    },
    Done,                    // all healthy
    Timeout { stuck: Vec<String> },  // services not green at deadline
  }
  ```
  Endpoints to probe (must stay in sync with project.go ProcessConfigs):
  - `nats-server` → `http://127.0.0.1:8222/healthz`
  - `friday` → `http://127.0.0.1:8080/health`
  - `link` → `http://127.0.0.1:3100/health`
  - `pty-server` → `http://127.0.0.1:7681/health`
  - `webhook-tunnel` → `http://127.0.0.1:9090/health`
  - `playground` → `http://127.0.0.1:5200/api/health`
- **Launch.svelte** renders a 6-row checklist: each row shows the
  service name + a status pill (`spinner`, `✓`, or `✗`). Rows go
  green as their probe returns 200; the "Open in Browser" button is
  disabled until all rows are green. On timeout, failed rows turn red
  and a "View logs" button replaces the spinner.
- **Update `Launch.svelte`** to call `runLaunch` then `waitForHealth`
  before flipping `launched = true`. Show:
  - First 30s: "Starting Friday Studio…" + indeterminate spinner
  - 30s+: same text + "(this is taking longer than usual — checking
    services)" so the user doesn't think it's frozen
  - Timeout: explicit error "Studio failed to start" with `View logs`
    button
- **Exit on Open in Browser click**: add `await getCurrentWindow().close()`
  (Tauri 2 API) immediately after the `openUrl` call. The launcher is
  already detached (setsid on Unix, DETACHED_PROCESS on Windows), so
  killing the wizard window doesn't kill the platform.
- **Extract progress**: `extract_archive` Tauri command currently runs
  synchronously and returns Ok/Err. Surface progress events the same
  way `download_file` does:
  - Add a `Channel<ExtractEvent>` parameter
  - During tar iteration, emit `Progress { entries_done, entries_total }`
    every ~200ms
  - `Extract.svelte` shows "Unpacking… 1247 / 8932 files" instead of
    a blank pause
- **Verify progress**: SHA-256 over 540 MB takes ~1.5s on M-series.
  No need for byte-level progress — just flip the subtitle to
  "Verifying download integrity…" *before* the verify call (today
  the flip happens after, so the user sees nothing). One-line fix
  in `Download.svelte`.

### Files to change

- `apps/studio-installer/src-tauri/src/commands/wait_health.rs` (new —
  `wait_for_services` command)
- `apps/studio-installer/src-tauri/src/commands/mod.rs` (register)
- `apps/studio-installer/src-tauri/src/lib.rs` (invoke_handler)
- `apps/studio-installer/src-tauri/src/commands/extract.rs` (Channel
  parameter + per-entry progress)
- `apps/studio-installer/src/lib/installer.ts` (`waitForServices`,
  `runExtract` with channel; expose per-service status via store)
- `apps/studio-installer/src/lib/store.svelte.ts` (new fields:
  `services: Record<string, ServiceStatus>`, `extractEntriesDone`,
  `extractEntriesTotal`)
- `apps/studio-installer/src/steps/Launch.svelte` (per-service
  checklist, exit-on-click)
- `apps/studio-installer/src/steps/Extract.svelte` (entries-done UI)
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
- v3 (this commit, not yet shipped): status moved to **menubar title
  text**. Verified compiles, not yet on the user's machine because
  v0.0.8 platform tarball was built from a commit that didn't have
  the title-text move yet.

### Why "Status: Starting…" sticks even when services are up

Two suspects in `tray.go`:

```go
func (t *trayController) computeBucket() trayBucket {
    ...
    state, err := t.sup.State()
    if err != nil || state == nil {
        return bucketAmber
    }
    if state.IsReady() && len(state.States) > 0 {
        return bucketGreen
    }
    ...
}
```

- `state.IsReady()` is process-compose's heuristic: every supervised
  process is in `Running` state AND every ReadinessProbe has fired
  green. If even one process never reports ready (e.g. a probe
  endpoint changed), bucket stays amber forever.
- The 30s cold-start grace bypasses red/error states but doesn't
  affect green-ness.

Likely root causes:
1. One of the readiness probes targets a port/path that doesn't match
   the actual service health endpoint.
2. process-compose's `IsReady()` requires `len(States) > 0` AND every
   state's `IsReady` true; we return green only on that path. If even
   one process has `IsReady == nil`, this returns false.

### Fix plan

1. **Land the title-text fix in the next platform build (v0.0.9).**
   The launcher binary lives in the *platform* tarball, not the
   installer. Trigger studio-build CI on declaw after committing
   anything else under tools/friday-launcher.
2. **Diagnose the stuck-amber.** Add a `--dump-state` flag (or just
   surface to logs every 10s) that prints each supervised process's
   `Status` + `IsReady` + `LivenessProbe.Health`. Shipping this once
   reveals which probe is failing on the user's machine.
3. **Tighten the readiness probes.** Each ProcessConfig in
   `tools/friday-launcher/project.go` declares an HTTP `ReadinessProbe`;
   confirm the port/path matches what the binary actually serves.
   Particular suspects:
   - `friday`: `/health` on 8080 — confirmed by integration test
   - `playground`: `/api/health` on 5200 — confirmed
   - `webhook-tunnel`: `/health` on 9090 — confirmed
   - `link`: `/health` on 3100 — needs verification (link service may
     not have a `/health` endpoint, in which case the probe is failing)
   - `pty-server`: `/health` on 7681 — needs verification
   - `nats-server`: `/healthz` on 8222 — confirmed via `--http_port`
4. **Fall back to "process running" heuristic.** If a probe is
   inherently unreliable, change the bucket logic to return green
   when **all processes are `Running`** (regardless of probe state).
   The probe was an enhancement, not a hard contract.

### Files to change

- `tools/friday-launcher/tray.go` (already moved status to title in
  commit 22301429b1; needs a new platform build to ship)
- `tools/friday-launcher/project.go` (verify probe ports/paths match
  reality; possibly relax bucket logic)
- `tools/friday-launcher/main.go` (add periodic state dump to log)

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
     `ai.hellofriday.studio-launcher`, CFBundleIconFile, LSUIElement=1 for
     menubar-only apps so it doesn't show in the Dock)
   - `Contents/Resources/AppIcon.icns` (Friday logo, sourced from
     `apps/studio-installer/src-tauri/icons/`)
2. **Tarball both the .app and the supervised binaries.** The .app
   bundle contains `friday-launcher`; the other binaries
   (friday, link, nats-server, pty-server, webhook-tunnel,
   cloudflared, playground) stay flat at the root of the install dir.
   The launcher's binDir resolution (`os.Executable()` parent dir)
   needs adjustment: when the launcher runs from
   `Friday Studio.app/Contents/MacOS/`, supervised binaries are NOT
   siblings — they're at the install dir parent. Update
   `tools/friday-launcher/main.go` `binDir` default to handle the
   .app-on-macOS case.
3. **Installer extract step copies .app to Applications.** Today
   extract.rs unpacks tarball into `~/.friday/local/`. macOS Spotlight
   will index any `.app` under `~/Applications/` or `/Applications/`.
   Add a step: after extract, `cp -R "Friday Studio.app"
   /Applications/Friday Studio.app` (or `~/Applications` if
   `/Applications` isn't writable). Supervised binaries still live in
   `~/.friday/local/`; the .app's launcher is the entry point that
   discovers them.
4. **Update extract.rs and uninstall flow.** `extract_archive` knows
   only how to unpack to a single dest. Either:
   - Split into two extract calls (one for .app to Applications, one
     for binaries to `~/.friday/local`), or
   - Tarball already has the right layout and extract handles it
     transparently.
   Uninstall (`--uninstall` flag) needs to also `rm -rf
   /Applications/Friday\ Studio.app`.

### Files to change

- `scripts/build-studio.ts` (macOS .app bundling)
- `tools/friday-launcher/main.go` (binDir default for .app context)
- `apps/studio-installer/src-tauri/src/commands/extract.rs`
  (post-extract .app copy to Applications)
- `tools/friday-launcher/main.go` `--uninstall` (remove .app too)

### Open question

Should the launcher's .app open the browser when double-clicked from
Spotlight (today's behavior would be: spawn another launcher, hit
single-instance lock, send wake-up signal to the existing instance
which calls openBrowser)? **Yes** — this is the correct user
expectation. The existing single-instance + SIGUSR1 wake-up path
already implements it; just need to verify it works when the binary
is invoked as a .app.

---

## Issue 6: Quit doesn't actually stop services

### Current shutdown path (per `tools/friday-launcher/main.go:269`)

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

### Why it fails in practice

Most likely causes (need to confirm with logs):

1. **One or more supervised processes ignore SIGTERM.** Specifically
   suspect the Deno binaries (friday, link, playground) which embed
   the daemon — Deno `process.on("SIGTERM")` handlers may not be
   wired into the runtime entry point, so the signal hits but the
   process doesn't gracefully shut down. After 10s grace,
   process-compose escalates to SIGKILL — except SIGKILL is only sent
   to the process-compose process group, not necessarily to the
   grand-child process tree the Deno binary spawned.
2. **process-compose doesn't kill grand-children.** If friday daemon
   spawns child workers, those become orphans of init when the parent
   dies, and process-compose has no record of them. We'd need
   process-group-based killing (setpgid in spawn, kill -SIGTERM
   -<pgid>) to take down the tree.
3. **onExit doesn't fire.** If the user closes the launcher via Cmd+Q
   on the menubar app rather than the Quit menu item, NSApp may
   terminate without invoking systray's onExit. The signal handler
   path is the safety net but only fires on SIGTERM/SIGINT, not the
   NSApp Cmd+Q path.

### Fix plan

1. **Confirmation modal on Quit click.** Before tearing anything
   down, show a small native dialog (via Tauri's
   `tauri-plugin-dialog` or, since the launcher isn't Tauri, a cgo
   call to `NSAlert` on macOS / `MessageBoxW` on Windows). Two
   buttons: **Quit** (default, runs shutdown) and **Cancel** (no-op).
   Title: "Quit Friday Studio?". Body: "Friday Studio will stop all
   running services and shut down. This may take up to 30 seconds."
   Once the user confirms, swap the menubar title to "Stopping…"
   and run shutdown. The modal serves two purposes: (a) prevents
   accidental Quit from killing in-flight work, (b) gives the user
   a "this is going to take a moment" expectation.
2. **Confirm via instrumentation.** Add a "shutdown trace" log block
   that prints, line-by-line: `quit clicked` → `confirmation
   accepted` → `systray.Quit returned` → `onExit entered` →
   `performShutdown invoked` → `ShutDownProject started` → `each
   process: status before/after SIGTERM` → final. Reading the log
   after the user reports the bug tells us exactly where the chain
   breaks.
3. **Process groups on Unix.** In `tools/friday-launcher/project.go`
   when constructing each `ProcessConfig`, set `Setpgid: true` (via
   process-compose's `Command.Setpgid` if exposed, otherwise via a
   wrapper). On shutdown, send SIGTERM to the process group (`kill
   -SIGTERM -<pgid>`) so grand-children die.
4. **Backup sweep on shutdown.** After `ShutDownProject` returns,
   call `processkit.SweepByBinaryPath(binDir)` to kill any remaining
   processes whose executable path is under our install dir. This is
   the "we tried everything else, now just kill anything that looks
   like ours" hammer.
5. **Hook NSApp termination.** On macOS, register an
   NSApplicationWillTerminateNotification observer (via cgo or a
   small Objective-C shim) that calls `performShutdown("nsapp:
   willTerminate")`. Today only systray.Quit triggers onExit; Cmd+Q
   on the menubar bypasses it. The confirmation modal does NOT show
   on this path — Cmd+Q is a power-user signal and we honor it
   immediately.

### Files to change

- `tools/friday-launcher/tray.go` (Quit handler shows confirmation
  modal first; on confirm, set menubar title to "Stopping…", then
  call systray.Quit)
- `tools/friday-launcher/confirm_darwin.m` + `confirm_darwin.go`
  (NSAlert wrapper, cgo)
- `tools/friday-launcher/confirm_windows.go` (MessageBoxW wrapper,
  windows-sys)
- `tools/friday-launcher/project.go` (Setpgid on each ProcessConfig)
- `tools/friday-launcher/supervisor.go` (process-group SIGTERM in
  Shutdown())
- `tools/friday-launcher/main.go` (NSApp will-terminate hook;
  post-shutdown SweepByBinaryPath; shutdown-trace logging)

---

## Build + ship sequence

The fixes span both binaries:

1. **Installer-only fixes (Issues 1, 2, 3):** trigger
   `studio-installer-build.yml` after merging — produces v0.1.16
   installer .zip via existing CI.
2. **Launcher-only fixes (Issues 4, 5, 6):** trigger
   `studio-build.yml` after merging — produces v0.0.9 platform
   tarball with the new `Friday Studio.app` bundle.
3. **Test order:** install fresh v0.1.16 installer → it pulls v0.0.9
   manifest → unpacks .app to Applications + binaries to
   ~/.friday/local → launcher with title-text status, NSApp shutdown
   hook, process-group teardown.

## Risks

- **Spotlight + LSUIElement interaction**: an `LSUIElement=1` .app
  is invisible from the Dock but still indexed by Spotlight. If
  Spotlight skips LSUIElement apps on macOS Sonoma+, drop
  LSUIElement and accept a Dock icon. Verify on test machine before
  shipping.
- **Process-group on macOS**: macOS launchd may already place
  detached processes in their own session group; `Setpgid` plus our
  signal-to-pgid logic must agree with launchd's group, not fight it.
  Test on a macOS box with autostart enabled before shipping.
- **The .app + binaries split** changes the install dir layout; the
  launcher's `--uninstall` flag, `binDir` default, and the
  installer's extract step all need to agree. A schema mismatch will
  surface as "binary not found" errors at first launch.

## Decisions (confirmed 2026-04-27)

1. **Per-service progress** during launch — wizard shows a 6-row
   checklist with each service's status pill.
2. **Quit confirmation modal** — native dialog before shutdown,
   "Stopping…" in menubar title while teardown runs.
3. **Bundle id** — `ai.hellofriday.studio-launcher`.
