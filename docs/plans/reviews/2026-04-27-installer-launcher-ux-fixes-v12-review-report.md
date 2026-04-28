# Review report: 2026-04-27-installer-launcher-ux-fixes (v12)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v13.md`

## Summary

v12 closed all three gaps from the v11 review. v13 picks up
three more — one is a real correctness regression *introduced
by* v12's Decision #29 update (bundle-ID `open -b`), one is an
ergonomics improvement, one is build-time hardening. The
correctness regression is the most important of the three: it's
exactly the kind of issue that only surfaces because earlier
fixes shifted the resolution semantics.

## Three new ideas, all baked in

### 1. `.app.bak` location: `/tmp/friday-app-backup-<pid>` instead of `/Applications/Friday Studio.app.bak`

**Real correctness regression introduced by v12.**

v11 added the `.app.bak` to migration step 6 + Decision #31's
pre-extract cleanup. v11's resolution path (`open -a "Friday
Studio"` by display name) had its own resolution rules where
the most-recently-modified .app would win — a v12-style stale
`.bak` in `/Applications` would lose to the newly-renamed live
.app. So v11's `.bak`-in-`/Applications` was acceptable.

v12 changed resolution to bundle-ID via `open -b
"ai.hellofriday.studio-launcher"`. LaunchServices indexes ALL
bundles in `/Applications` by their `CFBundleIdentifier`. Both
the live `.app` and the orphan `.bak` advertise the same
bundle ID. Resolution between same-ID bundles is **non-
deterministic** (typically most-recently-touched, but not
guaranteed). A migration crash between step 6 (rename live
`.app` → `.bak`) and step 7 (delete `.bak`) leaves the orphan
on disk; a subsequent `open -b` from autostart at next login
could resolve to the orphan with the OLD launcher binary.

The previous staleness mitigation (most-recent-wins under
display-name resolution) doesn't apply under `-b`.

**Fix in v13:** rename outside `/Applications`. Use
`/tmp/friday-app-backup-<pid>`. `/tmp` is not in
LaunchServices's index path, so the orphan is invisible to
`open -b` resolution even if it survives a reboot. The within-
`/Applications` rename (`.new` → `.app`) stays — that's the
swap that needs to be atomic for live-path correctness. The
out-of-`/Applications` move of the live → backup is cross-
filesystem on most setups (slower than same-FS rename), but
still O(seconds) for our small bundle and only happens once
per migration.

Decision #31 updated: pre-extract cleanup uses a glob sweep
(`/tmp/friday-app-backup-*`) instead of a fixed `.bak` path.
Migration steps 6 + 7 + §Test before shipping all updated.

### 2. Diagnostic log path under `~/.friday/local/logs/`

v12's Decision #34 wrote pre-flight / bind-failure logs to
`os.TempDir()`. Reasoning was "always-writable, even on a
half-broken install." Real on macOS, but the path resolves to
`/var/folders/<hash>/T/...` — opaque, hard to reference, hard
to copy from a dialog body.

**Fix in v13 (per user request):** `~/.friday/local/logs/launcher-startup.log` —
co-located with the launcher's normal logs (already documented
in CLAUDE.md as the canonical location). `mkdir -p` ensures
the directory exists. If `mkdir` fails (extreme edge case —
`~/.friday` not writable, full disk), the helper falls back to
`os.TempDir() + "/friday-launcher-startup.log"` so the log
still lands somewhere.

Test matrix updated to test both the primary path AND the
fallback (chmod -w on `~/.friday/local` to force the fallback
branch).

### 3. Build-time assertion: Info.plist matches Decision #3 + #29 (Decision #35, NEW)

