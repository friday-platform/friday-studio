#!/usr/bin/env bash
set -euo pipefail

# Trigger the platform-docker GitHub Action to build and publish a new
# Dockerfile-platform image to Google Artifact Registry.
#
# Usage: ./scripts/build-platform.sh [--watch]
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

BRANCH=$(git rev-parse --abbrev-ref HEAD)

WATCH=false
if [[ "${1:-}" == "--watch" ]]; then
  WATCH=true
fi

echo "Triggering platform-docker workflow on branch: ${BRANCH}"
gh workflow run platform-docker.yml --repo "$REPO" --ref "$BRANCH"

if [[ "$WATCH" == true ]]; then
  echo "Waiting for workflow run to appear..."
  sleep 3
  gh run watch --repo "$REPO" \
    "$(gh run list --repo "$REPO" --workflow=platform-docker.yml --branch="$BRANCH" --limit=1 --json databaseId --jq '.[0].databaseId')"
else
  echo "Workflow dispatched. View runs at: https://github.com/${REPO}/actions/workflows/platform-docker.yml"
fi
