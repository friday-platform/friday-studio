# Review report: 2026-04-27-installer-launcher-ux-fixes (v8)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v9.md`

## Why v9 happened

v7 review concluded "design converged, stop reviewing, write code"
and v8 added two real product changes (bin/ subdir + LICENSE
files, drop v0.1.15 cutover compat). v8 review then surfaced five
genuinely new gaps that the prior six review passes had missed —
mostly platform-parity edge cases introduced or amplified by
v8's layout changes.

All five accepted by the user. v9 is a real version bump, not
polish.

## Five new ideas, all baked in

### 1. License sources: pinned GitHub raw URLs, not upstream archives

**Real correctness gap in v8.** v8 §Issue 5 step 2 says
"extract LICENSE from upstream release archives". `scripts/build-studio.ts:81-94`
shows cloudflared on Windows is a **bare .exe download** — no
archive to extract from. v8's build assertion "each LICENSE file
must exist post-extract" would fail every Windows build.

Beyond Windows cloudflared specifically, the path of LICENSE
files inside upstream tarballs isn't stable across releases —
extracting from `nats-server-vX.Y.Z-darwin-arm64/LICENSE` works
today but a future nats-server release could rename the path.

**Fix in v9 (Decision #27):** download each LICENSE file once
per build from a pinned-version GitHub raw URL on the upstream
repo. Same source-of-truth across all platforms; pin to specific
version tag (not branch) so upstream can't force-push the license
text underneath us. Build asserts each LICENSE file is non-empty
post-download; otherwise fails loudly. Generate a
`bin/LICENSE-CHECKLIST.md` build artifact listing each license +
source URL for pre-release audit.

### 2. Port 5199 bind-failure UX spec

v8 §Risks said "If something else is already on 5199, launcher
startup fails with a clear error and we move it" — but didn't
specify what the user sees. Without a dialog, the user gets a
tray that briefly appears then vanishes, no log they'd think to
read, no signal of what went wrong. Real failure mode on dev
machines (ports clash with other tools) and corporate Macs (MDM
firewalls).

**Fix in v9 (Decision #28):** `startHealthServer` returns the bind
error to main.go; main.go dispatches to the same osascript dialog
helper as missing-binaries pre-flight. Symmetric "launcher can't
start" UX. Title: "Friday Studio". Body explains port 5199 in use
+ how to diagnose with `lsof -iTCP:5199`. Buttons: "Quit" only.
Same `preflight_dialog_darwin.go` helper handles both message
variants — small extension, no new file.

### 3. LaunchAgent autostart routes via `open -a`, not direct exec

`tools/friday-launcher/autostart_darwin.go:53` writes the literal
`os.Executable()` path into the plist's `ProgramArguments`. Post-
migration that's `/Applications/Friday Studio.app/Contents/MacOS/friday-launcher`.
Works, but **bypasses LaunchServices** — Info.plist (LSUIElement,
icon, env vars from the .app bundle) isn't consulted on every
boot. Subtle dev/prod parity bug: an LSUIElement update would
only take effect after the user re-launched via Finder.

**Fix in v9 (Decision #29):** plist's ProgramArguments becomes
`["/usr/bin/open", "-a", "Friday Studio", "--args",
"--no-browser"]`. Same path the user takes via Spotlight, so
dev/prod parity. Trade-off: launchd's child is `open`, not the
launcher itself; the launcher detaches anyway (setsid on Unix)
so process-tree semantics are unchanged.

### 4. Migration: extract-to-staging then atomic swap

v8 §Migration said:
- step 4: remove old v0.0.8 flat-layout binaries from `~/.friday/local/`
- step 5: extract new tarball with split-destination

If step 5 fails after step 4 succeeded (filesystem error,
permission denied, network drop mid-write), the user has an
unbootable system — old binaries gone, new ones partial. The
"rename install dir to .bak" rollback in v8's §Risks only protects
step 5, not step 4.

**Fix in v9 (Decision #30):** swap the order:
1. Extract to `bin.new/` and `Friday Studio.app.new` staging
2. Atomically `mv` the staging paths into place
3. Then clean up old v0.0.8 binaries (now safe; new layout is
   live)

`mv` on the same filesystem is atomic. A failed extract leaves
the user's existing v0.0.8 install intact + no `.new` cruft on
disk. The post-swap cleanup of v0.0.8 binaries is itself
recoverable — leaving stale `friday`, `link`, etc. in
`~/.friday/local/` for one boot cycle won't break anything (the
new binDir default already points at `bin/`).

New negative-path test in §Test before shipping: simulate extract
failure mid-write, verify v0.0.8 install untouched.

### 5. SSE-connect backoff deadline 10s → 20s

v8's `wait_health.rs` uses 10s of capped exponential backoff
before surfacing `Unreachable`. That's tight for the migration
upgrade path: extract.rs now spawns the new launcher via
`open -a "Friday Studio"` (per Decision #29). Cold-cache
LaunchServices spin-up + Mach-O load + supervisor init can brush
6-8s on slow Macs before the launcher even reaches
`startHealthServer`. The 10s budget puts us within striking
distance of false-negative `Unreachable` events on slow first-
launches where the launcher is fine, just late.

**Fix in v9 (Decision #19 updated):** bump deadline to 20s. Adds
zero common-case latency (first retry succeeds in ~200ms
regardless). The 60s soft / 90s hard / +60s wait-healthy timeline
starts AFTER SSE connects, so a longer connect budget doesn't
compound into the user-visible deadlines.

## Issues considered and discarded

### "Pin LICENSE files to commit SHA, not version tag, for max stability"

Considered: GitHub release tags can technically be force-pushed
(though npm/Cargo conventions discourage this). Pinning to a
40-char SHA eliminates that risk entirely.

Rejected: not the practice of nats-io, cloudflare, or cli/cli
to mutate release tags. Pinning to version tag matches the
binary's version, keeps URLs human-readable in the build script,
and matches the convention nearly every Linux distribution uses
for license auditing. If a maintainer mutated a release tag,
the build assertion (non-empty LICENSE post-download) is the
backstop — but the SHA approach optimizes for a threat model
that doesn't exist.

### "Add a Reinstall button to pre-flight dialogs"

Considered: when pre-flight surfaces missing binaries, give
users a button that re-runs the installer rather than just
"Open download page" (which makes them retype URL).

Rejected: out-of-scope and complicated. Re-running the installer
from inside the launcher needs a path to the installer .app
that we don't track. "Open download page" goes to
`download.fridayplatform.io` which redirects to the latest
installer — one extra click, fully reliable. Future feature if
support load justifies it.

### "Add `friday-launcher --reinstall` subcommand that downloads + replaces"

Considered: same problem as Reinstall button, but as a CLI
helper. Could be invoked from the dialog.

Rejected: same scope objection, plus introduces a self-update
mechanism that has its own security/UX surface. The installer
is the source of truth for installs.

### "Pre-flight check for `/Applications/Friday Studio.app` corruption"

Considered: extend pre-flight to also `codesign --verify` the
`.app` bundle on every launch, surfacing tampering.

Rejected: macOS Gatekeeper does this on first launch (which
quarantine-strip pre-empted) and the runtime hardening flag
makes the kernel reject mismatched signatures. Extra `codesign
--verify` adds ~50-100ms to every launch for a threat model
the OS already covers.

### "Migration: keep old binaries around for a recovery window"

Considered: don't delete v0.0.8 binaries in step 6; keep them as
`friday.old`, `link.old`, etc. for 30 days as recovery.

Rejected: the staging-then-swap pattern already protects against
extract failures, which is the only realistic recovery scenario.
After successful migration, the v0.0.8 binaries are dead weight
(80+ MB on disk) for a recovery the user will never invoke. The
tradeoff isn't worth it.

## Unresolved questions

None. v9 is implementation-ready.

Verification items carried forward (all have documented
fallbacks if they fail):

1. Spotlight + LSUIElement on macOS Sonoma+
2. EventSource on Windows WebView2
3. codesign --deep on the .app bundle
4. osascript availability under MDM-restricted macOS
5. xattr -dr behavior on signed .apps
6. LICENSE file presence in pinned third-party releases (v8)

New verification items from v9:

7. **`open -a` autostart end-to-end at boot.** macOS CI runners
   don't have user-session LaunchServices state, so autostart
   exercising must happen on lcf's test machine. Verify reboot
   fires the .app launcher via `open` (not direct binary exec)
   and the tray comes up with LSUIElement honored.
8. **Pinned GitHub raw URL availability.** Build pulls each
   LICENSE from `raw.githubusercontent.com`. Verify pre-merge
   that the URLs return 200 + non-empty content (build assertion
   covers this but worth eyeballing once).
9. **Migration negative-path: extract failure recovery.** Test
   that mid-extract failure leaves v0.0.8 install intact and no
   `.new` cruft on disk; re-running installer succeeds.

## Overlap with v8

v9 keeps unchanged from v8:
- TLDR section structure (with v9-specific updates noted in
  the v9 changelog header)
- All six problem statements
- All eight goals + four non-goals
- Cross-cutting `/api/launcher-health` endpoint surface (HTTP +
  SSE + shutdown handler) — only addition is the bind-failure
  surfacing helper
- Service status state machine + concurrency model
- Issue 1+2+3 wizard rewrite (only change: SSE-connect deadline
  bumped 10s → 20s)
- Issue 4 tray fix (unchanged)
- Issue 5 .app bundling, /Applications-only with admin elevation,
  binDir resolution — only change: pre-flight extended to also
  handle port-in-use, plus license URL sourcing in
  scripts/build-studio.ts
- Issue 6 Quit/uninstall sweep semantics (unchanged)
- v0.0.8 → v0.0.9 migration motivation + table (steps reordered
  per Decision #30)
- Build sequence (unchanged; v0.1.16 still ships first)
- Test Matrix structure (extended with autostart `open -a`
  test, staging+swap recovery test, license assertion test)

v9 changes from v8:
- Cross-cutting §: bind-failure dialog handling added
- Issue 1+2+3 SSE backoff: 10s → 20s with rationale
- Issue 5 step 2: license sourcing language switched from
  "extract from upstream archive" to "download from pinned
  GitHub raw URL"
- Issue 5 step 7: pre-flight dialog helper extended for
  port-in-use variant
- Migration steps 4+5+6 reordered to extract-to-staging →
  atomic-swap → cleanup-old-binaries
- Migration step 8 (autostart re-register) targets
  `open -a` invocation instead of direct binary path
- Migration §Test before shipping: added negative-path test
- §Risks: HTTP port 5199 collision risk now references
  Decision #28 dialog flow; LICENSE fetch failure risk added;
  `open -a` autostart trade-off risk added
- CLAUDE.md additions: LaunchAgent target string, license
  source method, staging-then-swap migration note
- Test Matrix: 4 new test rows (port-bind, autostart `open -a`,
  staging+swap recovery, license assertion); SSE backoff test
  deadline 10s → 20s
- Decisions: #19 deadline updated; #27 (license URLs), #28
  (port dialog), #29 (autostart `open -a`), #30 (staging+swap)
  added

## Recommendation

**Stop reviewing the plan; start writing the code.** v9 is the
last useful /improving-plans output. Six prior review passes
+ v9's five new gaps closed all the platform-parity edge cases
that survived. Stack 1 still ships the highest-confidence fix
(Issue 6's `--uninstall` sweep) with the smallest blast radius;
implementation should start there.
