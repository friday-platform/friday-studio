# Review report: 2026-04-27-installer-launcher-ux-fixes (v13)

**Date:** 2026-04-27
**Reviewer:** /improving-plans pass
**Output:** `2026-04-27-installer-launcher-ux-fixes.v14.md`

## Summary

v13 closed all three gaps from the v12 review. v14 picks up
two final small gaps — one is a real product UX bug
(migration silently re-enabling autostart that the user had
explicitly disabled), one tightens v13's `/tmp` backup
location to be per-user.

After 13 review passes, the plan is genuinely converged.
v14's two fixes are the last remaining substantive gaps I
can find. Further review would be polish, not bugs.

## Two new ideas, both baked in

### 1. Migration preserves the user's autostart preference (Decision #36)

v13's migration step 9 unconditionally called
`enable_autostart()`. But v0.0.8's `--autostart disable`
removes the plist file entirely; absent file = user
explicitly disabled. The v0.0.9 migration would silently
re-enable it — a real UX violation: the user's choice gets
overridden by an upgrade.

**Fix in v14 (Decision #36):** capture
`plist_path.exists()` at step 3 *before* unloading. Carry
through to step 9 as `user_had_autostart`. Step 9
conditionally re-registers; logs the skip with a clear
reason so it's visible in the install transcript.

Test matrix gains a positive test (autostart-enabled
preserved) AND a negative test (autostart-disabled
preserved). §Test before shipping gains both scenarios.

### 2. Backup target moved to `~/.friday/local/backup-<pid>` (Decision #31 v14 update)

v13 put the migration backup at `/tmp/friday-app-backup-<pid>`.
Two issues:
- macOS `/tmp` is shared across users. A multi-user machine
  could see one user's pre-extract glob sweep wipe another
  user's backup.
- `~/.friday/local/` is also outside LaunchServices's index
  path (the only constraint v13 cared about), AND is per-
  user by definition, AND matches the existing install-paths
  convention.

**Fix in v14:** rename to `~/.friday/local/backup-<pid>`.
Per-user safety, no behavior change otherwise. Decision #31
amended; migration steps 4/6/7 + §Test before shipping +
test matrix updated.

## Issues considered and discarded

### "Decision #35's TS vs Go bundle-ID-constant duplication"

Considered: `scripts/build-studio.ts` (TS) and
`tools/friday-launcher/autostart_darwin.go` (Go) both encode
the bundle ID and the launcher binary name. They can't import
each other's constants; a typo in one wouldn't be caught by
the other. Mitigation: define in a shared YAML, codegen Go
consts, or build-time test that diffs the two.

Rejected: implementation hygiene, not design. Decision #35's
build-time assertion catches typos in the TS-generated
plist's runtime values; if the Go const drifted, the
autostart test (which already asserts the plist contents
written by `enableAutostart()`) would catch it. The two
build-time checks together cover both languages without
needing a shared constant source.

### "`currentAutostartPath()` cleanup"

Considered: the function returns `/usr/bin/open` for every
install under v12's `-b` change, breaking its prior
staleness-check purpose.

Rejected: implementation cleanup, already noted in v12
review. Implementer can remove or no-op as part of Stack 3.

### "Add a `Reinstall` button to the pre-flight dialog"

Considered: third button on the missing-binaries dialog that
re-runs the installer rather than just opening the download
page.

Rejected: scope creep. "Open download page" goes to
`download.fridayplatform.io` which serves the latest
installer. One extra click; not worth the dialog complexity.

## Unresolved questions

None. v14 is implementation-ready.

Verification items unchanged from v13 review.

## Overlap with v13

v14 keeps unchanged from v13:
- TLDR section structure
- All six problem statements, eight goals, four non-goals
- Cross-cutting `/api/launcher-health`, response-handling
  table, CAS gate, state machine
- Issues 1+2+3, 4, 5, 6 (unchanged except for migration
  step 3 + 9 + 4 + 6 + 7 path edits)
- Build sequence
- Stack 1/2/3 split

v14 changes from v13:
- Migration § step 3: capture `user_had_autostart` before
  unload
- Migration § step 4: glob sweep target
  `~/.friday/local/backup-*` instead of `/tmp/friday-app-backup-*`
- Migration § step 6: backup target
  `~/.friday/local/backup-<pid>`
- Migration § step 7: cleanup of `~/.friday/local/backup-<pid>`
- Migration § step 9: conditional re-register based on
  `user_had_autostart`
- §Test before shipping: backup-orphan test path updated;
  new positive + negative autostart-preference tests; legacy
  v12-era `.bak` test text updated for v14's new path
- Test matrix: pre-extract cleanup row updated for new path;
  new row for Decision #36 autostart preservation
- Decisions: #31 amended (per-user path), #36 added (autostart
  preservation)
- TLDR counts: 35 → 36 decisions, 14 risks unchanged

## Recommendation

**Stop reviewing the plan; start writing the code.** v14 is
the last useful /improving-plans output. After 13 review
passes, every platform-parity, failure-mode, implementer-
ambiguity, concurrency, LaunchServices-resolution, and
user-preference edge has been covered. Stack 1 (launcher
HTTP server + Issue 6) ships the highest-confidence fix
with the smallest blast radius; implementation should start
there.
