#!/usr/bin/env bash
#
# PR Code Review Pipeline — full lifecycle using curl
#
# Usage:
#   ./run-curl.sh https://github.com/owner/repo/pull/123
#
set -euo pipefail

DAEMON_URL="${ATLAS_DAEMON_URL:-http://localhost:8080}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PR_URL="${1:?Usage: $0 <github-pr-url>}"

echo "==> Checking daemon status..."
if ! curl -sf "$DAEMON_URL/health" > /dev/null 2>&1; then
  echo "Error: Atlas daemon is not running on $DAEMON_URL" >&2
  echo "Start it with: deno task atlas daemon start --detached" >&2
  exit 1
fi
echo "    Daemon is running."

# ── 1. Upload skill ──────────────────────────────────────────────────────────

echo ""
echo "==> Uploading skill @tempest/pr-code-review..."

SKILL_DIR="$SCRIPT_DIR/skill"
ARCHIVE=$(mktemp /tmp/pr-code-review-XXXXXX.tar.gz)
tar czf "$ARCHIVE" -C "$SKILL_DIR" .

SKILL_RESULT=$(curl -sf -X POST "$DAEMON_URL/api/skills/@tempest/pr-code-review/upload" \
  -F "archive=@$ARCHIVE" \
  -F "skillMd=$(cat "$SKILL_DIR/SKILL.md")" 2>&1) || {
  echo "    Warning: Skill upload failed (may already exist). Continuing..."
  SKILL_RESULT="{}"
}
rm -f "$ARCHIVE"

SKILL_VERSION=$(echo "$SKILL_RESULT" | jq -r '.published.version // "existing"')
echo "    Skill version: $SKILL_VERSION"

# ── 2. Register workspace ────────────────────────────────────────────────────

echo ""
echo "==> Registering workspace..."

WORKSPACE_RESULT=$(curl -sf -X POST "$DAEMON_URL/api/workspaces/add" \
  -H "Content-Type: application/json" \
  -d "{\"path\":\"$SCRIPT_DIR\"}")

WORKSPACE_ID=$(echo "$WORKSPACE_RESULT" | jq -r '.workspaces[0].id // .id // empty')

if [ -z "$WORKSPACE_ID" ]; then
  echo "Error: Failed to register workspace." >&2
  echo "Response: $WORKSPACE_RESULT" >&2
  exit 1
fi
echo "    Workspace ID: $WORKSPACE_ID"

# ── 3. Trigger PR review ─────────────────────────────────────────────────────

echo ""
echo "==> Triggering review for: $PR_URL"
echo "    Streaming events..."
echo ""

curl -sN -X POST "$DAEMON_URL/api/workspaces/$WORKSPACE_ID/signals/review-pr" \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d "{\"payload\":{\"pr_url\":\"$PR_URL\"}}" | while IFS= read -r line; do
  # Parse SSE data lines
  if [[ "$line" == data:* ]]; then
    DATA="${line#data: }"

    # End of stream
    if [ "$DATA" = "[DONE]" ]; then
      echo ""
      echo "==> Done."
      break
    fi

    # Extract event type and key fields
    TYPE=$(echo "$DATA" | jq -r '.type // empty')

    case "$TYPE" in
      data-fsm-action-execution)
        ACTION_TYPE=$(echo "$DATA" | jq -r '.data.actionType')
        ACTION_ID=$(echo "$DATA" | jq -r '.data.actionId')
        STATUS=$(echo "$DATA" | jq -r '.data.status')
        DURATION=$(echo "$DATA" | jq -r 'if .data.status == "completed" then " (\(.data.durationMs)ms)" else "" end')
        ERROR=$(echo "$DATA" | jq -r 'if .data.status == "failed" then " ERROR: \(.data.error // "")" else "" end')
        echo "    [$TYPE] ${ACTION_TYPE}:${ACTION_ID} ${STATUS}${DURATION}${ERROR}"
        ;;
      data-fsm-state-transition)
        FROM=$(echo "$DATA" | jq -r '.data.fromState')
        TO=$(echo "$DATA" | jq -r '.data.toState')
        echo "    [$TYPE] $FROM -> $TO"
        ;;
      data-tool-progress)
        CONTENT=$(echo "$DATA" | jq -r '.data.content // empty')
        if [ -n "$CONTENT" ]; then
          echo "    [tool] $CONTENT"
        fi
        ;;
      data-session-finish)
        STATUS=$(echo "$DATA" | jq -r '.data.status')
        echo ""
        echo "    Session finished: $STATUS"
        ;;
      job-error)
        ERROR=$(echo "$DATA" | jq -r '.data.error')
        echo "    ERROR: $ERROR" >&2
        ;;
    esac
  fi
done
