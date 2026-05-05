# Review: split-studio-build-from-publish

**Date:** 2026-05-04
**Branch:** split-studio-build-from-publish
**PR:** https://github.com/friday-platform/friday-studio/pull/185
**Verdict:** Clean

## Summary

Splits `studio-build.yml` and `studio-installer-build.yml` so they only upload
versioned artifacts; new `studio-publish.yml` and `studio-installer-publish.yml`
promote a build by run id + version; new `scripts/studio-release.sh` wraps both
phases. Approach is sound — action versions, permissions, and the
sign → notarize → SHA → entry-artifact ordering all check out. One real risk
worth addressing (concurrent unpublished builds can collide on version), plus
a couple of cheap script polish items.

## Critical

None.

## Important

### Two unpublished builds can collide on the same version

**Location:** `.github/workflows/studio-build.yml:30-47` (version job derives
next version from the *published* manifest, not from existing GCS objects).
**Problem:** If two builds run while v0.0.9 is published, both compute v0.0.10
and write to the same `gs://…/friday-studio_0.0.10_<target>.tar.zst`. The
second overwrites the first. If you then `publish <run-A-id>`, the
`gsutil stat` existence check in `studio-publish.yml:106-113` passes — but the
SHAs in run A's manifest entries no longer match the bytes that are now in GCS.
Clients fail signature verification on download.
**Recommendation:** Either re-hash the GCS object in the publish workflow and
compare to the manifest-entry SHA (cheaper, catches the failure at promote
time where it actually matters), or have the build's version job fail if
`gs://…/friday-studio_<NEXT>_*` already exists, forcing the second build to
bump again. Hash check is the simpler add — one extra `gsutil cat | shasum`
per platform in the verify step.

**Worth doing: Yes** — low cost, real failure mode (two devs trigger builds
on the same day, common pattern). Not blocking, but the next merge after this
should add it.

### Clock-skew flakiness in `find_new_run_id`

**Location:** `scripts/studio-release.sh:114-115, 199-200`
**Problem:** `since` is `date -u` on the dev's laptop. If laptop clock is
ahead of GitHub's by even a few seconds, no run satisfies `createdAt >= since`
and the script gives up after 20s while the GitHub run is fine. Users see a
spurious "Could not find new run" error.
**Recommendation:** Subtract a 60s buffer (`date -u -v-1M` on macOS,
`date -u -d '1 minute ago'` on Linux). One-line fix.

**Worth doing: Yes** — trivial cost, removes a real-world source of confusion
the first time someone hits clock drift on a fresh laptop.

## Tests

No test files in diff. Acceptable for this change: workflows are exercised by
running them, and the publish workflow's `gsutil stat` + version cross-check
plus the script's preflights act as runtime guards. The PR's checklist-style
test plan in the description covers manual verification.

## Needs Decision

1. **Hostname-stripping in publish workflows.**
   `obj="gs://${GCS_BUCKET}/${url#https://download.fridayplatform.io/}"`
   (`studio-publish.yml:108`, `studio-installer-publish.yml:84`) silently
   no-ops if the URL prefix ever changes (new CDN, staging bucket), producing
   a malformed `gs://` path and a confusing 404. Add a guard
   `[[ "$url" == https://download.fridayplatform.io/* ]] || exit 1`, or accept
   the risk since the prefix is hard-coded in one place. **Suggested: skip
   unless a CDN change is on the roadmap.**

2. **Concurrent `gh workflow run` from two devs.** `find_new_run_id` filters
   only by time, not by actor. If a teammate dispatches the same workflow in
   the polling window, the script may print their run's URL. Build itself is
   fine; only the printed `publish` hint would be wrong. Add `--user "@me"`
   if this is a realistic concern. **Suggested: skip — single-author repo in
   practice; failure mode is benign (wrong URL, easy to recover).**

3. **Reusable workflow for the two publish files.** ~110 lines each, ~90%
   overlap. The asymmetric entry-JSON shapes (studio: `{platform: {…}}`;
   installer: `{…}`) and the studio-only platform-presence sanity check would
   require conditionals in a `workflow_call`-shared workflow, which costs more
   than the duplication saves. **Suggested: leave split.**

4. **Pre-release version suffixes (`0.0.10-rc1`).** Both
   `scripts/studio-release.sh:142` regex and the `_{version}_` cross-check in
   the publish workflows assume bare semver. Currently the build job hard-codes
   plain semver so this is moot. If suffixes are ever introduced, expand the
   regex to `_([0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.]+)?)_`. **Suggested: skip
   until needed.**

## Confirmed correct

- `actions/download-artifact@v8` cross-run download via `run-id` +
  `github-token` is real (since v4).
- `permissions: actions: read` is set on the publish workflows where it's
  needed for cross-run artifact reads; `id-token: write` retained for GCP WIF.
- `::notice::` bare form is valid (verified against
  `github/docs/content/actions/reference/workflows-and-actions/workflow-commands.md:142`
  earlier in the session).
- SHA-after-notarize ordering: `studio-build.yml:251-260` recomputes SHA after
  the notarized re-tar and only then writes the manifest-entry JSON, so the
  entry SHA matches the bytes uploaded to GCS.
- The defense-in-depth GCS-existence check is worth keeping — accidental
  `gsutil rm` and lifecycle policies are realistic.
- Migration concern (callers expecting auto-publish after build) is a non-issue
  per PR description: workflows are dispatch-only, no cron/CI consumers.