`open -b "ai.hellofriday.studio-launcher"` only works if the
.app's Info.plist actually advertises that exact bundle ID.
Code-signing (per Decision #3) also depends on the bundle ID
matching the certificate. v12 commits to the bundle ID at the
plist level, but v12's `scripts/build-studio.ts` plist
template is hand-typed text — a typo would silently produce
a tarball where every install fails (autostart broken,
codesign invalid).

**Fix in v13 (Decision #35):** parse the generated Info.plist
post-build and assert:
- `CFBundleIdentifier === "ai.hellofriday.studio-launcher"`
- `CFBundleExecutable === "friday-launcher"`

Build fails loudly on mismatch with actual-vs-expected values.
Cheap insurance, ~10 lines of code, catches a class of bugs
that would otherwise only surface in production.

Same constants used by `enableAutostart()`'s plist payload
(both depend on the bundle ID) so a single source-of-truth
change rebuilds + re-asserts.

## Issues considered and discarded

### "`currentAutostartPath()` semantics under `-b` are misleading"

Considered: with v12's `-b` change, `currentAutostartPath()`
in `autostart_darwin.go` returns `/usr/bin/open` for every
install (because that's now `ProgramArguments[0]`). This
breaks its prior staleness-check purpose. Either remove it or
repurpose it to query LaunchServices directly via `mdfind
kMDItemCFBundleIdentifier`.

Rejected as a v13 design decision: it's an implementation-
cleanup concern. The staleness check is no longer necessary
under bundle-ID resolution — LaunchServices handles binary-
location updates internally. The implementer can remove the
function (and any callers) as part of Stack 3, OR leave it as
a no-op that always returns `/usr/bin/open`. Either choice is
fine; doesn't need a Decision.

### "Add a `Show log` button to the osascript dialogs"

Considered: instead of just printing the log path in the
dialog body (which the user has to copy by hand), add a third
button that opens Finder at the log directory.

Rejected: scope creep. osascript `display dialog` supports
multiple buttons but each adds a code path. Three buttons
(Quit / Open download page / Show log) is busy. The user can
copy the path from the dialog body and paste it into Finder's
Go menu; that's standard macOS. Not worth the dialog-
complexity tradeoff.

### "Move autostart's `RunAtLoad` to `false` to avoid interaction with migration step 10"

Considered: the existing autostart plist sets `RunAtLoad=true`,
which means `launchctl load` triggers an immediate launch.
Migration step 10 (`open -b` first launch) is somewhat
redundant if step 9 (`launchctl load`) already launched.

Rejected: the existing autostart code (per the codebase) does
NOT call `launchctl load` after writing the plist — it writes
the file and lets launchd pick it up at next user-session
login. So step 9 doesn't trigger immediate launch; step 10's
`open -b` is the first-launch path. No interaction issue.
Documenting this in v13 would be clarifying noise; the
implementer reading `enableAutostart()` will see the existing
behavior.

### "Add bundle-ID validation in launcher startup (CFBundleIdentifier sanity check)"

Considered: at launcher startup, parse our own Info.plist
(via `os.Executable()` + walking up to `Contents/Info.plist`)
and assert the bundle ID matches the constant. Catches the
"someone hand-edited the plist" case.

Rejected: redundant with Decision #35's build-time assertion.
If the build asserted, the runtime wouldn't see a typo. The
"someone hand-edited the .app post-install" scenario is an
attack vector we don't defend against (codesign verification
is the right tool there, not our own check).

### "Use a deterministic backup name like `Friday Studio.app.bak.v0.0.8`"

Considered: instead of `/tmp/friday-app-backup-<pid>`, use a
fixed name like `/tmp/friday-app-backup-v0.0.8.bak`. Easier to
reference + clean up.

Rejected: a fixed name introduces collision potential if two
installer runs overlap (unlikely but possible). The pid suffix
is essentially free uniqueness. Glob-sweep cleanup handles it.

## Unresolved questions

None. v13 is implementation-ready.

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
10. Crash-recovery negative test (v10, refined v13 for new
    `/tmp` backup location)
11. Playground probe path matches browser load (v10)

No new verification items in v13 — all three fixes are
testable in CI.

## Overlap with v12

v13 keeps unchanged from v12:
- TLDR section structure (with v13 changelog header)
- All six problem statements
- All eight goals + four non-goals
- Cross-cutting `/api/launcher-health` endpoint surface;
  CAS gate in `performShutdown` from v12 unchanged
- Service status state machine; auth-walled probe caveat
  from v11 unchanged
- Issue 1+2+3 wizard rewrite (unchanged)
- Issue 4 tray fix (unchanged)
- Issue 5 .app bundling, /Applications-only with admin
  elevation, binDir resolution, pre-flight (unchanged
  except for new Decision #35 assertion)
- Issue 6 Quit/uninstall sweep semantics (unchanged)
- Build sequence (unchanged; v0.1.16 still ships first)
- Stack 1/2/3 split + recommended order (unchanged)

v13 changes from v12:
- Migration § step 4: pre-extract cleanup uses glob sweep of
  `/tmp/friday-app-backup-*` instead of fixing `.bak` in
  `/Applications`
- Migration § step 6: backup target moved to
  `/tmp/friday-app-backup-<pid>`
- Migration § step 7: cleanup of `<bak>` from step 6
- §Test before shipping: post-install assertions updated
  (no `.bak` siblings; `/tmp/friday-app-backup-*` empty;
  `mdfind` returns exactly one path); negative test text
  updated for the new backup location; new "legacy `.bak` in
  `/Applications`" edge-case test
- Pre-flight § implementation block: `writeStartupErrorLog`
  prefers `~/.friday/local/logs/launcher-startup.log`,
  falls back to `os.TempDir()` if mkdir fails
- §Files to change for `scripts/build-studio.ts`: new
  Info.plist assertion item
- Test matrix: pre-extract cleanup row updated for new path;
  startup-error log row updated for new path + fallback
  test; new row for Info.plist assertion
- Decisions: #31 extended (`/tmp` location), #34 amended
  (path + fallback), #35 added (Info.plist assertion)
- TLDR counts: 34 → 35 decisions; 14 risks unchanged

## Recommendation

**Stop reviewing the plan; start writing the code.** v13 is
the last useful /improving-plans output. Twelve prior review
passes + v13's three fixes have closed every platform-parity,
failure-mode, implementer-ambiguity, concurrency, and now
LaunchServices-resolution edge that survived. Stack 1
(launcher HTTP server + Issue 6) still ships the highest-
confidence fix with the smallest blast radius; implementation
should start there.
