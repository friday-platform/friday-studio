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
