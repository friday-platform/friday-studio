# Scripts

Scripts for building and releasing FAST images and HelloFriday.

No Google Cloud credentials required — everything runs via GitHub Actions.

## Prerequisites

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth login`)
- Run scripts from the repo root

## FAST Image

### `build-fast.sh` — Build a new FAST image

Triggers a GitHub Action that builds `Dockerfile` and pushes it to GAR
with an auto-incremented version tag (e.g. `0.0.17`).

```bash
./scripts/build-fast.sh            # dispatch and exit
./scripts/build-fast.sh --watch    # dispatch and stream logs until complete
```

The build does **not** set the `latest` tag — use `promote-latest.sh` to do
that explicitly after verifying the image works.

### `promote-latest.sh` — Move `latest` to a specific version

Triggers a GitHub Action that points the `latest` tag at an existing version.
Accepts either a version tag or a full git SHA (every build is tagged with both).

```bash
./scripts/promote-latest.sh 0.0.16            # by version
./scripts/promote-latest.sh 0.0.16 --watch    # by version, stream logs
./scripts/promote-latest.sh abc123def456...   # by git SHA from main
```

### Typical workflow

```bash
# 1. Build a new image
./scripts/build-fast.sh --watch
# → output shows new version, e.g. 0.0.17

# 2. Test / verify the new image

# 3. Promote it to latest
./scripts/promote-latest.sh 0.0.17
```

## Studio + Studio Installer

Build and release are split: building only uploads versioned artifacts to GCS;
publishing rewrites `manifest.json` (the pointer clients resolve to find the
current version). This lets you smoke-test a build before promoting it.

### `studio-release.sh` — Build or publish studio / installer

One script for both pieces (studio = the daemon tarball, installer = the
Tauri-wrapped DMG/EXE) and both phases (build, publish).

```bash
# Build (uploads versioned artifacts; manifest stays unchanged)
./scripts/studio-release.sh build studio --watch
./scripts/studio-release.sh build installer --watch

# Publish (rewrites manifest.json → clients pick up the new version)
./scripts/studio-release.sh publish studio              # latest successful build
./scripts/studio-release.sh publish installer           # ditto
./scripts/studio-release.sh publish studio 1234567890   # specific run id
```

`build` accepts `--ref BRANCH` to build from a non-default branch and `--watch`
to block until the run completes (and print the matching `publish` command).

`publish` with no run id picks the most recent successful build of that kind,
auto-derives the version from the build's manifest-entry artifacts, and asks
for confirmation before flipping the manifest. Build artifacts are kept 30d,
so a build stays publishable for a month after it ran.

### Typical workflow

```bash
# 1. Build a new studio version
./scripts/studio-release.sh build studio --watch
# → uploads to gs://…/studio/friday-studio_X.Y.Z_<target>.tar.zst
#   manifest.json still points at the previous version

# 2. Smoke-test by downloading the versioned tarball directly:
#    https://download.fridayplatform.io/studio/friday-studio_X.Y.Z_<target>.tar.zst

# 3. Promote it to clients
./scripts/studio-release.sh publish studio
# → confirms version + run, then rewrites studio/manifest.json
```

The installer pair (`build installer` / `publish installer`) is identical, but
operates on `gs://…/installer/` and the Tauri DMG/EXE bundles.

### Underlying workflows

- `studio-build.yml` / `studio-installer-build.yml` — build, sign, notarize,
  upload versioned artifacts to GCS. Never touch `manifest.json`.
- `studio-publish.yml` / `studio-installer-publish.yml` — take a build run id
  + version, pull that run's manifest entries via `actions/download-artifact`,
  verify every referenced URL exists in GCS, then upload the new manifest.

You can dispatch them directly with `gh workflow run` if you need to, but the
script is the supported path.

## HelloFriday

### `release-hellofriday.sh` — Cut a new HelloFriday release

Bumps the latest semver tag's patch version and creates a GitHub release with
auto-generated notes.

```bash
./scripts/release-hellofriday.sh              # create release
./scripts/release-hellofriday.sh --dry-run    # preview without creating
```

**Note:** A release may require additional steps such as database migrations.
Check the release notes for any manual actions before deploying.
