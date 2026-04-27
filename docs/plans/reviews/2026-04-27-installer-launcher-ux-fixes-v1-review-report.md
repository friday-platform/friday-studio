# Review report: 2026-04-27-installer-launcher-ux-fixes (v1)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v2.md`

## Context gathered

Read in full:
- `tools/friday-launcher/project.go` — the supervised process specs +
  HttpProbe config + start/stop ordering
- `tools/friday-launcher/main.go` — shutdown plumbing
  (`performShutdown`, NSApp wiring, signal handlers)
- `apps/studio-installer/src-tauri/src/commands/extract.rs` —
  including the existing `terminate_studio_processes` SIGTERM-and-poll
  dance
- `apps/studio-installer/src-tauri/src/lib.rs` — Tauri command
  registration
- `apps/studio-installer/src/lib/store.svelte.ts` — current store
  shape, no per-service status fields yet
- `apps/studio-installer/src/steps/Extract.svelte` — current extract
  UI (just a spinner + "Extracting Friday Studio files. This may
  take a moment.")
- `scripts/build-studio.ts` — staging tree assembly,
  `archiveStaging`, GO_BINARIES + DENO_BINARIES build loop

Verified the plan's referenced behaviors:
- `state.IsReady()` is process-compose's heuristic — confirmed by
  reading process-compose's project_runner.go via opensrc/sources.
- `extract_archive` uses `tar::Archive::unpack()` (single sync call)
  and `zip::ZipArchive::by_index` — no per-entry progress hooks
  exist in the current code.
- `binDir` defaults to `filepath.Dir(os.Executable())` —
  the .app-bundle case isn't handled.
- The Tauri command list in `lib.rs` has no `wait_for_*` or
  `dump_state` commands today — all new.

## Five new ideas

### 1. Launcher exposes `/api/launcher-health` (HTTP + SSE)

**Problem in v1:** v1 has a `wait_for_services` Tauri command that
hardcodes the (name, port, path) list of probe endpoints in
`apps/studio-installer/src-tauri/src/commands/wait_health.rs`. That
list mirrors `tools/friday-launcher/project.go`'s
`supervisedProcesses`. Drift between the two = silent bugs (wizard
probes a service that's not even spawned, or doesn't probe one that
is).

Same problem applies to the tray bucket logic in v1 — it reads
`supervisor.State().IsReady()` (process-compose's heuristic) instead
of having its own per-service tracking.

**Proposed:** Launcher binds a small HTTP server on
`127.0.0.1:5199`. Three endpoints:
- `GET /api/launcher-health` — JSON aggregate
- `GET /api/launcher-health/stream` — SSE for live updates
- `POST /api/launcher-shutdown` — orderly shutdown trigger

The launcher polls `supervisor.State()` internally, derives
per-service status (`pending` / `starting` / `healthy` / `failed`),
caches in memory, serves from cache. Tray bucket logic reads from
the same cache. Wizard's wait step subscribes to SSE.

**User decision:** ✅ Adopt. Single source of truth.

### 2. Drop `Setpgid`; rely on `processkit.SweepByBinaryPath` alone

**Problem in v1:** v1 proposes process-group SIGTERM via
`Setpgid: true` on each ProcessConfig, with a fallback "via a
wrapper" if process-compose doesn't expose it. process-compose's
`types.ProcessConfig` does NOT expose Setpgid (verified by reading
process-compose's process.go). The "wrapper" would be either
forking process-compose or shipping a small `setpgid-wrapper`
binary that exec's the real binary. Both are real engineering work
for marginal benefit, since:

- `processkit.SweepByBinaryPath(binDir)` already kills any process
  whose `/proc/<pid>/exe` (or macOS equivalent) resolves under our
  install dir.
- We already wrote it for the launcher's startup-sweep path.

**Proposed:** Drop the Setpgid plumbing entirely. After
`supervisor.Shutdown()` returns (or its 30s deadline hits), call
`processkit.SweepByBinaryPath(homeDir() + "/.friday/local")` as the
post-shutdown hammer.

**User decision:** ✅ Adopt. Less code, same correctness.

### 3. Extract progress: running count, no build-time sidecar

**Problem in v1:** v1 says "Unpacking… 1247 / 8932 files" — implies
the wizard knows the total entry count upfront. It doesn't. tar's
streaming API doesn't expose entry count without a second pass over
the archive (which costs ~3-5s on a 540MB zstd archive on M-series).

**Three options considered:**
- **A**: Build-time `friday-studio_<v>_<target>.entries.txt` sidecar,
  same pattern as `.sha256`. Wizard reads it before extract starts.
- **B**: Show running count only ("Unpacking… 1247 files"). No build
  pipeline change.
- **C**: Two-pass extract — count once, extract once.

**User decision:** ✅ Option B (running count, no total).

### 4. v0.0.8 → v0.0.9 layout migration is missing in v1

**Problem in v1:** v1 proposes wrapping the launcher in a
`Friday Studio.app` bundle and shipping it to `/Applications`,
while keeping supervised binaries at `~/.friday/local/`. But it
doesn't address the migration from existing installs:
- `~/.friday/local/friday-launcher` (the old flat binary) remains
  as cruft after extract.
- The LaunchAgent plist points at the old path, so autostart-at-login
  fires the OLD launcher even after the new one is installed.
- `processkit.SweepByBinaryPath(~/.friday/local)` would now sweep
  the orphaned old launcher AND any of its still-running children,
  which could fight with the new launcher.

If we ship without explicit migration, the first user who upgrades
ends up in a broken state (likely two launchers, autostart pointing
at wrong path).

**Proposed:** Add a migration sequence to `extract.rs`:
1. Detect old layout (`~/.friday/local/friday-launcher` exists +
   is a Mach-O)
2. Stop old launcher via SIGTERM-and-poll (the new HTTP shutdown
   endpoint isn't bound on v0.0.8)
3. `launchctl unload` + remove old plist
4. `rm ~/.friday/local/friday-launcher`
5. Extract new tarball (split-destination — .app to /Applications,
   binaries to ~/.friday/local)
6. Re-register autostart (launcher's `--autostart enable` resolves
   the new path via `os.Executable()`)

**User decision:** No choice — it's a correctness gap. Documented
as a mandatory migration section in v2.

### 5. `/Applications` only — drop `~/Applications` fallback

**Problem in v1:** v1 says "if `/Applications` isn't writable, fall
back to `~/Applications`". This is an undecided runtime branch —
some installs would land in `/Applications` and some in
`~/Applications`. That makes uninstall + future upgrades messy
(have to check both paths). Also `~/Applications` is sometimes
Spotlight-invisible on Sonoma+ corporate-managed machines.

**Three options considered:**
- **A**: Always `/Applications`, prompt for admin if needed.
- **B**: Try `/Applications`, silent fallback to `~/Applications`.
- **C**: Always `~/Applications`.

**User decision:** ✅ Option A. `/Applications` only; admin prompt
when needed (most users won't see one).

## Issues spotted but NOT promoted to v2 changes

These were considered and discarded, recorded so future reviews
don't retread them:

### "Use `LaunchServices` API for installing the .app instead of `cp -R`"

Apple's recommended path for app installation is
`LSRegisterURL`/`NSWorkspace.installApp:`. Considered, rejected:
overkill for our case. `cp -R` followed by the user opening the .app
once (which triggers Gatekeeper validation + LaunchServices registration
naturally) is what every other macOS app installer does, and it works.

### "Run `codesign --verify` in CI to catch bundle-level signing issues"

Considered, deferred. The studio-build.yml workflow already
codesigns + notarizes; switching to bundle-level signing
(`codesign --deep` + entitlements at the bundle level) is a known
pattern documented by Apple. Adding a verify step is a good idea
but doesn't belong in this v2 — it can land separately as a CI
hardening commit.

### "Add a JSON log format flag to launcher for the shutdown trace"

Considered, rejected as over-engineered. The shutdown trace is
~10 log lines per Quit. slog with key=value is plenty readable;
JSON adds dependency surface for marginal benefit.

### "Per-service icon in tray dropdown"

Considered, explicitly out-of-scope per v1's non-goals ("Adding a
tray UI for service-by-service status"). The `/api/launcher-health`
HTTP endpoint is what tools that want detail can read; the menubar
title text stays the headline.

## Unresolved questions

None blocking — v2 is implementation-ready. Two things to verify on
real hardware before/during implementation:

1. **Spotlight + LSUIElement on macOS Sonoma+.** v2 flags this as
   a 5-minute test. If LSUIElement=1 apps don't show in Spotlight
   on the test machine, drop it and accept a Dock icon.
2. **EventSource on Windows WebView2.** The wizard's wait step
   uses SSE; macOS WKWebView is solid but Windows WebView2's SSE
   support has historically been spotty. Fallback path (poll
   `/api/launcher-health` every 500ms) is documented in v2's
   Risks section.

## Overlap with v1

v2 keeps unchanged from v1:
- The 6 problem statements
- The 6 goals (one bullet added: "single source of truth for service
  list")
- The Quit confirmation modal design
- The shutdown trace logging design
- The NSApp will-terminate hook
- The Spotlight + LSUIElement risk callout
- The bundle id (`ai.hellofriday.studio-launcher`)
- The build + ship sequence (with the addition that v0.0.9 must
  ship before v0.1.16 because the installer consumes the launcher's
  new HTTP endpoint)

v2 changes from v1:
- Adds the cross-cutting `/api/launcher-health` design
- Drops `Setpgid` from the shutdown plan
- Demotes "1247 / 8932 files" to "1247 files"
- Adds explicit `/Applications` admin-elevation flow
- Adds the v0.0.8 → v0.0.9 migration section
- Updates Issue 4 fix to read from health-cache instead of
  process-compose's `IsReady()`
- Adds `EventSource on WebView2` to risks
