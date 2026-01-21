#!/bin/bash
#
#  ╭─────────────────────────────────────────────────────────────────────────────╮
#  │   RALPH ONCE - Single iteration for HITL development                        │
#  ╰─────────────────────────────────────────────────────────────────────────────╯
#
set -e

# Colors - Amber CRT aesthetic
AMBER='\033[38;5;214m'
AMBER_DIM='\033[38;5;136m'
AMBER_BRIGHT='\033[38;5;220m'
BOLD='\033[1m'
RESET='\033[0m'

PRD_FILE="${PRD_FILE:-scripts/ralph/PRD.json}"
PROGRESS_FILE="${PROGRESS_FILE:-scripts/ralph/progress.txt}"
WIDTH=78

# Drawing
draw_box_top() { echo -e "${AMBER}╭$(printf '%.0s─' $(seq 1 $WIDTH))╮${RESET}"; }
draw_box_bottom() { echo -e "${AMBER}╰$(printf '%.0s─' $(seq 1 $WIDTH))╯${RESET}"; }
draw_box_separator() { echo -e "${AMBER}├$(printf '%.0s─' $(seq 1 $WIDTH))┤${RESET}"; }
draw_empty_line() { echo -e "${AMBER}│$(printf '%*s' $WIDTH '')│${RESET}"; }

draw_title() {
    local title="$1"
    local left_pad=$(( (WIDTH - ${#title}) / 2 ))
    local right_pad=$((WIDTH - ${#title} - left_pad))
    echo -e "${AMBER}│$(printf '%*s' $left_pad '')${BOLD}${AMBER_BRIGHT}${title}${RESET}${AMBER}$(printf '%*s' $right_pad '')│${RESET}"
}

draw_kv() {
    local key="$1" value="$2"
    local padding=$((WIDTH - 20 - ${#value} - 2))
    echo -e "${AMBER}│${RESET}  ${AMBER_DIM}${key}$(printf '%*s' $((20 - ${#key})) '')${RESET}${AMBER_BRIGHT}${value}${RESET}$(printf '%*s' $padding '')${AMBER}│${RESET}"
}

# Validation
if [[ ! -f "$PRD_FILE" ]]; then
    echo -e "${AMBER_BRIGHT}PRD not found: $PRD_FILE${RESET}"
    echo -e "${AMBER_DIM}Generate with: /ralph-prd docs/plans/your-design.md${RESET}"
    exit 1
fi
[[ ! -f "$PROGRESS_FILE" ]] && touch "$PROGRESS_FILE"

# Status
complete=$(grep -c '"passes": true' "$PRD_FILE" 2>/dev/null || echo "0")
incomplete=$(grep -c '"passes": false' "$PRD_FILE" 2>/dev/null || echo "0")
total=$((complete + incomplete))

echo ""
draw_box_top
draw_title "RALPH ONCE"
draw_title "Single iteration (HITL mode)"
draw_box_separator
draw_empty_line
draw_kv "TASKS" "${complete}/${total} complete"
draw_empty_line
draw_box_bottom
echo ""

# Run
claude --permission-mode acceptEdits "@$PRD_FILE" "@$PROGRESS_FILE" \
"Pick ONE incomplete task (passes: false) from the PRD.
Prioritize by: architectural > integration > standard > polish.

If task has tdd field:
  1. Write test from tdd.red
  2. Verify it FAILS
  3. Implement tdd.green
  4. Verify it PASSES
  5. Apply tdd.refactor if present

If no tdd field:
  1. Implement the task
  2. Run verification commands

Then:
  1. Set passes: true in PRD.json
  2. Commit with conventional message
  3. Append to progress.txt: timestamp, task-id, commit SHA, decisions/tuning

ONLY DO ONE TASK.
If all tasks complete, output <promise>COMPLETE</promise>."
