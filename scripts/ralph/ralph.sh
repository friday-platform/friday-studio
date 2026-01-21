#!/bin/bash
#
#  ╭─────────────────────────────────────────────────────────────────────────────╮
#  │   RALPH - Autonomous PRD Execution Loop                                     │
#  ╰─────────────────────────────────────────────────────────────────────────────╯
#
set -e

# ─────────────────────────────────────────────────────────────────────────────────
# Colors - Amber CRT aesthetic
# ─────────────────────────────────────────────────────────────────────────────────
AMBER='\033[38;5;214m'
AMBER_DIM='\033[38;5;136m'
AMBER_BRIGHT='\033[38;5;220m'
BOLD='\033[1m'
DIM='\033[2m'
RESET='\033[0m'

# ─────────────────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────────────────
PRD_FILE="${PRD_FILE:-scripts/ralph/PRD.json}"
PROGRESS_FILE="${PROGRESS_FILE:-scripts/ralph/progress.txt}"
PROMPT_FILE="${PROMPT_FILE:-}"
WIDTH=78

# ─────────────────────────────────────────────────────────────────────────────────
# Drawing functions
# ─────────────────────────────────────────────────────────────────────────────────
draw_scanlines() {
    echo -e "${AMBER_DIM}"
    printf '┌'
    printf '%.0s─' $(seq 1 $WIDTH)
    printf '┐\n'
    printf '│'
    for ((i=0; i<WIDTH; i++)); do printf '▌'; done
    printf '│\n'
    printf '└'
    printf '%.0s─' $(seq 1 $WIDTH)
    printf '┘\n'
    echo -e "${RESET}"
}

draw_box_top() {
    echo -e "${AMBER}╭$(printf '%.0s─' $(seq 1 $WIDTH))╮${RESET}"
}

draw_box_bottom() {
    echo -e "${AMBER}╰$(printf '%.0s─' $(seq 1 $WIDTH))╯${RESET}"
}

draw_box_separator() {
    echo -e "${AMBER}├$(printf '%.0s─' $(seq 1 $WIDTH))┤${RESET}"
}

