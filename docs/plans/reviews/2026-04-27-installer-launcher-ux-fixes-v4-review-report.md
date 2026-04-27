# Review report: 2026-04-27-installer-launcher-ux-fixes (v4)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v5.md`

## Context gathered (new threads, on top of v1+v2+v3 reviews)

- `tools/friday-launcher/main.go:76-150` — `main()` flag-parsing
  routes to `runAutostartCommand` or `runUninstall` and `return`s
  BEFORE calling `setupSignalHandlers` or `systray.Run`. So those
  CLI utility modes never reach the supervisor-init path. v4
  doesn't say where pre-flight slots in; the natural seam is
  AFTER the CLI-mode routing and BEFORE `acquirePidLock` (since
  the pid lock is for the normal launcher path only). v5 makes
  this explicit.
- macOS `xattr -dr com.apple.quarantine` is the canonical command
  for stripping the "downloaded from the internet" attribute.
  Used by Homebrew Cask, by the `gatekeeper-cli` tool, etc.
- `os.Executable()` on a `Friday Studio.app/Contents/MacOS/`
  bundle returns the full path including `.app/Contents/MacOS/`.
  When the .app is App-Translocated, the path becomes
  `/private/var/folders/.../d/Friday Studio.app/Contents/MacOS/...`
  but the substring match in `defaultBinDir` still hits.
- `eventsource-client` Rust crate (~1k LOC) supports
  `text/event-stream` over reqwest and exposes a Stream<Item =
  Result<SSEEvent, Error>>. Standard pick for this use case.
