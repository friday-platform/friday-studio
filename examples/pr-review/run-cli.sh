#!/usr/bin/env bash
#
# PR Code Review Pipeline — full lifecycle using Atlas CLI
#
# Usage:
#   ./run-cli.sh https://github.com/owner/repo/pull/123
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PR_URL="${1:?Usage: $0 <github-pr-url>}"

# Helper to run atlas CLI from repo root
atlas() {
  (cd "$REPO_ROOT" && deno task atlas "$@" 2>&1)
}

echo "==> Checking daemon status..."
if ! atlas daemon status | grep -q "running"; then
  echo "Error: Atlas daemon is not running." >&2
  echo "Start it with: deno task atlas daemon start --detached" >&2
  exit 1
fi
echo "    Daemon is running."

# ── 1. Upload skill ──────────────────────────────────────────────────────────

echo ""
echo "==> Publishing skill @tempest/pr-code-review..."

SKILL_RESULT=$(atlas skill publish -p "$SCRIPT_DIR/skill" -n @tempest/pr-code-review --json)
SKILL_VERSION=$(echo "$SKILL_RESULT" | jq -r '.published.version // "existing"')
echo "    Skill version: $SKILL_VERSION"

# ── 2. Register workspace ────────────────────────────────────────────────────

echo ""
echo "==> Registering workspace..."

WORKSPACE_RESULT=$(atlas workspace add -p "$SCRIPT_DIR" --json)
WORKSPACE_ID=$(echo "$WORKSPACE_RESULT" | jq -r '.results[0].id // empty')

if [ -z "$WORKSPACE_ID" ]; then
  echo "Error: Failed to parse workspace ID from CLI output." >&2
  echo "Output: $WORKSPACE_RESULT" >&2
  exit 1
fi
echo "    Workspace ID: $WORKSPACE_ID"

# ── 3. Trigger PR review ─────────────────────────────────────────────────────

echo ""
echo "==> Triggering review for: $PR_URL"
echo "    Streaming events..."
echo ""

atlas signal trigger -n review-pr \
  -w "$WORKSPACE_ID" \
  --stream \
  -d "{\"pr_url\":\"$PR_URL\"}"
