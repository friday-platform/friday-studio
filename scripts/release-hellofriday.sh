#!/usr/bin/env bash
set -euo pipefail

# Bump the latest semver tag's patch version and create a new tag + GitHub release.
# Usage: ./scripts/bump-version.sh [--dry-run]

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI is required. Install it from https://cli.github.com" >&2
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "Error: not logged in. Run 'gh auth login' first." >&2
  exit 1
fi

# Derive repo from git remote so we don't depend on gh repo set-default
REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
if [[ -z "$REPO" ]]; then
  echo "Error: could not determine GitHub repo. Run this from inside the git repo." >&2
  exit 1
fi

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
fi

# Get the latest release tag from GitHub (source of truth)
LATEST_TAG=$(gh release view --repo "$REPO" --json tagName --jq '.tagName' 2>/dev/null || true)

if [[ -z "$LATEST_TAG" ]]; then
  echo "No existing GitHub release found. Starting at v1.0.0"
  LATEST_TAG="(none)"
  MAJOR=1 MINOR=0 PATCH=-1
else
  VERSION="${LATEST_TAG#v}"
  IFS='.' read -r MAJOR MINOR PATCH <<< "$VERSION"
fi

NEW_PATCH=$((PATCH + 1))
NEW_TAG="v${MAJOR}.${MINOR}.${NEW_PATCH}"

echo "Current tag: ${LATEST_TAG}"
echo "New tag:     ${NEW_TAG}"

if [[ "$DRY_RUN" == true ]]; then
  echo "(dry run — no tag or release created)"
  exit 0
fi

gh release create "$NEW_TAG" --repo "$REPO" --title "$NEW_TAG" --generate-notes
echo "GitHub release ${NEW_TAG} created."