- Recent `tools/friday-launcher/integration_test.go` already
  spawns stub HTTP servers as fake supervised processes (per
  task #92). Extending it for the orphan-sweep test is
  incremental.

## Two new ideas asked + one baked in (no choice)

### 1. SSE relay needs early-connect retry policy

**Problem in v4:** v4's `wait_for_services` connects to
`http://127.0.0.1:5199/api/launcher-health/stream` immediately
after spawning the launcher. There's a millisecond-scale window
where the launcher is still in its single-instance lock + sweep
+ supervisor-init phase and hasn't bound port 5199 yet. v4
doesn't specify what happens when the SSE connect fails. If the
relay returns an error immediately, fast machines might hit it;
slow machines definitely will.

**Three approaches considered:**
- **A**: Capped exponential backoff (200ms, 400ms, 800ms… max 2s)
  for up to 10s total. Common case: launcher binds within
  200-500ms, first retry succeeds. Robust for any spawn-vs-bind
  ordering. After 10s, surface `Unreachable` to the wizard.
- **B**: Fixed 500ms delay before first connect, no retries. If
  500ms isn't enough, fail immediately.
- **C**: Constant 200ms retry up to 10s, no backoff. Loopback is
  cheap so cost is negligible; slightly chatty in logs.

**User decision:** ✅ Adopt **A**. Documented with the actual code
sketch in v5's wait-step section.

### 2. Gatekeeper / quarantine xattr on first .app launch

**Problem in v4:** v4 doesn't address what happens when
`open -a "Friday Studio"` runs against a freshly-extracted .app
that still has `com.apple.quarantine` extended attributes
(propagated from the downloaded .zip's xattrs). On first launch,
Gatekeeper validates the bundle and shows "Friday Studio is from
an identified developer—open?" or worse "downloaded from the
internet, are you sure?" — depending on quarantine state and
whether the bundle is in /Applications vs ~/Downloads. v4's
"silent first launch via LaunchServices" claim isn't true unless
we strip the xattr.

**Three approaches considered:**
- **A**: `xattr -dr com.apple.quarantine
  /Applications/Friday\ Studio.app` post-extract. .app is signed
  + notarized in CI; with quarantine stripped, Gatekeeper has
  nothing to validate. Silent first launch. Same pattern
  Homebrew Cask uses.
- **B**: Don't strip; accept the one-time Gatekeeper prompt.
  Slightly worse UX, simpler.
- **C**: `spctl --add` to whitelist before `open`. Requires
  admin, fires another elevation prompt. Strictly worse.

**User decision:** ✅ Adopt **A**. Failure of the xattr command
is non-fatal (logged); user gets a one-time prompt at worst.

### 3. CLI utility modes skip pre-flight (baked in, no choice)

**Problem in v4:** v4 says pre-flight runs "BEFORE
`systray.Run`". Reading `main()` carefully shows that
`runAutostartCommand` and `runUninstall` exit before `systray.Run`
too — so a literal "BEFORE systray.Run" placement of pre-flight
would intercept those CLI modes. Running pre-flight on
`--autostart status` would pop a dialog when the user just
wanted to check whether autostart is enabled. Running pre-flight
on `--uninstall` would block the user from cleaning up a broken
install — exactly the case where they need uninstall most.

**Decision (no choice asked):** Pre-flight slots in AFTER the
CLI-mode routing, BEFORE `acquirePidLock`. v5 makes the file-list
note explicit: `tools/friday-launcher/main.go (binDir default for
.app context; pre-flight check call AFTER CLI-mode routing,
BEFORE systray.Run)`.

## Bonus: CLAUDE.md additions (also baked in, no choice)

The plan introduces enough new global facts (port 5199, bundle id,
wait deadline staging, install paths, migration semantics) that
they need a single discoverable home. v5 adds a `## CLAUDE.md
additions` section that enumerates what to document and where.
Not a decision per se; just calling out that "we documented the
plan" isn't the same as "future Claude/maintainers can find this
quickly". Brief; ~12 lines of CLAUDE.md content.

## Issues spotted but NOT promoted to v5 changes

These were considered and discarded, recorded so future reviews
don't retread them:

### "SSE protocol_version field for forward-compat"

Considered: add `protocol_version: 1` to every SSE event so future
launcher versions can evolve the schema without breaking pinned
wizards. Rejected: launcher and wizard are versioned together
(both ship in coordinated platform/installer pairs). When the
schema changes, they both change. YAGNI for a single
producer/consumer pair.

### "HEAD /api/launcher-health for cheap polling"

Considered (carry-forward from v3 review): expose a HEAD endpoint
that returns 200 / 503 via headers for clients that want a cheap
"are we up yet" check without parsing the body. Rejected: ~600
byte body, negligible savings, more API surface to maintain.

### "Per-subscriber buffered channel for SSE fan-out"

Considered: each SSE subscriber gets a buffered channel
(buffer=4) so a slow subscriber doesn't drop events. Rejected:
the fan-out signal is just `struct{}{}` (a "state changed,
re-read the cache" notification) — the cache itself is the
truth. A slow subscriber that misses notifications just polls
the cache on its next read; no event-loss semantic concern.
Non-blocking `default:` in the writer is the correct pattern.

### "Generic notification framework for cross-binary events"

Considered: a launcher → installer event bus that could carry
shutdown progress, restart-all, autostart-toggle, future
launcher-side events. Rejected: scope creep. Adding endpoints
when concrete consumers arrive is the right shape.

### "Lock the wait deadline behind a feature flag"

Considered: gate the 60s/90s/+60s logic behind a flag in case
the deadline tuning turns out wrong. Rejected: deadline tuning
is a config knob worth iterating on after real-world data. A
hardcoded value with a 5-line change is cheaper than a feature
flag scaffold for one numeric value.

### "Use NSWorkspace.openApplicationAt API instead of `open -a`"

Considered: NSWorkspace's modern Swift API for launching apps
gives us a callback when the launch completes. Rejected: cgo for
NSWorkspace is more code than `exec.Command("open", "-a", ...)`,
and we don't actually need the launch-complete callback (the
SSE backoff loop handles "is the launcher up yet").

## Unresolved questions

None. All design decisions captured in v5 §Decisions.

Verification items carried forward from prior reviews to be
checked during implementation:

1. **Spotlight + LSUIElement on macOS Sonoma+** (v1+v2+v3
   reviews).
2. **EventSource on Windows WebView2** (v2 review).
3. **codesign --deep behavior with a duplicate flat binary at
   tarball root** (v2 review).
4. **`osascript` availability under MDM-restricted macOS** (v3
   review).

New verification item from v5:

5. **`xattr -dr` actually removes quarantine on signed .apps.**
   Verify on a freshly-extracted .app from a downloaded .zip
   that:
   - `xattr /Applications/Friday\ Studio.app` lists
     `com.apple.quarantine` before strip
   - After `xattr -dr com.apple.quarantine ...`, the attribute
     is gone
   - `open -a "Friday Studio"` fires silently (no Gatekeeper
     dialog)
   - `spctl --assess -v /Applications/Friday\ Studio.app` returns
     "accepted" (notarization is intact)

## Overlap with v4

v5 keeps unchanged from v4:
- The 6 problem statements
- The 8 goals (v4 added "broken install reinstall dialog"; v5
  adds "silent first-launch via quarantine strip")
- The cross-cutting `/api/launcher-health` design
- The Quit confirmation modal design (cgo NSAlert post-systray)
- The shutdown trace logging design
- The .app bundle id `ai.hellofriday.studio-launcher`
- The /Applications-only install with admin elevation
- The v0.0.8 → v0.0.9 migration sequence (extended in v5 with
  step 6: quarantine xattr strip)
- The `--uninstall` orphan-sweep fix
- Backwards-compatible v0.0.9 tarball
- Cmd+Q-during-system-shutdown acceptance + recovery via
  startup sweep
- LaunchAgent label vs bundle id non-goal
- Pre-flight via osascript
- Wait-healthy staged 60s/90s/+60s deadline
- "Open anyway" partial-success rule
- HealthCache state machine
- HTTP server lifecycle decoupled from RestartAll

v5 changes from v4:
- SSE relay uses capped exponential backoff for early-connect
  race (200ms, 400ms, 800ms… max 2s; up to 10s total)
- Quarantine xattr stripped post-extract; "silent first-launch"
  is now actually true (was aspirational in v4)
- Pre-flight placement is explicit: AFTER CLI-mode routing,
  BEFORE systray.Run — so `--autostart`/`--uninstall` bypass it
- CLAUDE.md gets a Friday Studio platform layout section
- New goal: silent first-launch (no Gatekeeper prompts)
- New risk: quarantine xattr strip failure (non-fatal fallback)
- File list adds `wait_health.rs` backoff loop note;
  `extract.rs` gets the quarantine strip step
- Decisions list grows to 22 (was 18)
- SSE fan-out concurrency: explicit per-subscriber `chan
  struct{}` registered in a `[]chan struct{}` under sub-mutex
  (was just "fan-out via channel" in v4)
