#!/bin/bash
# Block bare `deno check` — use `deno task typecheck` instead (includes svelte-check)
COMMAND=$(jq -r '.tool_input.command')

REASON="Use \`deno task typecheck\` instead of bare \`deno check\`. The task runs both deno check and svelte-check across workspace members."

if echo "$COMMAND" | grep -qE '(^|&&\s*|;\s*)deno check(\s|$)'; then
  jq -n --arg reason "$REASON" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: $reason
    }
  }'
fi
