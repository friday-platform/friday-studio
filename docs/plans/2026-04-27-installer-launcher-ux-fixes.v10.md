<!-- v10 - 2026-04-27 - Generated via /improving-plans from 2026-04-27-installer-launcher-ux-fixes.v9.md -->

# Installer + Launcher UX Fixes (v10)

**Date:** 2026-04-27
**Branch:** declaw (per Atlas rule)
**Status:** Plan — implementation-ready
**Supersedes:** v9 (`2026-04-27-installer-launcher-ux-fixes.v9.md`)

> **What v10 changes from v9 (real design changes, not polish):**
> Four gap-fixes for failure modes the v9 design left exposed:
> 1. **Pre-extract cleanup of stale `.new` staging dirs** —
>    v9's staging-then-swap covers Rust error paths but not
>    crash/power-loss mid-extract. Defensively `rm -rf` any
>    leftover `bin.new/` and `Friday Studio.app.new` before
>    starting extraction. Makes migration fully crash-recoverable.
> 2. **`open -a` second-launch arg delivery is autostart-only.**
>    Documented limitation: `open -a "Friday Studio" --args
>    --no-browser` only delivers `--no-browser` when the .app
>    isn't already running. Fine for autostart (only call site);
>    flagged so future code doesn't try to pass meaningful args
>    via this channel post-launch.
> 3. **License URLs interpolate the existing version constants.**
>    v9 said "pin to same version tag as the binary" without
>    enforcement. v10 ties the LICENSE URL build to `GH_VERSION`,
>    `CLOUDFLARED_VERSION`, `NATS_SERVER_VERSION` directly so a
>    future bump can't update the binary URL while leaving the
>    license URL stale.
> 4. **Playground readiness probe targets `/`, not a sidecar
>    `/health`.** v9's "all healthy" contract said the wizard
>    enables Open-in-Browser when the readiness probe is green.
>    Probe path must match what the browser actually loads —
>    otherwise we re-introduce the v0.1.15 connection-refused
>    bug at a smaller scale.
>
> All v9 design decisions roll forward unchanged: LICENSE from
> pinned GitHub raw URLs (#27), port-5199 dialog (#28),
> autostart via `open -a` (#29), staging-then-swap migration
> (#30), 20s SSE-connect deadline (#19).

## TLDR

Six user-visible problems, fixed by code changes in two binaries
(launcher + installer) and one build-pipeline tweak. Plan
contents in one screenful:

1. **Wizard truthfully waits for services.** New launcher HTTP
   endpoint `/api/launcher-health` (GET + SSE + POST shutdown);
   wizard subscribes, renders a 6-row checklist with staged
   60s/90s/+60s deadline; "Open in Browser" enabled only when
   playground is healthy. Wizard exits on Open click. SSE
   connect retry has a 20s budget for slow first-launches.
2. **Tray status moves to menubar title text** (already
   committed in `22301429b1`); bucket logic reads the new
   health-cache so green/amber/red is honest.
3. **Friday Studio.app for Spotlight + clean bin/ layout.**
   macOS tarball ships `Friday Studio.app` (bundle id
   `ai.hellofriday.studio-launcher`) that lands in
   `/Applications`. Supervised binaries land in
   `~/.friday/local/bin/` alongside their LICENSE files
   (Apache 2.0 / MIT for third-party, BSL 1.1 for ours; sourced
   from pinned GitHub raw URLs, not upstream archives).
   Quarantine xattr stripped post-extract for silent
   first-launch. Pre-flight check via osascript dialog if
   supervised binaries are missing OR port 5199 is in use.
4. **Quit and `--uninstall` actually stop services.**
   Confirmation modal on Quit; both paths run
   `processkit.SweepByBinaryPath` after graceful shutdown to
   catch orphans whose parent died externally. NSApp will-
   terminate hook handles Cmd+Q.
5. **`v0.0.8 → v0.0.9` migration runs in `extract.rs`**: detect
   old flat layout, stop old launcher (HTTP shutdown w/ SIGTERM
   fallback), unload old autostart, extract new layout to
   `bin.new/` staging dir, swap atomically, remove old binaries,
   strip quarantine, re-register autostart targeting
   `open -a "Friday Studio"`, then `open -a "Friday Studio"`.
6. **Build pipeline.** `studio-build.yml` emits a clean v0.0.9
   tarball (.app + bin/ layout, no cutover-compat duplicate);
   `studio-installer-build.yml` emits v0.1.16 with the wizard
   rewrite + migration. v0.1.16 must ship before users update
   to v0.0.9 platform; today's fleet is ~1 user (lcf) so this
   is trivial.

32 numbered decisions (§Decisions); 14 risk callouts (§Risks);
9 verification items to check on test hardware during
implementation.

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
- Broken / partial installs surface as a clear "reinstall required"
  dialog, not silent restart-loop hell.
- First-run UX is silent — no Gatekeeper / "downloaded from the
  internet" prompts on the user's first `open -a "Friday Studio"`.

## Non-goals

- Re-architecting the launcher (still process-compose under the hood).
- Adding a tray UI for service-by-service status (status text in the
  menubar title is the contract; per-service status is exposed via HTTP
  for tools that want it).
- Per-file percent during tarball extract (running count is enough).
- Renaming the LaunchAgent label. The .app bundle id
  (`ai.hellofriday.studio-launcher`) and the LaunchAgent label
  (`ai.hellofriday.studio`) describe different things — app identity
  vs autostart entry. Keeping the existing label costs nothing and
  avoids a migration step on the upgrade path.

---

## Cross-cutting: launcher's `/api/launcher-health` endpoint

The launcher today has no HTTP surface; the tray reads
`supervisor.State()` in-process and the installer's wizard has no way
to ask the launcher anything except "did the pid file appear". v5
adds a small HTTP listener inside the launcher that becomes the
**single source of truth** for service health.

### Endpoint surface

```
GET  http://127.0.0.1:5199/api/launcher-health
GET  http://127.0.0.1:5199/api/launcher-health/stream    (SSE)
POST http://127.0.0.1:5199/api/launcher-shutdown         (202 + async)
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
  "all_healthy": false,
  "shutting_down": false
}
```

`uptime_secs` is measured from `supervisor.startedAt`, NOT from
process launch — the lock-handshake / single-instance phase doesn't
count. `since_secs` resets on every state transition into the
current state.

After shutdown begins, the same endpoint returns `503 Service
Unavailable` with `shutting_down: true` until the HTTP server itself
closes. Polling clients use this transition as a signal that
shutdown is in progress.

`GET /api/launcher-health/stream` is the same payload as
`text/event-stream` — emits an event whenever any service's status
changes, plus a final `{"shutting_down": true}` event before the
server closes. Used by the installer wizard to render a live
checklist without polling. Supports **N concurrent subscribers** via
fan-out — wizard, tooling, and any future integrators can connect
in parallel.

`POST /api/launcher-shutdown` is the **async** orderly-shutdown
trigger. The handler:

1. Sets `shuttingDown` atomic to true (so subsequent GETs return 503).
2. Spawns a goroutine that runs `performShutdown("http:shutdown")`.
3. Returns `202 Accepted` with `Location: /api/launcher-health` and
   body `{"status": "shutdown initiated"}`.

This avoids the self-deadlock that would happen if the handler
synchronously called `srv.Shutdown(ctx)` from inside its own
in-flight request — `http.Server.Shutdown` waits for active handlers
to finish, and the handler is waiting for Shutdown.

The caller (installer's update flow, future tools) polls the GET
endpoint or watches `launcher.pid` to detect completion. 35-second
client-side timeout matches the launcher's own 30s
`ShutDownProject` deadline + 5s of jitter.

### Service status state machine

A service's `status` field follows this state machine (computed
inside the 500ms-poll goroutine from `supervisor.State()`):

```
            ┌──────────┐
            │ pending  │ (initial — before supervisor spawn)
            └────┬─────┘
                 │ process spawned by supervisor
                 ▼
            ┌──────────┐         ┌──────────┐
            │ starting │ ───────▶│ healthy  │
            └────┬─────┘ probe   └────┬─────┘
                 │ green               │ probe red OR
                 │                     │ process restarted
                 │ MaxRestarts          │ (under MaxRestarts)
                 │ exceeded            │
                 ▼                     ▼
            ┌──────────┐         (back to starting)
            │ failed   │
            └──────────┘
```

- `pending` → `starting`: process-compose's startOrder spawns the
  process; supervisor.State() shows it as Running.
- `starting` → `healthy`: readiness probe (HTTP 200 against
  `127.0.0.1:<port><path>`) succeeds. `since_secs` resets. The
  probe `<path>` MUST be the same surface a user-side consumer
  would load — for playground, `/` (the root, what the browser
  hits when it lands), not a sidecar `/health` (Decision #32).
  This is what makes "all healthy" actually mean "all usable".
- `healthy` → `starting`: process crashes and is being restarted by
  process-compose (RestartPolicyAlways, under MaxRestarts=5).
  `since_secs` resets so the wizard sees a transient amber pip
  rather than instant red.
- `*` → `failed`: process-compose hits MaxRestarts. Terminal
  state from the launcher's view; user must `Restart all` from
  tray to attempt recovery (which transitions back to `pending`).
- `all_healthy` is `true` iff every service is `healthy`. Failed
  rows after the wizard's deadline drop the wizard into the
  partial-success path (see Issue 1).

Implementation polls `supervisor.State()` every 500ms internally to
update the in-memory cache; HTTP handlers serve from cache (read
under RWMutex). SSE handler subscribes to a fan-out channel
populated on state-change.

**Concurrency model:** `HealthCache` uses `sync.RWMutex` — single
writer (the 500ms-poll goroutine), many readers (HTTP handlers,
tray bucket logic). The poll goroutine acquires write lock, reads
`supervisor.State()`, updates the cache, releases. Handlers
acquire read lock, copy a snapshot, release, marshal JSON outside
the lock. SSE fan-out: each connected subscriber gets its own
`chan struct{}` registered on a `[]chan struct{}` under a
sub-mutex; the writer iterates and sends with non-blocking
`select { case ch <- struct{}{}: default: }` so a slow subscriber
doesn't block the writer or other subscribers.

**HTTP server lifecycle (NOT supervised):** The HTTP server is a
goroutine inside the launcher process, not a supervised process.
It is spun up once in `onReady` after `supervisor` is created and
torn down once in `performShutdown` (LAST step, after sweep). The
tray's `Restart all` action calls `supervisor.RestartAll()` which
bounces the supervised processes — the HTTP server keeps running
throughout, so SSE subscribers see each service transition
`healthy → starting → healthy` during a restart-all.

**Bind-failure handling (NEW in v9):** if `srv.ListenAndServe()`
returns an error indicating port 5199 is in use (`syscall.EADDRINUSE`
on Unix, `WSAEADDRINUSE` on Windows), the launcher cannot expose
its health surface. Without it the tray bucket logic, wizard wait
step, and update-flow shutdown all break silently. v9 surfaces this
as an osascript dialog (same mechanism as pre-flight for missing
binaries — see Issue 5 step 7) saying:

> Friday Studio cannot start.
>
> Port 5199 is already in use by another application.
>
> Run `lsof -iTCP:5199` in Terminal to see what is using it.

…and exits 1. The bind step happens BEFORE `systray.Run`, so
osascript (its own NSApp) is the right tool — same constraint as
pre-flight for missing binaries. Buttons: "Quit" only. Pre-flight
and bind-failure share the dialog helper code path; the only
difference is the message body.

### Implementation

```go
// tools/friday-launcher/healthsvc.go (new)
type HealthCache struct {
    mu        sync.RWMutex
    services  []ServiceStatus
    startedAt time.Time
    shuttingDown atomic.Bool

    subsMu    sync.Mutex
    subs      []chan struct{} // SSE fan-out
}

func startHealthServer(sup *Supervisor, cache *HealthCache) (*http.Server, error) {
    r := chi.NewRouter()
    r.Get("/api/launcher-health", handleHealth(cache))
    r.Get("/api/launcher-health/stream", handleHealthStream(cache))
    r.Post("/api/launcher-shutdown", handleShutdown(cache))
    srv := &http.Server{Addr: "127.0.0.1:5199", Handler: r}
    // Listen synchronously so bind failures surface to caller
    // BEFORE we register handlers / show tray / etc.
    ln, err := net.Listen("tcp", srv.Addr)
    if err != nil {
        return nil, fmt.Errorf("bind 5199: %w", err)
    }
    go srv.Serve(ln)
    return srv, nil
}

func handleShutdown(cache *HealthCache) http.HandlerFunc {
    return func(w http.ResponseWriter, r *http.Request) {
        // First call wins; second caller gets 409 Conflict.
        if !cache.shuttingDown.CompareAndSwap(false, true) {
            http.Error(w, "shutdown already in progress", http.StatusConflict)
            return
        }
        w.Header().Set("Location", "/api/launcher-health")
        w.WriteHeader(http.StatusAccepted)
        _, _ = w.Write([]byte(`{"status":"shutdown initiated"}`))
        go performShutdown("http:shutdown")
    }
}
```

### Why this earns its keep

- **Tray bucket logic** today reads `supervisor.State().IsReady()`,
  which is process-compose's heuristic. With our own per-service
  tracking, the bucket logic moves to: read `services` array,
  return green iff all `healthy`. Removes the stuck-amber bug.
- **Wizard's Launch step** subscribes to the SSE endpoint and
  renders a 6-row checklist that updates live as services come up.
  No polling loop in Rust.
- **Installer extract step** uses `POST /api/launcher-shutdown`
  instead of `terminate_studio_processes`'s SIGTERM-and-poll dance.
  Cleaner shutdown semantics; same fall-through-and-extract-anyway
  safety net.
- **Single source of truth**: adding a new supervised service means
  adding one entry to `project.go`'s `supervisedProcesses` and
  nothing else. Tray, wizard, and shutdown all pick it up.

**Files:**
- `tools/friday-launcher/healthsvc.go` (new — chi router, handlers,
  RWMutex cache, SSE channel fan-out, state machine, bind error
  surfaced from `startHealthServer`)
- `tools/friday-launcher/main.go` (call `startHealthServer` after
  supervisor created; on bind error, dispatch to the same
  osascript dialog used by pre-flight; close it last in
  performShutdown after Shutdown completes)
- `tools/friday-launcher/tray.go` (bucket logic reads health-cache
  instead of `supervisor.State().IsReady()`)
- `tools/friday-launcher/preflight_dialog_darwin.go` (extended —
  also handles port-in-use error variant)

### Risk: HTTP server shutdown ordering

`performShutdown` must close the HTTP server **last**, AFTER
`supervisor.Shutdown()` has returned (or its 30s deadline hit) AND
after `SweepByBinaryPath`. Otherwise mid-shutdown the
`/api/launcher-health` endpoint disappears and clients (the wizard
during update flow) lose visibility into the teardown progress.

Order in `performShutdown`:
1. Set `shuttingDown` atomic (cache returns 503 from this point on,
   tray title flips to "Stopping…")
2. `supervisor.Shutdown()` (waits up to 30s)
3. `processkit.SweepByBinaryPath(binDir)` (catch orphans)
4. Close HTTP server with `srv.Shutdown(ctx)` and 2s timeout
5. `releasePidLock()` + `closeJob()`

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
              SSE; render a 6-row checklist updating live; staged
              deadline (60s normal feedback, 90s hard fail with
              optional 60s extension)
   ↓
done: enable "Open in Browser" button when every row is green
   ↓
on click: openUrl(...) → getCurrentWindow().close() → installer
          process exits
```

### Wait-healthy timeline

The wizard's wait step uses a staged deadline so users on fast
disks see snappy feedback while users on HDDs / corporate-managed
Macs (antivirus scanning every binary) get extra time:

| Elapsed | UI state |
|---------|----------|
| 0–60s   | "Starting Friday Studio…" + 6-row checklist; all rows updating live as services come up |
| 60s     | Subtitle flips to "This is taking longer than usual — services are still booting" + "Wait 60s more" button appears alongside still-running checklist |
| 60–90s  | Same UI; if user clicks "Wait 60s more", deadline extends to 150s |
| 90s (or 150s if extended) | Hard fail. Failed rows turn red. Buttons:<br/>• **View logs** (always shown)<br/>• **Open anyway** (shown ONLY if playground service is healthy)<br/>• **Wait again** (shown only if user previously clicked Wait 60s more — re-arms the extension once more) |

**Partial-success rule:** When the deadline hits with at least
`playground` (port 5200) healthy, render an "Open anyway" button
alongside "View logs". `playground` is the user-facing surface
that the browser actually loads; if it's green, the user can
make forward progress even if an auxiliary service like
`webhook-tunnel` is stuck. The unhealthy services stay visible
in the tray afterwards, so the user can investigate later. If
playground is NOT healthy, "Open anyway" is hidden — opening the
browser would hit a connection-refused page, which is exactly
the v3-and-prior bug we're fixing.

### SSE early-connect race

The wizard's `wait_for_services` call comes immediately after
`runLaunch` spawns the launcher. There is a millisecond-scale
window where the wizard's Tauri command tries to connect to
`http://127.0.0.1:5199/api/launcher-health/stream` before the
launcher's HTTP server has bound the port (the launcher is
still in its single-instance lock + sweep + supervisor-init
phase).

The race is wider on the migration upgrade path: extract.rs
spawns the new launcher via `open -a "Friday Studio"`, which
goes through LaunchServices. Cold-cache LaunchServices spin-up
+ Mach-O load + supervisor init can brush 6-8s on slow disks
before the launcher even reaches `startHealthServer`. v9 sizes
the SSE-connect retry budget for that worst case.

**SSE relay handles this with capped exponential backoff:**

```rust
// wait_health.rs, conceptually
let mut delay_ms = 200;
let backoff_deadline = Instant::now() + Duration::from_secs(20);
loop {
    match connect_sse("http://127.0.0.1:5199/api/launcher-health/stream").await {
        Ok(stream) => break stream,
        Err(_) if Instant::now() < backoff_deadline => {
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            delay_ms = (delay_ms * 2).min(2000); // 200, 400, 800, 1600, 2000…
        }
        Err(e) => return Err(format!("launcher unreachable: {e}")),
    }
}
```

Common case: launcher binds within ~200-500ms of spawn, first
retry succeeds. After 20s of failed retries, surface
`HealthEvent::Unreachable` to the wizard so it can show "could
not connect to launcher" with a "View logs" button. 20s is
generous — sized for the slow-Mac LaunchServices path; a
launcher that hasn't bound port 5199 in 20s is broken in a way
that's not a race. (v8 used 10s; bumped because slow first-launch
on cold-cache Macs after the v0.0.8 → v0.0.9 migration can brush
6-8s before bind, putting the 10s budget within striking distance
of false-negative `Unreachable` events.)

The 20s SSE-connect deadline is independent of the wait-healthy
60s/90s/+60s deadline (which starts only AFTER SSE connects), so
this change adds zero common-case latency.

### Implementation notes

- **`wait_for_services` Tauri command** is a thin SSE-relay in
  `apps/studio-installer/src-tauri/src/commands/wait_health.rs`.
  Connects to `http://127.0.0.1:5199/api/launcher-health/stream`
  with the backoff loop above, forwards each event to a Tauri
  Channel as `HealthEvent`.
  - **No hardcoded service list in installer Rust.** That list
    lives in `project.go` only. The installer just renders
    whatever the launcher reports.
  - Two timeouts: 60s "soft" (UI swaps to long-wait copy + extend
    button), 90s "hard" (default end), extendable to 150s, then
    optionally to 210s via "Wait again". If the launcher hasn't
    reported all services healthy at the hard deadline, emit
    `HealthEvent::Timeout { stuck: [name], playground_healthy:
    bool }` so the wizard can decide whether to show "Open
    anyway".
- **Launch.svelte** renders one row per service from the
  `services` array in the latest health event. Each row: service
  name + a status pill (`spinner` if pending/starting, `✓` if
  healthy, `✗` if failed). The "Open in Browser" button is
  enabled only when every row is `healthy`. After the soft
  deadline (60s), append "Wait 60s more" button. After the hard
  deadline, append "View logs" + (conditionally) "Open anyway"
  + (conditionally) "Wait again".
- **Exit on Open in Browser click**: add `await
  getCurrentWindow().close()` (Tauri 2 API) immediately after the
  `openUrl` call. The launcher is already detached (setsid on Unix,
  DETACHED_PROCESS on Windows), so killing the wizard window doesn't
  kill the platform. Same close logic for "Open anyway".
- **Extract progress (running count, no total)**: switch
  `extract_archive` from `tar::Archive::unpack()` (single sync call,
  no hooks) to manual iteration via `archive.entries()`. For each
  entry: call `entry.unpack_in(dest)`, increment a counter, emit a
  `Progress { entries_done: N }` event every ~200ms via a Channel.
  Wizard shows `Unpacking… 1247 files`. Same Channel approach as
  `download_file`.
- **Verify progress**: SHA-256 over 540 MB takes ~1.5s on M-series.
  No need for byte-level progress — just flip the subtitle to
  "Verifying download integrity…" *before* the verify call (today
  the flip happens after, so the user sees nothing). One-line fix
  in `Download.svelte`.

### Files to change

- `apps/studio-installer/src-tauri/src/commands/wait_health.rs` (new —
  SSE relay; backoff loop with **20s** deadline; staged
  60s/90s/150s/+optional deadlines)
- `apps/studio-installer/src-tauri/src/commands/mod.rs` (register)
- `apps/studio-installer/src-tauri/src/lib.rs` (invoke_handler)
- `apps/studio-installer/src-tauri/src/commands/extract.rs` (Channel
  parameter; switch to manual `archive.entries()` iteration; the
  split-destination logic lives here too — see Issue 5)
- `apps/studio-installer/src-tauri/Cargo.toml` (add
  `eventsource-client` for SSE consumption)
- `apps/studio-installer/src/lib/installer.ts` (`waitForServices`,
  `runExtract` with channel; `extendWaitDeadline()` helper;
  expose per-service status via store)
- `apps/studio-installer/src/lib/store.svelte.ts` (new fields:
  `services: Array<{name, status, sinceSecs}>`,
  `extractEntriesDone`, `waitElapsedSecs`, `waitDeadlineExtended`)
- `apps/studio-installer/src/steps/Launch.svelte` (per-service
  checklist, staged deadline UI, partial-success Open-anyway button,
  Wait again link, exit-on-click)
- `apps/studio-installer/src/steps/Extract.svelte` (running-count UI)
- `apps/studio-installer/src/steps/Download.svelte` (subtitle flip
  order)

---

## Issue 4: Tray status — chevron + "Starting…" stuck

### Why the previous fixes failed

- v1 (status as menu item, `.Disable()` called): NSMenu treated the
  disabled-first-item as un-anchorable and pushed it above the
  menubar → scroll chevron clipped it.
- v2 (status as menu item, no `.Disable()`): chevron still appears
  in some screen-edge layouts. NSMenu's scroll-up indicator isn't
  reliable to predict, and we can't override it via
  `fyne.io/systray`.
- v3 of this fix (committed in `22301429b1`, not yet shipped):
  status moved to **menubar title text**. Verified compiles.

### Why "Status: Starting…" sticks even when services are up

The bucket logic was using process-compose's `state.IsReady()`,
which requires every process's readiness probe to fire green AND
every state's `IsReady` to be non-nil. When even one probe fails
(e.g. `link`'s `/health` doesn't exist on this binary version), the
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
`.app` bundle. Spotlight indexes `/Applications`, `~/Applications`,
and `~/Downloads` for `.app` bundles by default; flat binaries are
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

2. **Tarball layout (macOS) — clean .app + bin/ split.**
   ```
   tarball-root/
     Friday Studio.app/
       Contents/MacOS/friday-launcher
       Contents/Info.plist
       Contents/Resources/AppIcon.icns
     bin/
       friday
       link
       nats-server
       nats-server-license       ← Apache 2.0
       pty-server
       webhook-tunnel
       cloudflared
       cloudflared-license       ← Apache 2.0
       gh
       gh-license                ← MIT
       playground
       LICENSE                   ← BSL 1.1 (our own)
   ```
   No cutover-compat duplicate launcher at tarball root. v0.1.15
   installers in the wild (which today is just the lcf machine)
   would fail to install v0.0.9 — fine since v0.1.16 ships first
   anyway. v0.1.16 installers do split-destination extract:
   - `Friday Studio.app/` → `/Applications/Friday Studio.app`
   - `bin/` → `~/.friday/local/bin/`
   The migration step (extract.rs) cleans up any v0.0.8 cruft
   in `~/.friday/local/` (the old flat layout) before extracting
   the new tarball.

3. **Installer extract — split-destination logic with admin
   elevation.** Today `extract_archive` unpacks to a single dest
   (`~/.friday/local/`). The new layout requires:
   - `Friday Studio.app/` extracts to
     `/Applications/Friday Studio.app` (with admin-elevation
     prompt if needed; see step 4)
   - `bin/` extracts to `~/.friday/local/bin/` (preserves the
     LICENSE files alongside their binaries)

   Implementation: iterate the archive once, dispatch each entry
   by its top-level path component. Same `archive.entries()`
   iterator used for progress reporting. Two top-level entries
   only (.app + bin/), so dispatch is trivial.

   See §Migration for the staging-then-swap order that protects
   against partial-extract leaving an unbootable system.

4. **`/Applications` install with admin elevation.** Always target
   `/Applications/Friday Studio.app`. If the write fails with
   permission-denied, surface a Tauri dialog asking the user to
   authenticate; on confirm, retry the copy via
   `osascript -e 'do shell script "..." with administrator
   privileges'` (one prompt per install). On most modern macOS
   machines `/Applications` is user-writable and no prompt fires.
   - `~/Applications` is *not* a fallback — it doesn't exist by
     default and Spotlight indexing is best-effort there. We
     commit to one canonical location.

5. **Strip quarantine xattr post-extract for silent first-launch.**
   The .app extracted from the downloaded .zip carries
   `com.apple.quarantine` extended attributes. On first
   `open -a "Friday Studio"`, Gatekeeper would show "Friday Studio
   is from an identified developer—open?" or similar. We pre-empt
   the prompt by stripping the xattr.

   **Permission-mode dispatch:** the xattr operation needs the
   same privilege level as the cp into `/Applications`. Two
   cases:

   - **`/Applications` is user-writable** (the common case on
     non-managed Macs): cp succeeded as the current user. The
     resulting `.app` is owned by the user; `xattr -dr` from
     the same user works.
     ```rust
     Command::new("xattr")
         .args(["-dr", "com.apple.quarantine",
                "/Applications/Friday Studio.app"])
         .output()?;
     ```
   - **Admin elevation was required for cp**: the `.app` is now
     root-owned (osascript ran with admin privs). A subsequent
     non-elevated `xattr -dr` would fail with "Operation not
     permitted". The cp and xattr must therefore happen in the
     **same elevated osascript invocation** — one auth prompt,
     two commands:
     ```rust
     // Single elevated session:
     let script = format!(
         r#"do shell script "cp -R {src:?} {dst:?} && xattr -dr com.apple.quarantine {dst:?}" with administrator privileges"#,
         src=src_path, dst=dst_path);
     Command::new("osascript").args(["-e", &script]).output()?;
     ```

   The .app is signed + notarized in CI (studio-build.yml), so
   Gatekeeper has nothing to validate once the quarantine xattr
   is gone. Silent first launch. Same pattern Homebrew Cask uses
   for user-installed apps. Failure of the xattr command is
   non-fatal (logged); user gets a one-time Gatekeeper prompt at
   worst.

6. **Launcher's `binDir` resolution updated for `bin/` layout.**
   The launcher always resolves binDir to a directory containing
   the supervised binaries:
   - On macOS in the .app bundle: `~/.friday/local/bin/`
     (the .app's launcher and supervised binaries are different
     locations).
   - On Linux/Windows: `~/.friday/local/bin/` too — same layout
     across platforms, the .app wrapping is macOS-only.
   - Dev runs (running launcher directly via `go run`):
     `~/.friday/local/bin/` if it exists, otherwise the
     launcher's own dir (so `go run` against a stub-binary tree
     still works).

   ```go
   func defaultBinDir() string {
       // Production: supervised binaries always live in
       // ~/.friday/local/bin/ regardless of where the launcher
       // itself is (.app bundle on macOS, ~/.friday/local on
       // Linux/Windows in autostart layouts, etc.).
       prod := filepath.Join(homeDir(), ".friday", "local", "bin")
       if _, err := os.Stat(prod); err == nil {
           return prod
       }
       // Dev fallback: launcher's own dir, for `go run` against
       // stub binaries.
       exe, _ := os.Executable()
       return filepath.Dir(exe)
   }
   ```

   The `--bin-dir` CLI flag still wins over the default; tests
   override via env or flag.

7. **Pre-flight check via `osascript`: missing/corrupt binaries OR
   port 5199 in use → dialog → Quit.** At launcher startup, BEFORE
   `systray.Run`, two checks run in order:

   a. **Missing supervised binaries.** Verify each supervised
      binary exists at the expected path AND has the exec-bit set.
      If any are missing, render a native dialog listing them.

   b. **Port 5199 bind.** Attempt to bind `127.0.0.1:5199` for the
      health server (see cross-cutting §). If the bind fails with
      `EADDRINUSE`, render a native dialog explaining the port is
      in use and how to diagnose.

   Both dialogs use the same osascript helper:

   ```go
   func showStartupErrorDialog(title, body string, buttons []string) string {
       script := fmt.Sprintf(
           `display dialog %q with title %q buttons {%s} default button %q with icon caution`,
           body, title, formatButtons(buttons), buttons[len(buttons)-1])
       cmd := exec.Command("osascript", "-e", script)
       out, _ := cmd.CombinedOutput()
       return parseClickedButton(string(out))
   }

   // Missing-binaries variant:
   func showMissingBinariesDialog(missing []string) string {
       msg := fmt.Sprintf(
           "Friday Studio is not fully installed.\n\nThe following components are missing:\n  • %s\n\nPlease reinstall Friday Studio.",
           strings.Join(missing, "\n  • "))
       return showStartupErrorDialog("Friday Studio", msg,
           []string{"Quit", "Open download page"})
   }

   // Port-in-use variant (NEW in v9):
   func showPortInUseDialog() string {
       msg := "Friday Studio cannot start.\n\nPort 5199 is already in use by another application.\n\nRun `lsof -iTCP:5199` in Terminal to see what is using it."
       return showStartupErrorDialog("Friday Studio", msg,
           []string{"Quit"})
   }
   ```

   Why osascript (not cgo NSAlert) for startup errors: NSAlert.runModal
   requires a running NSApp, and NSApp comes up inside `systray.Run`.
   Pre-flight + bind check both run BEFORE that. osascript spawns
   AppleScript which has its own NSApp instance, no interaction with
   ours. The confirmation modal for Quit (Issue 6) fires AFTER
   systray.Run has NSApp up, so it can use cgo NSAlert for nicer
   styling — different code paths.

   On "Open download page" the launcher opens
   `https://download.fridayplatform.io` via `open <url>` and exits.
   On "Quit" the launcher just exits. Either way: no `systray.Run`,
   no broken-state tray.

   **Pre-flight only gates the normal-startup path.** CLI utility
   modes (`--autostart {enable,disable,status}`, `--uninstall`)
   exit before NewSupervisor and bypass pre-flight entirely —
   running pre-flight on those would pop a dialog when a user
   runs `--autostart status` on a broken install, or block
   `--uninstall` from cleaning up. The existing flag-parse
   in `main()` already routes to those subcommands BEFORE the
   pre-flight call site; just keep that ordering when wiring
   pre-flight in.

8. **`--uninstall` updated.** Remove
   `/Applications/Friday Studio.app` *after* the launcher process
   has exited — the running binary can't delete its own .app bundle
   on macOS without macOS killing the process mid-removal. Spawn a
   detached cleanup helper (`/bin/sh -c "while ProcessAlive; do
   sleep 0.2; done; rm -rf /Applications/Friday Studio.app"`) that
   waits for `launcher.pid` to disappear, then removes the .app.

### Files to change

- `scripts/build-studio.ts` — substantial rewrite:
  - macOS .app bundling: emit Info.plist + AppIcon.icns +
    .app/Contents/MacOS/friday-launcher
  - All-platforms: emit `bin/` subdir; supervised binaries
    (friday, link, nats-server, pty-server, webhook-tunnel,
    playground, cloudflared, gh) all land under `bin/`
  - License sourcing (NEW in v9): download each LICENSE file
    from a pinned GitHub raw URL once per build (not per
    target), reuse across all platforms. See Decision #27 for
    rationale + URL list. `bin/nats-server-license` (Apache
    2.0), `bin/cloudflared-license` (Apache 2.0), `bin/gh-license`
    (MIT). Copy repo-root `LICENSE` (BSL 1.1) to `bin/LICENSE`.
    Build asserts each LICENSE file exists post-download;
    otherwise fails loudly.
  - No cutover-compat duplicate launcher at tarball root
- `.github/workflows/studio-build.yml` (codesign at the bundle level
  with `codesign --deep`; notarize the bundle, not individual
  binaries; sign the duplicate launcher at root separately)
- `tools/friday-launcher/main.go` (binDir default for .app context;
  pre-flight check call AFTER CLI-mode routing, BEFORE systray.Run;
  bind check after pre-flight, before tray; both errors route to
  osascript dialog and exit 1)
- `tools/friday-launcher/preflight.go` (new — verify all supervised
  binaries exist + are executable; return list of missing names)
- `tools/friday-launcher/preflight_dialog_darwin.go` (new — osascript
  wrapper; helpers for missing-binaries dialog AND port-in-use
  dialog; returns "quit" / "open" / "" )
- `tools/friday-launcher/preflight_dialog_windows.go` (new —
  MessageBoxW for Windows parity; same two variants)
- `tools/friday-launcher/uninstall.go` (spawn detached cleanup
  helper to remove .app post-exit; HTTP-shutdown-with-fallback
  flow; unconditional `SweepByBinaryPath` — see Issue 6)
- `apps/studio-installer/src-tauri/src/commands/extract.rs`
  (split-destination iteration; admin-elevation copy for .app;
  skip root-level `friday-launcher` duplicate; quarantine xattr
  strip post-extract; `archive.entries()` iteration; staging
  dir + atomic swap per Decision #30)
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
   This dialog runs AFTER systray.Run is up, so cgo NSAlert is fine
   (different code path from the pre-flight osascript dialog).
2. **Shutdown trace logging.** Add a per-step log line: `quit
   clicked` → `confirmation accepted` → `systray.Quit returned` →
   `onExit entered` → `performShutdown invoked` → `ShutDownProject
   started` → `each process: status before/after SIGTERM` → final.
   When the user reports "quit didn't work", the log tells us
   exactly which step broke.
3. **Lean on `processkit.SweepByBinaryPath` after `ShutDownProject`.**
   No `Setpgid` plumbing — that path required either a
   process-compose fork or a setpgid-wrapper binary, and the actual
   correctness hammer is the path-based sweep we already wrote.
   After `supervisor.Shutdown()` returns (or its 30s deadline hits),
   call `processkit.SweepByBinaryPath(homeDir() + "/.friday/local/bin")`
   — kills any lingering process whose executable path is under the
   install dir, regardless of process group state.
4. **Hook NSApp termination — synchronous, accept hard-kill on
   system shutdown.** On macOS, register an
   `NSApplicationWillTerminateNotification` observer (cgo + small
   Objective-C shim) that calls `performShutdown("nsapp:
   willTerminate")` synchronously. Today only systray.Quit triggers
   onExit; Cmd+Q bypasses it. The confirmation modal does NOT show
   on this path — Cmd+Q is a power-user signal, honor it
   immediately.

   **Failure mode:** during macOS system shutdown, the OS may
   hard-kill the launcher before our 30s `supervisor.Shutdown()`
   completes. Orphans survive into the next boot. This is fine —
   the launcher's existing **startup-time** `SweepByBinaryPath`
   (already in `main.go:127-136`) reaps them on next launch. We
   pay one cycle of orphans-survive-reboot in the rare
   Cmd+Q-during-system-shutdown case; not worth engineering a
   detached cleanup helper for.

5. **Replace installer's `terminate_studio_processes` with HTTP
   call.** With the new `POST /api/launcher-shutdown` endpoint, the
   installer's update-flow shutdown becomes a single HTTP call with
   a 35s timeout instead of SIGTERM + pid-poll. Cleaner semantics;
   shares the same teardown code path as tray-Quit. Fall back to
   the existing SIGTERM path when the HTTP server didn't bind
   (older launcher versions on the upgrade path).

6. **`--uninstall` runs `SweepByBinaryPath` unconditionally.** New
   flow:
   1. Try graceful shutdown via `POST /api/launcher-shutdown` (new
      HTTP endpoint). Wait for 202 + then poll `launcher.pid` for
      removal up to 35s.
   2. If the HTTP call fails (launcher dead or endpoint not bound
      on older versions), fall back to the existing SIGTERM-and-poll
      path.
   3. **Always** run `processkit.SweepByBinaryPath(binDir)` after
      step 1 or 2 — catches orphans whose parent (the launcher) was
      killed externally and never got a chance to clean up. Print
      `✓ swept N orphan processes` in the user-facing output if
      N > 0.
   4. **Then** disable autostart, remove state.json, remove pids/.
   The order matters: sweep BEFORE removing pids/ so a stale
   launcher.pid doesn't survive into the next install attempt.

### Files to change

- `tools/friday-launcher/tray.go` (Quit handler shows confirmation
  modal first; on confirm, set menubar title to "Stopping…", then
  call systray.Quit)
- `tools/friday-launcher/confirm_darwin.go` + `confirm_darwin.m`
  (NSAlert wrapper, cgo — runs AFTER systray.Run is up; no
  conflict with pre-flight's osascript path)
- `tools/friday-launcher/confirm_windows.go` (MessageBoxW wrapper,
  windows-sys)
- `tools/friday-launcher/main.go` (NSApp will-terminate hook;
  post-shutdown SweepByBinaryPath; HTTP-server-shutdown ordering;
  shutdown-trace logging)
- `tools/friday-launcher/uninstall.go` (try HTTP shutdown first,
  fall back to SIGTERM, then unconditionally
  SweepByBinaryPath + emit `✓ swept N orphan processes` line)
- `tools/friday-launcher/healthsvc.go` (POST /api/launcher-shutdown
  handler returns 202 + async — see cross-cutting work)
- `apps/studio-installer/src-tauri/src/commands/extract.rs`
  (replace terminate_studio_processes with HTTP POST to launcher's
  shutdown endpoint; keep SIGTERM fallback for the case where the
  HTTP server didn't bind — i.e. older v0.0.8 launcher being
  replaced)
- `tools/friday-launcher/integration_test.go` (extend
  `TestUninstall` to spawn an actual stub *binary* — NOT a
  goroutine — before invoking `--uninstall`, assert it's dead
  afterward. `SweepByBinaryPath` scans the OS process table via
  `ps -eo pid=,comm=`; goroutines don't appear there. The test
  must therefore: copy a small stub binary into a test-temp
  `~/.friday/local/`-style dir, exec it as a child process,
  override `binDir` to point at the temp dir so the sweep
  finds it, run `--uninstall`, and assert
  `processkit.ProcessAlive(stubPid) == false` after. The
  existing goroutine-stub pattern from task #92 covers HTTP
  health-probe tests but is unsuitable for sweep tests. Would
  have caught the 2026-04-27 bug.)

---

## Migration: v0.0.8 → v0.0.9 layout

**This is a hard correctness gap in v1 — must-do, not a choice.**

### What changes between versions

| Item                     | v0.0.8 (current)                          | v0.0.9 (target)                                   |
|--------------------------|-------------------------------------------|---------------------------------------------------|
| Launcher binary          | `~/.friday/local/friday-launcher`         | `/Applications/Friday Studio.app/Contents/MacOS/` |
| LaunchAgent target       | `~/.friday/local/friday-launcher`         | `/usr/bin/open -a "Friday Studio" --args …`      |
| LaunchAgent label        | `ai.hellofriday.studio`                   | `ai.hellofriday.studio` (unchanged)               |
| .app bundle id           | (no .app)                                 | `ai.hellofriday.studio-launcher`                  |
| Supervised binaries      | `~/.friday/local/{friday,link,…}`         | `~/.friday/local/bin/{friday,link,…}`             |
| Third-party LICENSE files| absent                                    | `~/.friday/local/bin/{nats-server,cloudflared,gh}-license` |
| Our LICENSE              | absent                                    | `~/.friday/local/bin/LICENSE` (BSL 1.1)           |
| pid files                | `~/.friday/local/pids/launcher.pid`       | unchanged                                         |
| Friday Studio.app        | absent                                    | `/Applications/Friday Studio.app`                 |

### Migration logic in installer (extract.rs)

**Step ordering matters: we must NEVER leave a state where the
old binaries are gone but the new ones haven't been written yet.**
v9 introduced extract-to-staging + atomic-swap (Decision #30) for
that. v10 adds defensive pre-extract cleanup of any leftover
staging dirs (Decision #31) so a previous crash mid-extract
doesn't break the next run.

Sequence:

1. **Detect old layout.** `os.path.exists(~/.friday/local/friday-launcher)`
   AND that file is a Mach-O executable.
2. **Stop the old launcher.** Try `POST
   http://127.0.0.1:5199/api/launcher-shutdown` first; fall back to
   SIGTERM-and-poll. (After this PR, prefer the HTTP path; the
   fallback exists because we're running against a v0.0.8
   launcher that doesn't have the endpoint.)
3. **Disable old autostart.** The LaunchAgent label
   (`ai.hellofriday.studio`) is unchanged across versions. Just run
   `launchctl unload ~/Library/LaunchAgents/ai.hellofriday.studio.plist`
   so the old plist (pointing at the old path) is unloaded; the
   plist file itself will be overwritten in step 9 with the new
   `open -a` invocation. **Ignore non-zero exit** from `launchctl
   unload` — it returns 1 if the plist isn't loaded, which is the
   expected state on fresh installs and on machines where the
   user manually unloaded it.
4. **Pre-extract cleanup of stale staging dirs (NEW in v10).**
   Before writing anything new, defensively remove any leftover
   `.new` directories from a prior crashed run:
   ```rust
   let _ = fs::remove_dir_all("/Applications/Friday Studio.app.new");
   let _ = fs::remove_dir_all(home.join(".friday/local/bin.new"));
   ```
   Errors are ignored — if the dir doesn't exist (the common case)
   `remove_dir_all` returns NotFound, which is fine. If it exists
   but is partially-written, removing it is the only safe thing
   to do anyway. This makes step 5 idempotent under any prior
   failure mode (Rust error, OS kill, power loss).
5. **Extract new tarball with split-destination INTO STAGING.**
   - `Friday Studio.app/` → `/Applications/Friday Studio.app.new`
     (admin-elevated cp+xattr if needed; see Issue 5 step 5)
   - `bin/` → `~/.friday/local/bin.new/` (binaries + LICENSE
     files)
   If extraction fails partway: remove the half-written
   `.new` dirs (mirroring step 4's defensive cleanup so the
   user can re-run the installer without the cruft surviving
   into the next attempt), surface the error to the wizard,
   and exit. The user's existing v0.0.8 install is **untouched**
   — they can keep using it while debugging the failed install.
6. **Atomic swap.** Once extraction completes successfully:
   - `mv /Applications/Friday Studio.app /Applications/Friday Studio.app.bak`
     (or just remove if no v0.0.7 .app exists)
   - `mv /Applications/Friday Studio.app.new /Applications/Friday Studio.app`
   - `mv ~/.friday/local/bin.new ~/.friday/local/bin`
   The `mv` operations are atomic on the same filesystem
   (renames are O(1) and crash-safe). After this point the new
   layout is live.
7. **Clean up old flat-layout binaries** from the v0.0.8 paths.
   Now safe because the new layout is already live in step 6:
   - `rm ~/.friday/local/friday-launcher`
   - `rm ~/.friday/local/{friday,link,nats-server,pty-server,webhook-tunnel,cloudflared,gh,playground}`
   - `rm -rf /Applications/Friday Studio.app.bak` (if created)
   Preserve `~/.friday/local/{pids,logs,state.json,.env}` —
   those stay. If any of these `rm`s fail (e.g. permission
   error), log and continue: the old paths are unused now, and
   leaving them around for one boot won't break anything.
   Future `SweepByBinaryPath(~/.friday/local/bin)` only scans
   the new path so stale matches under the wrong dir aren't a
   sweep risk.
8. **Strip quarantine xattr from `/Applications/Friday Studio.app`.**
   Pre-empts Gatekeeper's "downloaded from the internet" prompt
   on first launch; .app is signed + notarized so this is safe.
   (When the cp in step 5 went through admin-elevated osascript,
   xattr was already chained into that same call — see Issue 5
   step 5. This step is a no-op in that case.)
9. **Re-register autostart via `open -a`.** New LaunchAgent's
   `ProgramArguments` is `["/usr/bin/open", "-a", "Friday Studio",
   "--args", "--no-browser"]` — goes through LaunchServices so
   Info.plist (LSUIElement, env, icon) is consulted on every boot
   (see Decision #29 for why this is preferred over a direct
   `Contents/MacOS/friday-launcher` path).
10. **First launch.** Spawn the new launcher via `open -a "Friday
    Studio"` instead of direct execution — uses LaunchServices,
    which is what Spotlight Enter does, so we exercise the same
    path. With quarantine stripped, this is silent. Bonus:
    registers the .app with LaunchServices so Spotlight indexes it
    immediately rather than waiting for the periodic mds re-scan.

### Where the migration code lives

`apps/studio-installer/src-tauri/src/commands/extract.rs`. The
existing `terminate_studio_processes` is the natural seam — extend
it to also disable autostart and remove the old binary on macOS.
The staging-then-swap helpers live alongside.

### Test before shipping

Take a v0.0.8-installed machine (lcf has one), run the v0.1.16
installer through Update mode end-to-end, verify:
- LaunchAgent plist `ProgramArguments` is `/usr/bin/open -a "Friday Studio" --args --no-browser`
- `~/.friday/local/friday-launcher` is gone
- `~/.friday/local/Friday Studio.app/` is gone (if it existed)
- `/Applications/Friday Studio.app` is present, no `.new`/`.bak` siblings
- `~/.friday/local/bin/` is present, no `bin.new` sibling
- `xattr /Applications/Friday\ Studio.app` shows no
  `com.apple.quarantine`
- `mdfind -name "Friday"` returns the .app
- First `open -a "Friday Studio"` is silent (no Gatekeeper
  prompt)
- Quit + relaunch via Spotlight works
- Reboot: autostart fires the .app launcher via `open -a`, not
  the old binary
- All supervised processes are alive after first launch
- **Negative test (graceful failure):** force the extract to fail
  (e.g. `chmod -w /Applications` mid-extract); verify the user's
  v0.0.8 install is untouched (binaries still present, autostart
  still works after `launchctl load`); verify no `.new` cruft left
  behind; re-running the installer succeeds without manual
  cleanup.
- **Negative test (crash recovery):** kill the installer process
  (`kill -9`) mid-extract while `bin.new/` is half-written;
  re-run the installer and verify step 4 cleans the orphaned
  `bin.new/` before re-extracting. End state matches a clean
  install. This exercises Decision #31's pre-extract cleanup.

---

## CLAUDE.md additions

The plan introduces several global facts that future maintainers
and coding agents need to discover quickly. Add to `CLAUDE.md`
under a new **Friday Studio platform layout** section (or extend
the existing "Architecture Gotchas" section):

- **Port 5199** — launcher's HTTP health server. `GET
  /api/launcher-health[/stream]` and `POST
  /api/launcher-shutdown`. Loopback only. Bind failure on this
  port surfaces as an osascript dialog and exits the launcher.
- **.app bundle id** `ai.hellofriday.studio-launcher` for code
  signing the launcher. Distinct from LaunchAgent label
  `ai.hellofriday.studio` (different system, different namespace).
- **LaunchAgent target**: `/usr/bin/open -a "Friday Studio" --args
  --no-browser` (NOT a direct `Contents/MacOS/friday-launcher`
  path) so autostart runs through LaunchServices and respects
  Info.plist on every boot. **Limitation:** `--args` only
  delivers when the .app isn't already running; against a live
  launcher the args are dropped silently. Don't try to pass
  meaningful runtime args to a running launcher via `open -a`
  — route through HTTP on port 5199 instead.
- **Wait-healthy deadline** — wizard waits 60s soft / 90s hard /
  +60s extendable for all 6 services to report healthy. friday
  daemon's first-launch can be 15-30s, plus 5 other services on
  slow disks brushes 60s; the staged deadline accommodates the
  long tail. SSE-connect retry has a 20s budget independent of
  the wait deadline (sized for slow first-launch on cold-cache
  Macs after migration).
- **macOS install paths**: `Friday Studio.app` is in
  `/Applications`; supervised binaries (with their LICENSE
  files) are in `~/.friday/local/bin/`; pids are
  `~/.friday/local/pids/`; logs are `~/.friday/local/logs/`;
  state is `~/.friday/local/state.json`; env is
  `~/.friday/local/.env`.
- **Bundled LICENSEs**: `bin/{nats-server,cloudflared,gh}-license`
  cover Apache 2.0 / MIT third-party binaries; `bin/LICENSE` is
  our own BSL 1.1. License files are downloaded from pinned
  GitHub raw URLs at build time, not extracted from upstream
  release archives (so cloudflared on Windows — a bare .exe —
  also gets one).
- **Service readiness probes target user-facing paths**: a
  service is reported `healthy` once its readiness probe returns
  200. The probe path is the same path a user-side consumer
  loads (e.g. `/` for playground, not a sidecar `/health`) so
  "all healthy" actually means "all usable". Future supervised
  services should follow this pattern in `project.go`.
- **Migration v0.0.8 → v0.0.9 layout** — installer detects the
  old flat layout (`~/.friday/local/friday-launcher`) and migrates
  to .app + binaries split. Uses extract-to-staging + atomic
  swap, with pre-extract cleanup of stale staging dirs so a
  prior crash mid-extract doesn't break the next run. Failed
  extract leaves the v0.0.8 install intact. See
  `docs/plans/2026-04-27-installer-launcher-ux-fixes.v10.md`
  § Migration.

---

## Build + ship sequence

The fixes span both binaries and the build pipeline:

1. **Cross-cutting: launcher's HTTP health server.** Lives entirely
   in the launcher; ships in the v0.0.9 platform tarball. Trigger
   `studio-build.yml` after committing.
2. **Order matters: v0.1.16 installer ships first.** v0.0.9
   tarball uses the new bin/ layout that v0.1.15 installers
   can't extract correctly. So we ship v0.1.16 first (it can
   extract either layout — bin/-aware), then publish v0.0.9
   manifest. Today's fleet is ~1 user (lcf), so the ordering
   risk is trivial. Once v0.0.9 is the default manifest,
   v0.1.15 installers can no longer install — by design.
3. **Installer-only fixes (Issues 1, 2, 3, plus migration logic):**
   trigger `studio-installer-build.yml` — produces v0.1.16
   installer .zip. Note: the installer fixes consume the
   launcher's new HTTP endpoint with a SIGTERM fallback, so they
   work against **both** v0.0.8 (no endpoint) and v0.0.9 (endpoint
   present) platforms.
4. **Launcher fixes (Issues 4, 5, 6):** trigger
   `studio-build.yml` — same v0.0.9 build that contains the HTTP
   server; .app bundling happens here too.
5. **Test order:** ship v0.1.16 installer first; manually
   install it once on the test machine (replacing the v0.1.15
   .app); then publish v0.0.9 platform manifest. Install fresh
   v0.1.16 → it pulls v0.0.9 manifest → migration logic stops
   v0.0.8 launcher → extracts to staging dirs → swaps atomically
   → cleans up v0.0.8 flat layout → strips quarantine xattr →
   re-registers autostart via `open -a` → launcher exposes
   /api/launcher-health → wizard's wait step subscribes with
   capped-backoff retry (20s budget) + staged 60s/90s/+60s
   deadline → tray bucket reads health-cache → Spotlight finds
   the .app → silent first `open -a` → Quit tears it all down,
   `--uninstall` sweeps every orphan in ~/.friday/local/bin.

## Risks

- **Spotlight + LSUIElement interaction**: `LSUIElement=1` .app is
  invisible from the Dock but still indexed by Spotlight on
  Sonoma+. **Verify on test machine before shipping** (5 min:
  build a stub .app, check `mdfind`).
- **codesign --deep + notarization**: bundle-level signing is
  different from single-binary signing. The studio-build.yml
  workflow needs a non-trivial update (entitlements file, hardened
  runtime, deep signing of nested binaries inside the .app).
  Risk of "works locally, fails in CI" is moderate.
- **HTTP port 5199 collision**: hardcoded port for the launcher's
  health server. Documented in CLAUDE.md so it doesn't silently
  get reused. If something else is already on 5199, launcher
  startup shows an osascript dialog ("Port 5199 in use, run
  `lsof -iTCP:5199`") and exits 1. Same dialog mechanism as
  pre-flight for missing binaries (Decision #28).
- **HTTP server listens on 127.0.0.1 only**: not exposed to the
  network. No auth needed (loopback-only). Don't accept
  POST `/api/launcher-shutdown` from anywhere else, ever.
- **HTTP shutdown self-deadlock**: addressed by handler returning
  202 immediately + async goroutine. The HTTP server is closed
  LAST in `performShutdown` (after sweep + supervisor shutdown)
  with a 2s `srv.Shutdown(ctx)` timeout to allow in-flight
  responses to drain.
- **SSE early-connect race**: addressed by capped-backoff retry
  in `wait_health.rs` (200ms, 400ms, 800ms… max 2s, total **20s**
  before failing). v9 doubled the budget from v8's 10s to cover
  cold-cache LaunchServices spin-up after migration. Fast
  machines see one retry at most; slow spawn paths still
  succeed.
- **Migration is one-shot but extract is recoverable**: v9's
  staging-then-atomic-swap pattern (Decision #30) plus v10's
  pre-extract cleanup (Decision #31) means any failure leaves
  the user in one of two well-defined states: "v0.0.8 layout
  intact" or "v0.0.9 layout live" — never a half-written hybrid.
  Even an OS crash or `kill -9` mid-extract is recoverable:
  the next installer run wipes any leftover `bin.new/` cruft
  before re-extracting. The remaining failure mode is step 9
  (re-register autostart): if the new plist write fails, the
  .app is in place but autostart is missing. Recovery: run the
  installer again or invoke `friday-launcher --autostart
  enable` manually.
- **EventSource SSE on Tauri WebView**: macOS's WKWebView
  EventSource implementation is solid; verify on Windows
  (WebView2) before shipping. If WebView2 chokes, fall back to
  polling `/api/launcher-health` every 500ms — same UX, slightly
  more network chatter.
- **Cmd+Q during macOS system shutdown**: macOS may hard-kill the
  launcher before teardown completes. Orphans survive until next
  launcher boot; the existing startup-time `SweepByBinaryPath`
  reaps them. Acceptable failure mode; not worth a detached
  cleanup helper.
- **Pre-flight false positives**: the missing-binaries check
  uses `os.Stat` + exec-bit check. If a user's filesystem returns
  a transient error (e.g. an unmounted volume), pre-flight could
  fire spuriously. Limit pre-flight to the `~/.friday/local/`
  path (we own it) and only alert when the file is **definitely
  missing** (`os.IsNotExist(err)`), not on other errors.
- **osascript availability on stripped-down macOS images**:
  osascript ships in macOS by default in /usr/bin/osascript and
  is part of the base install. On corporate-managed Macs,
  AppleScript may be disabled by MDM policy — pre-flight + bind
  dialog both fall back to logging the error + exiting if
  `osascript` returns non-zero. Worst case: silent exit on
  broken install / port collision. Documented.
- **Wizard's 90s deadline + extension button**: a user on an
  *extremely* slow disk could need >150s. After the extension
  expires, "Open anyway" requires playground to be healthy. If
  playground itself is the slow service, "Wait again" link
  re-arms the extension once more (total 210s). UX rarely-used
  safety net.
- **Quarantine xattr strip failure**: if `xattr -dr` fails (rare;
  filesystem permissions or SIP edge case), the user gets the
  one-time Gatekeeper "downloaded from the internet" prompt on
  first launch. Non-fatal; subsequent launches are silent
  regardless.
- **LICENSE file fetch failure at build time**: `scripts/build-studio.ts`
  downloads each LICENSE from a pinned GitHub raw URL once per
  build. If the URL 404s (repo renamed, branch deleted, sha bumped
  past the pin), the build fails loudly rather than skipping the
  file. Mitigated by pinning to a specific commit SHA (not branch)
  per Decision #27, and by the `bin/LICENSE-CHECKLIST.md` build
  artifact that lists each license + its source URL for human
  audit before release.
- **`open -a` autostart vs direct exec**: routing autostart through
  LaunchServices means launchd's child is `open`, not the launcher
  itself. The launcher detaches anyway (setsid on Unix), so
  process-tree semantics are unchanged. But if `open -a` itself
  fails (LaunchServices DB corruption, rare) the launcher never
  starts and there's no error to a user-facing UI. Mitigated:
  pre-flight runs at every launch, so a broken autostart manifests
  as "tray never appears at login"; user re-runs installer to
  re-register. Acceptable.
- **`open -a` second-launch arg drop**: per Decision #29, `open
  -a "Friday Studio" --args …` only delivers args on a fresh
  launch. Args sent to an already-running .app are silently
  dropped. Today this only matters for autostart (one call site,
  fresh launch by definition), but future code that tries to
  pass meaningful args via this channel will hit the bug. Marked
  in CLAUDE.md as a foot-gun; routing future-runtime args
  through the HTTP server on port 5199 is the supported path.
- **Readiness probe cost vs accuracy** (NEW in v10, Decision
  #32): probing `/` instead of a sidecar `/health` means each
  500ms poll renders the full landing page for playground.
  ~negligible CPU on dev machines, but not free. If profiling
  shows this dominating local CPU during long-running sessions,
  add a lightweight cache (e.g. probe `/` once-per-30s, treat
  intermediate `/health` results as "still healthy") rather
  than reverting to sidecar probes — the correctness property
  matters more than the polling cost.

## Recommended implementation order

The plan splits cleanly into 3 commit stacks on `declaw`. Order
optimizes for early validation of the highest-confidence fix:

### Stack 1: Launcher HTTP server + Issue 6 (smallest blast radius)

Cross-cutting `/api/launcher-health` endpoint plus the
Quit/uninstall sweep. Self-contained inside the launcher; ships
in v0.0.9 platform tarball. Lets the user re-test the
2026-04-27 `--uninstall`-leaves-orphans bug immediately.

Files: `tools/friday-launcher/healthsvc.go` (new),
`tools/friday-launcher/main.go` (HTTP server lifecycle, NSApp
will-terminate hook, post-shutdown sweep, shutdown trace,
bind-failure dialog),
`tools/friday-launcher/uninstall.go` (HTTP-then-SIGTERM
fallback, unconditional sweep), `tools/friday-launcher/tray.go`
(bucket logic reads health-cache, Quit confirmation modal),
`tools/friday-launcher/confirm_darwin.{go,m}` + windows
counterpart, `tools/friday-launcher/preflight_dialog_darwin.go`
(port-in-use variant; full pre-flight comes in Stack 3),
`tools/friday-launcher/integration_test.go`
(orphan-sweep test with real child process per Decision #24).

### Stack 2: Issues 1-3 (wizard UX, depends on Stack 1)

Wizard's Launch step rewrite. Consumes Stack 1's SSE endpoint
with capped-backoff retry (20s budget); staged 60s/90s/+60s
deadline; per-service checklist; exit-on-Open-click. Plus
extract running-count UI and the verify subtitle flip-order
fix.

Files: `apps/studio-installer/src-tauri/src/commands/wait_health.rs`
(new), `apps/studio-installer/src-tauri/src/commands/extract.rs`
(Channel + manual `archive.entries()` iteration — but split-dest
+ staging logic comes in Stack 3, keep this commit flat-extract
for now), `apps/studio-installer/src-tauri/Cargo.toml`
(`eventsource-client`),
`apps/studio-installer/src/lib/installer.ts`,
`apps/studio-installer/src/lib/store.svelte.ts`,
`apps/studio-installer/src/steps/{Launch,Extract,Download}.svelte`.

### Stack 3: Issue 5 (.app bundle + migration; biggest blast radius)

macOS-only `.app` bundling, /Applications install with admin
elevation, quarantine xattr strip, full pre-flight via osascript,
binDir resolution for .app context, v0.0.8 → v0.0.9 migration
with staging+swap, autostart via `open -a`, license downloads
from pinned URLs. Touches the build pipeline and extract.rs's
destination logic.

Files: `scripts/build-studio.ts` (.app staging; license URL
downloads; build-time LICENSE assertions),
`.github/workflows/studio-build.yml` (codesign --deep +
notarization), `tools/friday-launcher/main.go` (binDir + full
pre-flight call site), `tools/friday-launcher/preflight.go`
+ `preflight_dialog_{darwin,windows}.go` (extended for both
missing-binaries and port-in-use variants),
`tools/friday-launcher/autostart_darwin.go` (plist
ProgramArguments switched to `open -a`),
`tools/friday-launcher/uninstall.go` (.app cleanup helper),
`apps/studio-installer/src-tauri/src/commands/extract.rs`
(split-destination + admin-elevated cp+xattr per Decision #23 +
migration sequence with staging+swap per Decision #30),
`apps/studio-installer/src-tauri/src/commands/install_dir.rs`.

### Out-of-band

`CLAUDE.md` additions per Decision #22 land alongside Stack 1
since that's the first commit referencing the new port + HTTP
surface.

## Test matrix

Tests added or extended by stack:

| Stack | File | What it tests |
|-------|------|---------------|
| 1 | `tools/friday-launcher/healthsvc_test.go` (new) | `/api/launcher-health` JSON shape; SSE fan-out to N subscribers; state transitions (pending → starting → healthy → starting → failed); 503 + `shutting_down: true` after shutdown begins; `POST /api/launcher-shutdown` returns 202 + Location header; second POST returns 409. |
| 1 | `tools/friday-launcher/healthsvc_test.go` (new test) | `startHealthServer` returns the underlying bind error when 5199 is in use; main.go can intercept and dispatch to dialog. Test pre-binds 5199 with a `net.Listen` and asserts the second bind fails with a wrapped error. |
| 1 | `tools/friday-launcher/integration_test.go` `TestUninstall` (extend) | Spawn a real stub binary copied into a test-temp `~/.friday/local/`-style dir; exec it as a child process; override `binDir`; run `--uninstall`; assert `processkit.ProcessAlive(stubPid) == false`. (Per Decision #24 — goroutines are invisible to `ps`.) |
| 1 | `tools/friday-launcher/integration_test.go` (new test) | Quit confirmation modal cancel-path: simulate Cancel click, assert supervisor NOT shut down, services still alive. |
| 1 | `tools/friday-launcher/integration_test.go` (new test) | NSApp will-terminate hook: send `kill -TERM` to launcher (proxy for Cmd+Q since we can't simulate NSApp Cmd+Q in a test), assert orderly shutdown completes, sweep ran. macOS-only. |
| 2 | `apps/studio-installer/src-tauri/src/commands/wait_health.rs` (unit tests) | Backoff loop succeeds when launcher is unreachable for first 3 retries then becomes available; surfaces `Unreachable` after **20s** of failures. Mock SSE server. |
| 2 | `apps/studio-installer/src-tauri/src/commands/extract.rs` (extend) | Per-entry progress events emitted at ~200ms cadence; final event matches actual file count on disk. |
| 2 | Manual QA | Wizard render of staged deadline UI: 60s soft swap, 90s hard fail, "Wait 60s more" extends to 150s, "Wait again" extends to 210s, "Open anyway" appears iff playground is healthy. Run with `FRIDAY_PORT_friday=18080` etc to control which services come up. |
| 3 | `tools/friday-launcher/preflight_test.go` (new) | Detects missing supervised binaries; returns correct list of missing names; exec-bit check catches non-executable files; ignores transient stat errors (only `os.IsNotExist`). |
| 3 | `tools/friday-launcher/autostart_darwin_test.go` (new) | Plist written by `enableAutostart()` has `ProgramArguments` of length 4: `["/usr/bin/open", "-a", "Friday Studio", "--args", "--no-browser"]` with the .app name parameterized via const. Verify plist parses cleanly and `currentAutostartPath()` returns `/usr/bin/open` (not the launcher binary). |
| 3 | `apps/studio-installer/src-tauri/src/commands/extract.rs` (extend) | Split-destination iteration: `Friday Studio.app/` extracts to `/Applications` (or test-temp dir); root-level `friday-launcher` is skipped; all other entries land in `~/.friday/local/`. Test against a fixture tarball matching the Stack 3 layout. |
| 3 | `apps/studio-installer/src-tauri/src/commands/extract.rs` (extend) | Migration: pre-existing `~/.friday/local/friday-launcher` is removed; pre-existing `~/.friday/local/Friday Studio.app/` is removed; LaunchAgent plist is unloaded then overwritten to `open -a` invocation; `xattr` shows no `com.apple.quarantine` after extract (verify via `xattr -p`). |
| 3 | `apps/studio-installer/src-tauri/src/commands/extract.rs` (extend; NEW in v9) | Staging+swap recovery: simulate extract failure mid-write to `bin.new/`; assert no `bin.new` left on disk; assert old `bin/` (v0.0.8 binaries directly under `~/.friday/local/`) is untouched; assert `/Applications/Friday Studio.app` is unchanged. Re-run extract — succeeds and produces correct final layout. |
| 3 | `apps/studio-installer/src-tauri/src/commands/extract.rs` (extend; **NEW in v10**) | Pre-extract cleanup of stale staging dirs (Decision #31): seed `~/.friday/local/bin.new/` with a partial-content fixture that simulates a prior crashed run; invoke extract; assert the stale dir is removed at step 4 before the new extraction writes anything. End state matches a clean install with no stale files. |
| 3 | `scripts/build-studio.ts` (new test or build-time assertion; **tightened in v10**) | LICENSE files present at expected output paths after build; each file is non-empty; URLs interpolated from version constants — assert the URL strings literally contain `${NATS_SERVER_VERSION}`, `${CLOUDFLARED_VERSION}`, `${GH_VERSION}` substituted to the active values, so a future drift between binary version and license version is caught at test time. |
| 3 | `tools/friday-launcher/project_test.go` (new; **NEW in v10**) | Decision #32 — playground's readiness probe path is `/`, not `/health`. Assert `supervisedProcesses(...)` entry for playground has the expected probe path. Prevents future refactors from reverting to a sidecar that wouldn't catch the SvelteKit-not-yet-bound race. |
| 3 | Manual QA on a v0.0.8-installed machine | End-to-end migration per the §Test before shipping checklist (LaunchAgent path, Spotlight indexing, silent first launch, reboot autostart, **negative-path tests** for both graceful failure AND crash recovery). |

Tests skipped explicitly:
- Spotlight indexing of LSUIElement=1 .apps — manual verification
  per §Risks, can't be tested in CI.
- WebView2 EventSource compatibility — manual verification on a
  Windows test box; Windows CI runners don't render WebView2.
- Cmd+Q during macOS system shutdown — by design (rare path,
  startup sweep recovers; not worth a test harness).
- Live LaunchServices integration of `open -a` autostart — manual
  verification on test hardware (CI's macOS runners don't have
  user-session LaunchServices state).

## Decisions (confirmed 2026-04-27, v10 pass)

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
   `Unpacking… 1247 files` (no percent).
7. **`/Applications` only, prompt for admin if needed** — no
   `~/Applications` fallback. Standard macOS app location;
   Spotlight indexes reliably.
8. **v0.0.8 → v0.0.9 migration is mandatory** — explicit
   detect-old-layout / disable-old-autostart / extract-to-staging /
   atomic-swap / remove-old-binaries / re-register-autostart
   sequence in extract.rs.
9. **`--uninstall` always runs `SweepByBinaryPath`** — try HTTP
   `/api/launcher-shutdown`, fall back to SIGTERM, then
   unconditionally sweep before removing pids/. Integration test
   extended to assert no supervised binary survives `--uninstall`.
10. **POST /api/launcher-shutdown returns 202 immediately + async**
    — handler kicks off `performShutdown` in a fresh goroutine and
    returns `202 Accepted` with `Location: /api/launcher-health`.
11. **No cutover compat for v0.1.15** — fleet is ~1 user (lcf),
    so v0.0.9 tarball drops the duplicate launcher at tarball
    root. v0.1.16 installer ships first; v0.1.15 in the wild
    can't install v0.0.9 (their flat-extract would put binaries
    inside an unrelated bin/ subdir). Trade-off accepted; clean
    .app + bin/ tarball layout is worth it. (Was: "ship
    duplicate launcher for cutover" — superseded by v8.)
12. **Pre-flight check: missing binaries → osascript dialog +
    Quit** — pre-flight runs BEFORE `systray.Run` (NSApp not yet
    up), so it uses `osascript` (which has its own NSApp) instead
    of cgo NSAlert. Quit confirmation modal still uses cgo
    NSAlert because by then NSApp is up.
13. **Cmd+Q does full performShutdown synchronously** — accept
    hard-kill on the rare Cmd+Q-during-system-shutdown path;
    existing startup-time `SweepByBinaryPath` reaps any orphans
    on next launcher boot.
14. **LaunchAgent label keeps `ai.hellofriday.studio`** — distinct
    from the .app bundle id (`ai.hellofriday.studio-launcher`).
    Renaming would force a migration step for cosmetic clarity;
    keeping it is one less moving part. Note: only the **label**
    is unchanged; the `ProgramArguments` payload changes per
    Decision #29.
15. **Wait-healthy staged deadline: 60s soft / 90s hard /
    +60s extendable** (with optional second extension via "Wait
    again" link, total 210s).
16. **"Open anyway" only when playground is healthy** —
    playground (port 5200) is the user-facing surface; if it's
    green, the browser will work even if auxiliary services are
    stuck.
17. **Service status state machine documented** — `pending` →
    `starting` → `healthy` with restart-cycles bouncing back to
    `starting`, MaxRestarts terminal failure → `failed`.
    `since_secs` resets on every state transition.
18. **HTTP server lifecycle decoupled from `RestartAll`** — the
    launcher's HTTP server keeps running through `Restart all`
    and only closes once in `performShutdown` (LAST step).
19. **SSE relay uses capped exponential backoff for early-connect**
    — 200ms, 400ms, 800ms… max 2s; up to **20s** total before
    surfacing `Unreachable`. Common case: launcher binds within
    ~200-500ms of spawn, first retry succeeds. v9 doubled the
    deadline from v8's 10s after observing that cold-cache
    LaunchServices spin-up after migration can brush 6-8s before
    the launcher even reaches `startHealthServer`. The 20s
    budget is independent of the wait-healthy 60s deadline (which
    starts after SSE connects), so this adds zero common-case
    latency.
20. **Strip `com.apple.quarantine` xattr post-extract for silent
    first launch** — `xattr -dr com.apple.quarantine
    /Applications/Friday\ Studio.app` after the .app is in place.
    Trusts codesign+notarization (already done in CI). Failure of
    the xattr command is non-fatal.
21. **Pre-flight only gates the normal-startup path** — CLI
    utility modes (`--autostart {enable,disable,status}`,
    `--uninstall`) bypass pre-flight entirely so a broken install
    doesn't block the cleanup tools.
22. **CLAUDE.md gets a Friday Studio platform layout section** —
    enumerates port 5199, bundle id, autostart target, wait
    deadline, install paths, license sources, and migration
    reference for fast discovery by future maintainers and
    coding agents.
23. **xattr strip dispatches on cp privilege level** — when the
    cp into `/Applications` was user-mode, xattr runs as the
    current user. When the cp required admin elevation, xattr
    runs in the SAME elevated osascript invocation as the cp
    (chained with `&&`) so the user sees one auth prompt, not
    two, and the `.app` is never left root-owned-and-quarantined.
24. **Orphan-sweep integration test uses a real binary, not a
    goroutine** — `SweepByBinaryPath` reads `ps`, which doesn't
    list goroutines. Test copies a stub binary into a test-temp
    install dir, execs it, asserts it's dead post-`--uninstall`.
25. **Supervised binaries live in `~/.friday/local/bin/`** —
    cleaner separation between binaries and state files
    (pids/, logs/, state.json, .env). Cascades into:
    - `binDir` default → `~/.friday/local/bin/`
    - `SweepByBinaryPath(~/.friday/local/bin)` (was `~/.friday/local`)
    - Pre-flight check looks under `bin/`
    - Migration step: `rm
      ~/.friday/local/{friday,link,nats-server,pty-server,webhook-tunnel,cloudflared,gh,playground,friday-launcher}`
      (the v0.0.8 flat layout) AFTER the new layout is in place
    - Tarball layout: `bin/` is a top-level entry alongside
      `Friday Studio.app/`
26. **License files bundled in `bin/`** — Apache 2.0 / MIT
    compliance for third-party binaries we redistribute, plus
    BSL 1.1 for our own:
    - `bin/nats-server-license` (Apache 2.0)
    - `bin/cloudflared-license` (Apache 2.0)
    - `bin/gh-license` (MIT)
    - `bin/LICENSE` (BSL 1.1, copied from repo root)
    Source-of-truth approach in Decision #27.
27. **License files come from pinned GitHub raw URLs, not
    upstream release archives** (NEW in v9, **tightened in v10**)
    — v8 specified "extract LICENSE from the same release
    archive we already download for the binary". That fails on
    Windows cloudflared, which is shipped as a bare `.exe` (no
    archive at all). Even where archives exist, the path of the
    LICENSE file inside them isn't stable across upstream
    releases. v9 instead downloads each LICENSE once per build
    from a pinned tag on the upstream repo's GitHub raw URL.

    **v10 tightening:** the LICENSE URL must interpolate the
    same version constant that drives the binary download URL.
    This makes a version-bump foot-gun structurally impossible
    — a future maintainer who bumps `NATS_SERVER_VERSION`
    automatically bumps the LICENSE URL with it.

    ```ts
    // scripts/build-studio.ts
    const LICENSE_URLS = {
      "nats-server":  `https://raw.githubusercontent.com/nats-io/nats-server/v${NATS_SERVER_VERSION}/LICENSE`,
      "cloudflared":  `https://raw.githubusercontent.com/cloudflare/cloudflared/${CLOUDFLARED_VERSION}/LICENSE`,
      "gh":           `https://raw.githubusercontent.com/cli/cli/v${GH_VERSION}/LICENSE`,
    } as const;
    ```

    Pin a specific tag (not `master`/`main`) so a future force-
    push to upstream's main branch can't change the license text
    underneath us. Build asserts each LICENSE file is non-empty
    post-download; otherwise fails loudly. Generate a
    build-time artifact `dist/<target>/LICENSE-CHECKLIST.md`
    (NOT inside `bin/` — users don't need it; release auditors
    do) listing each license + its source URL for human audit
    before release.
28. **Port 5199 bind-failure shows osascript dialog + exits**
    (NEW in v9) — `startHealthServer` returns the bind error
    instead of swallowing it. main.go intercepts and dispatches
    to the same osascript dialog helper as missing-binaries
    pre-flight (only the message body differs). Title: "Friday
    Studio". Body: "Friday Studio cannot start. Port 5199 is
    already in use by another application. Run `lsof -iTCP:5199`
    in Terminal to see what is using it." Buttons: "Quit" only.
    No tray, no broken-state UI.
29. **LaunchAgent autostart targets `open -a "Friday Studio"`,
    not `Contents/MacOS/friday-launcher` directly** (NEW in v9,
    **limitation documented in v10**) — going through
    LaunchServices means Info.plist (LSUIElement, env, icon,
    quarantine flags) is consulted on every boot, matching the
    user-launched path via Spotlight. Direct exec of the
    bundle's binary skips LaunchServices, which would create
    subtle dev/prod parity bugs (e.g. an LSUIElement update only
    takes effect after the user re-launches via Finder). The
    plist's `ProgramArguments` becomes `["/usr/bin/open", "-a",
    "Friday Studio", "--args", "--no-browser"]`. Trade-off:
    launchd's child is `open`, not the launcher itself, but the
    launcher detaches anyway so process-tree semantics are
    unchanged.

    **v10 limitation note:** `open -a "Friday Studio" --args
    --no-browser` only delivers `--no-browser` to a *fresh*
    launch. If the .app is already running, `open -a` brings
    the existing instance to the front via an Apple Event and
    the `--args` are dropped silently. This is acceptable
    because the only call site is autostart at login, where the
    launcher is by definition not yet running. Future code MUST
    NOT pass meaningful args via `open -a "Friday Studio"
    --args …` against an already-running launcher — they will
    not arrive. If a use case ever needs to deliver runtime args
    to an already-running launcher, route through the existing
    HTTP surface on port 5199 instead. Captured in CLAUDE.md so
    future agents don't re-discover the limitation the hard way.
30. **Migration extracts to staging dirs + atomic swap** (NEW in
    v9) — v8's order (remove-old-binaries → extract-new) leaves
    the system unbootable if extract fails after the removal.
    v9 instead extracts to `/Applications/Friday Studio.app.new`
    + `~/.friday/local/bin.new/` first, then `mv`-swaps the new
    paths into place (atomic on the same filesystem), then
    cleans up the old v0.0.8 flat-layout binaries. A failed
    extract leaves the user's existing v0.0.8 install intact —
    they can keep using it while debugging the failure, or
    re-run the installer. The post-swap cleanup of v0.0.8
    binaries is itself recoverable: leaving stale `friday`,
    `link`, etc. directly in `~/.friday/local/` for one boot
    cycle won't break anything (they're just unused after the
    binDir default points at `bin/`).
31. **Pre-extract cleanup of stale `.new` staging dirs** (NEW in
    v10) — Decision #30's staging-then-swap pattern is robust
    against Rust error paths but doesn't cover `kill -9` /
    power loss / OS crash mid-extract. Without cleanup, a
    second installer run could either collide on the
    `mkdir`-then-write step or silently use stale partial-
    extraction contents. v10 adds a defensive `remove_dir_all`
    of `bin.new/` and `Friday Studio.app.new` at the *start* of
    extraction (before writing anything new). Errors are
    ignored — if the dir doesn't exist (the common case)
    `remove_dir_all` returns NotFound, which is fine. Combined
    with Decision #30's atomic swap, this makes migration
    fully crash-recoverable: the only states observable on
    disk after any failure are "v0.0.8 layout intact" or
    "v0.0.9 layout live" — never a half-written hybrid.
32. **Service readiness probes target user-facing paths, not
    sidecar `/health` endpoints** (NEW in v10) — the wizard
    enables "Open in Browser" when every supervised service
    reports `healthy` (Decision #1's per-service checklist). A
    service goes `starting → healthy` when its readiness probe
    returns 200. The probe path MUST match what the user-facing
    surface actually loads — for playground that's `/`, not
    `/health` or `/api/health`. Otherwise there's a window
    where the sidecar `/health` is up but `/` is still 502'ing
    because the SvelteKit handler isn't bound yet — exactly the
    "click Open, see connection-refused" bug we're fixing
    (Problem 1). Concretely in `project.go`:
    - `playground` probes `http://127.0.0.1:5200/` (root path)
    - other supervised services probe paths that exercise the
      same handler the consumer hits (e.g. `friday` probes its
      actual API surface, not a health sidecar)
    Cost: probe payload is heavier than `/health` (renders the
    full landing page). At 500ms poll cadence post-startup
    that's once per service every 500ms — acceptable for a
    dev-machine surface. Would not be acceptable for high-
    traffic prod, but Friday Studio runs locally for one user.
