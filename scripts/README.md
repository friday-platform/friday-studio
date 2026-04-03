# Platform Image Scripts

Scripts for building and managing the platform Docker image in Google Artifact Registry.

No Google Cloud credentials required — everything runs via GitHub Actions.

## Prerequisites

- [GitHub CLI](https://cli.github.com) (`gh`) installed and authenticated (`gh auth login`)
- Run scripts from the repo root

## `build-fast.sh` — Build a new platform image

Triggers a GitHub Action that builds `Dockerfile-platform` and pushes it to GAR
with an auto-incremented version tag (e.g. `0.0.17`).

```bash
./scripts/build-fast.sh            # dispatch and exit
./scripts/build-fast.sh --watch    # dispatch and stream logs until complete
```

The build does **not** set the `latest` tag — use `promote-latest.sh` to do
that explicitly after verifying the image works.

## `promote-latest.sh` — Move `latest` to a specific version

Triggers a GitHub Action that points the `latest` tag at an existing version.

```bash
./scripts/promote-latest.sh 0.0.16            # dispatch and exit
./scripts/promote-latest.sh 0.0.16 --watch    # dispatch and stream logs
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
