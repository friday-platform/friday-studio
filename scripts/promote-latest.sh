#!/usr/bin/env bash
set -euo pipefail

# Trigger the platform-promote-latest GitHub Action to move the 'latest'
# tag to a specific platform image version in Google Artifact Registry.
#
# Usage: ./scripts/promote-latest.sh <version-or-sha> [--watch]
#
# Arguments:
#   version-or-sha   A version tag (e.g. 0.0.16) or a full git SHA from main.
#                    Every build is tagged with both, so either works.
#
# Options:
#   --watch   Wait for the workflow run to complete and stream logs

if ! command -v gh &>/dev/null; then
  echo "Error: gh CLI is required. Install it from https://cli.github.com" >&2
  exit 1
fi

if ! gh auth status &>/dev/null; then
  echo "Error: not logged in. Run 'gh auth login' first." >&2
  exit 1
fi

REPO=$(gh repo view --json nameWithOwner --jq '.nameWithOwner' 2>/dev/null || true)
if [[ -z "$REPO" ]]; then
  echo "Error: could not determine GitHub repo. Run this from inside the git repo." >&2
  exit 1
fi

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: ./scripts/promote-latest.sh <version-or-sha> [--watch]" >&2
  echo "Examples:" >&2
  echo "  ./scripts/promote-latest.sh 0.0.16" >&2
  echo "  ./scripts/promote-latest.sh abc123def456..." >&2
  exit 1
fi

WATCH=false
if [[ "${2:-}" == "--watch" ]]; then
  WATCH=true
fi

echo "Promoting platform image ${VERSION} → latest"
gh workflow run platform-promote-latest.yml --repo "$REPO" --field "version=${VERSION}"

if [[ "$WATCH" == true ]]; then
  echo "Waiting for workflow run to appear..."
  sleep 3
  gh run watch --repo "$REPO" \
    "$(gh run list --repo "$REPO" --workflow=platform-promote-latest.yml --limit=1 --json databaseId --jq '.[0].databaseId')"
else
  echo "Workflow dispatched. View runs at: https://github.com/${REPO}/actions/workflows/platform-promote-latest.yml"
fi