draw_box_line() {
    local text="$1"
    local text_len=${#text}
    local padding=$((WIDTH - text_len - 1))
    [[ $padding -lt 0 ]] && padding=0
    echo -e "${AMBER}│${RESET} ${AMBER_BRIGHT}${text}${RESET}$(printf '%*s' $padding '')${AMBER}│${RESET}"
}

draw_box_line_dim() {
    local text="$1"
    local text_len=${#text}
    local padding=$((WIDTH - text_len - 2))
    [[ $padding -lt 0 ]] && padding=0
    echo -e "${AMBER}│${RESET}  ${AMBER_DIM}${text}${RESET}$(printf '%*s' $padding '')${AMBER}│${RESET}"
}

draw_empty_line() {
    echo -e "${AMBER}│$(printf '%*s' $WIDTH '')│${RESET}"
}

draw_title() {
    local title="$1"
    local title_len=${#title}
    local left_pad=$(( (WIDTH - title_len) / 2 ))
    local right_pad=$((WIDTH - title_len - left_pad))
    echo -e "${AMBER}│$(printf '%*s' $left_pad '')${BOLD}${AMBER_BRIGHT}${title}${RESET}${AMBER}$(printf '%*s' $right_pad '')│${RESET}"
}

draw_progress_bar() {
    local current=$1
    local total=$2
    local label="$3"
    local bar_width=$((WIDTH - 2))

    if [[ $total -eq 0 ]]; then
        return
    fi

    local filled=$((current * bar_width / total))
    local empty=$((bar_width - filled))
    local percent=$((current * 100 / total))

    local bar=""
    local j
    for ((j=0; j<filled; j++)); do bar+="="; done
    for ((j=0; j<empty; j++)); do bar+="-"; done

    local stats="${current} / ${total} tasks"
    local line="${label}$(printf '%*s' $((20 - ${#label})) '')${stats}"
    local line_len=${#line}

    echo -e "${AMBER}│${RESET}  ${AMBER_BRIGHT}${label}${RESET}$(printf '%*s' $((18 - ${#label})) '')${AMBER_DIM}${stats}${RESET}$(printf '%*s' $((WIDTH - 20 - ${#stats})) '')${AMBER}│${RESET}"
    echo -e "${AMBER}│${RESET}  ${AMBER_BRIGHT}${bar}${RESET}${AMBER}│${RESET}"
}

draw_kv() {
    local key="$1"
    local value="$2"
    local key_width=20
    local value_len=${#value}
    local padding=$((WIDTH - key_width - value_len - 2))
    echo -e "${AMBER}│${RESET}  ${AMBER_DIM}${key}$(printf '%*s' $((key_width - ${#key})) '')${RESET}${AMBER_BRIGHT}${value}${RESET}$(printf '%*s' $padding '')${AMBER}│${RESET}"
}

# ─────────────────────────────────────────────────────────────────────────────────
# Data functions
# ─────────────────────────────────────────────────────────────────────────────────
get_incomplete_count() {
    if [[ -f "$PRD_FILE" ]]; then
        local count
        count=$(grep -c '"passes": false' "$PRD_FILE" 2>/dev/null) || count=0
        echo "$count"
    else
        echo "0"
    fi
}

get_complete_count() {
    if [[ -f "$PRD_FILE" ]]; then
        local count
        count=$(grep -c '"passes": true' "$PRD_FILE" 2>/dev/null) || count=0
        echo "$count"
    else
        echo "0"
    fi
}

get_prd_title() {
    if [[ -f "$PRD_FILE" ]]; then
        grep -o '"title": *"[^"]*"' "$PRD_FILE" 2>/dev/null | head -1 | sed 's/"title": *"\([^"]*\)"/\1/' || echo "Unknown"
    else
        echo "Unknown"
    fi
}

# ─────────────────────────────────────────────────────────────────────────────────
# Usage
# ─────────────────────────────────────────────────────────────────────────────────
usage() {
    local script_name=$(basename "$0")
    echo ""
    draw_scanlines
    draw_box_top
    draw_title "RALPH LOOP"
    draw_box_separator
    draw_empty_line
    draw_box_line "Usage: ${script_name} <iterations> [options]"
    draw_empty_line
    draw_box_line "Options:"
    draw_box_line_dim "  --prd FILE       Path to PRD.json"
    draw_box_line_dim "  --progress FILE  Path to progress.txt"
    draw_box_line_dim "  --prompt FILE    Path to custom prompt file"
    draw_empty_line
    draw_box_line "Examples:"
    draw_box_line_dim "  ${script_name} 5        Run 5 iterations (HITL)"
    draw_box_line_dim "  ${script_name} 20       Run 20 iterations (AFK)"
    draw_empty_line
    draw_box_bottom
    echo ""
    exit 1
}

# ─────────────────────────────────────────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────────────────────────────────────────
ITERATIONS=""

while [[ $# -gt 0 ]]; do
    case $1 in
        --prd)
            PRD_FILE="$2"
            shift 2
            ;;
        --progress)
            PROGRESS_FILE="$2"
            shift 2
            ;;
        --prompt)
            PROMPT_FILE="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            if [[ -z "$ITERATIONS" ]]; then
                ITERATIONS="$1"
            fi
            shift
            ;;
    esac
done

if [[ -z "$ITERATIONS" ]]; then
    usage
fi

# ─────────────────────────────────────────────────────────────────────────────────
# Validation
# ─────────────────────────────────────────────────────────────────────────────────
if [[ ! -f "$PRD_FILE" ]]; then
    echo ""
    draw_scanlines
    draw_box_top
    draw_title "ERROR"
    draw_box_separator
    draw_empty_line
    draw_box_line "PRD file not found: $PRD_FILE"
    draw_empty_line
    draw_box_line_dim "Generate a PRD first with:"
    draw_box_line_dim "  /ralph-prd docs/plans/your-design.md"
    draw_empty_line
    draw_box_bottom
    echo ""
    exit 1
fi

[[ ! -f "$PROGRESS_FILE" ]] && touch "$PROGRESS_FILE"

# ─────────────────────────────────────────────────────────────────────────────────
# The Prompt
# ─────────────────────────────────────────────────────────────────────────────────
if [[ -n "$PROMPT_FILE" ]]; then
    if [[ ! -f "$PROMPT_FILE" ]]; then
        echo ""
        draw_scanlines
        draw_box_top
        draw_title "ERROR"
        draw_box_separator
        draw_empty_line
        draw_box_line "Prompt file not found: $PROMPT_FILE"
        draw_empty_line
        draw_box_bottom
        echo ""
        exit 1
    fi
    RALPH_PROMPT=$(cat "$PROMPT_FILE")
else
    read -r -d '' RALPH_PROMPT << 'PROMPT' || true
@scripts/ralph/PRD.json @scripts/ralph/progress.txt

╭─────────────────────────────────────────────────────────────────────────────╮
│  RALPH LOOP - Autonomous PRD Execution                                      │
╰─────────────────────────────────────────────────────────────────────────────╯

⚠️  CRITICAL: COMPLETE EXACTLY ONE TASK, THEN STOP. NOT TWO. NOT THREE. ONE.

TASK SELECTION:
  1. Read PRD.json - find tasks where passes: false
  2. Choose the task YOU judge most important based on:
     • Architectural decisions and core abstractions (highest priority)
     • Integration points between modules
     • Unknown unknowns and spike work
     • Standard features and implementation
     • Polish, cleanup, and quick wins (lowest priority)

EXECUTION:
  If task has tdd field:
    1. Write the test described in tdd.red
    2. Run verification commands - confirm test FAILS for the right reason
    3. Implement tdd.green - minimal code to pass
    4. Run verification commands - confirm test PASSES
    5. Apply tdd.refactor if present

  If task has no tdd field:
    1. Implement the task
    2. Run all verification commands

COMPLETION:
  1. Verify all acceptanceCriteria are met
  2. Set passes: true for this task in PRD.json
  3. Commit with conventional commit message
  4. Append to progress.txt:

     ## <timestamp> - <task-id>
     Commit: <sha> (<commit message>)

     Decision: <if you made a non-obvious choice>
     Tuning: <if you noticed something to improve for future iterations>

     ---

  5. STOP. You are done. Do not start another task.

RULES:
  • ONE TASK ONLY. After committing, you are DONE. Do not continue to another task.
  • Run feedback loops (deno check, deno lint, tests) before committing
  • Do NOT commit if any verification fails - fix first
  • If all tasks pass AND scope.successCriteria verified:
    output <promise>COMPLETE</promise>
PROMPT
fi

# ─────────────────────────────────────────────────────────────────────────────────
# Display header
# ─────────────────────────────────────────────────────────────────────────────────
clear
draw_scanlines
draw_box_top
draw_title "RALPH LOOP"
draw_title "$(get_prd_title)"
draw_box_separator
draw_empty_line

complete=$(get_complete_count)
incomplete=$(get_incomplete_count)
total=$((complete + incomplete))

draw_kv "PRD" "$PRD_FILE"
draw_kv "PROGRESS" "$PROGRESS_FILE"
[[ -n "$PROMPT_FILE" ]] && draw_kv "PROMPT" "$PROMPT_FILE"
draw_kv "ITERATIONS" "$ITERATIONS"
draw_empty_line
draw_box_separator
draw_empty_line
draw_progress_bar "$complete" "$total" "TASKS"
draw_empty_line
draw_box_bottom
echo ""

START_TIME=$(date +%s)

# ─────────────────────────────────────────────────────────────────────────────────
# Main loop
# ─────────────────────────────────────────────────────────────────────────────────
for ((i=1; i<=ITERATIONS; i++)); do
    complete=$(get_complete_count)
    incomplete=$(get_incomplete_count)
    total=$((complete + incomplete))

    echo ""
    draw_box_top
    draw_title "ITERATION ${i} / ${ITERATIONS}"
    draw_box_separator
    draw_empty_line
    draw_progress_bar "$complete" "$total" "PROGRESS"
    draw_empty_line
    draw_box_line_dim "Starting Claude Code..."
    draw_empty_line
    draw_box_bottom
    echo ""

    # Run Claude
    result=$(claude --dangerously-skip-permissions --model opus -p "$RALPH_PROMPT" 2>&1) || true

    echo "$result"

    # Check for completion
    if [[ "$result" == *"<promise>COMPLETE</promise>"* ]]; then
        END_TIME=$(date +%s)
        DURATION=$((END_TIME - START_TIME))
        MINS=$((DURATION / 60))
        SECS=$((DURATION % 60))

        complete=$(get_complete_count)
        total=$((complete + $(get_incomplete_count)))

        echo ""
        draw_scanlines
        draw_box_top
        draw_title "PRD COMPLETE"
        draw_box_separator
        draw_empty_line
        draw_progress_bar "$complete" "$total" "FINAL"
        draw_empty_line
        draw_box_separator
        draw_empty_line
        draw_kv "ITERATIONS" "$i"
        draw_kv "DURATION" "${MINS}m ${SECS}s"
        draw_empty_line
        draw_box_bottom
        echo ""
        exit 0
    fi

    # Brief pause between iterations
    if [[ $i -lt $ITERATIONS ]]; then
        sleep 2
    fi
done

# ─────────────────────────────────────────────────────────────────────────────────
# Loop finished without completion
# ─────────────────────────────────────────────────────────────────────────────────
END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))
MINS=$((DURATION / 60))
SECS=$((DURATION % 60))

complete=$(get_complete_count)
total=$((complete + $(get_incomplete_count)))

echo ""
draw_scanlines
draw_box_top
draw_title "ITERATIONS EXHAUSTED"
draw_box_separator
draw_empty_line
draw_progress_bar "$complete" "$total" "PROGRESS"
draw_empty_line
draw_box_separator
draw_empty_line
draw_kv "COMPLETED" "${ITERATIONS} iterations"
draw_kv "DURATION" "${MINS}m ${SECS}s"
draw_empty_line
draw_box_line_dim "To continue: $(basename $0) <more-iterations>"
draw_empty_line
draw_box_bottom
echo ""
