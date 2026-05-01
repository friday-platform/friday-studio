#!/usr/bin/env zsh
# Setup shell environment for Claude with auto task list from git branch
#
# Usage: Source this file in your .zshrc or run it to get the function:
#   source /path/to/setup_shell.zsh
#
# Then use `claude` normally - it will auto-set CLAUDE_CODE_TASK_LIST_ID
# to the current git branch (sanitized) and run in yolo mode.

function claude() {
    local branch
    branch=$(git branch --show-current 2>/dev/null)

    if [[ -n "$branch" ]]; then
        # Sanitize: replace / with -- and strip other special chars
        local safe_branch="${branch//\//--}"
        safe_branch="${safe_branch//[^a-zA-Z0-9_-]/}"
        export CLAUDE_CODE_TASK_LIST_ID="$safe_branch"
    fi

    command claude --dangerously-skip-permissions "$@"
}
