# Review: split-studio-build-from-publish (round 2)

**Date:** 2026-05-04
**Branch:** split-studio-build-from-publish
**PR:** https://github.com/friday-platform/friday-studio/pull/185
**Verdict:** Clean

## Summary

Round 2 reviews commit `0d1e76219`, which addresses the two "Important"
findings from round 1: SHA verification at publish time, and a clock-skew
buffer for `find_new_run_id`. Both fixes are correct and complete. Three
minor follow-ups noted; none are blocking.

## Round-1 findings — status

- **Two unpublished builds collide on the same version** ✅ resolved.
  `studio-publish.yml:114-134` and `studio-installer-publish.yml:96-115`
  now `gsutil cat | shasum -a 256` each referenced object and compare to
  the manifest-entry SHA before flipping the manifest. The agent verified
  `set -euo pipefail` + pipefail propagates a subshell `exit 1` correctly,
  the python `\t` heredoc reaches python literally and emits a real tab,
  and `IFS=$'\t' read` splits as intended.
- **Clock-skew flakiness in `find_new_run_id`** ✅ resolved.
  New `buffered_since` helper at `scripts/studio-release.sh:77-80` is
  portable across BSD/GNU `date` and is wired into both `cmd_build` and
  `cmd_publish` (lines 118-119, 233-234). Verified locally: helper output
  is exactly 60s in the past.

## Critical

None.

## Important

### `::error::` on stderr won't render as a GitHub annotation

**Location:** `studio-publish.yml:132`, `studio-installer-publish.yml:112`
**Problem:** `echo "::error::… " >&2` routes the workflow-command line to
stderr, but GitHub Actions only parses workflow commands from stdout. The
step still fails (because the surrounding `exit 1` is intact), and the
message still appears in the raw log — but the nice red annotation on the
Actions UI summary is lost. Confirmed against
`github/docs/content/actions/reference/workflows-and-actions/workflow-commands.md:59`:
"these commands are then sent to the runner over `stdout`."
**Recommendation:** Drop `>&2` on the `::error::` lines. (You can keep
`>&2` for any companion human-readable hint, but the `::error::` line
itself needs to go to stdout.)

**Worth doing: Yes** — one-line fix per file, restores the visible
annotation that's the whole point of using the `::error::` form.

## Tests

No test files in diff. Acceptable for the same reasons as round 1: this is
CI infrastructure, exercised by running the workflows. The verify step
itself is now the runtime guard.

## Needs Decision

1. **Re-download every tarball just to hash it.** `gsutil cat | shasum`
   pulls the full object through the runner — ~1 GB cumulative per studio
   publish (2 platforms × ~500 MB), ~100–300 MB per installer publish.
   `studio-build.yml:284-288` already uploads a `.sha256` sidecar next to
   each studio tarball; fetching the sidecar instead is a few-dozen-byte
   read with the same race-detection guarantee (a colliding build
   overwrites both tarball and sidecar in lockstep). Installer build does
   NOT upload sidecars — switching the path would be studio-only and
   asymmetric. **Suggested: leave the uniform `cat|shasum` path. The cost
   is real but tiny (~$0.12/publish range) and a uniform verify path is
   easier to reason about than two shapes.**

2. **`buffered_since` empty-output behavior on exotic shells.** If both
   BSD `-v-1M` and GNU `-d '1 minute ago'` fail (e.g., busybox), the
   function emits empty stdout and exits non-zero. Because the call sites
   use the split `local since` / `since=$(...)` form, `set -e` aborts
   cleanly there — but if anyone later refactors to
   `local since=$(buffered_since)` on one line, `set -e` is masked
   (well-known bash quirk). **Suggested: skip — both call sites are
   correct today, and busybox isn't a target environment. Optional: add
   a one-line comment at the call sites locking in the split form.**

## Confirmed correct in round 2

- Pipefail propagates through `python3 -c '…' | while … done` despite
  the subshell — `exit 1` from inside the loop kills the step.
- The `\t` heredoc reaches python as a literal `\t`, python emits a real
  TAB, and `IFS=$'\t' read` splits on it.
- `buffered_since` BSD-first / GNU-fallback is correct on both macOS and
  Linux (BSD silently rejects unknown flags differently than GNU; the
  `||` only fires when the BSD form errors).
- The verify-step block comments accurately describe what the code does.
- No collateral damage to the manifest-composition python — only the
  verify step's printer changed.
