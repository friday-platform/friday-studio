#!/bin/bash

# Atlas Memory Manager Runner Script
#
# This script provides an easy way to run the Atlas Memory Manager
# from anywhere in the Atlas repository.

set -e

# Get the script directory (where this script is located)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Default to current directory as workspace
WORKSPACE_PATH="${PWD}"

# Help function
show_help() {
    cat << EOF
Atlas Memory Manager

USAGE:
    ./memory-manager.sh [OPTIONS] [WORKSPACE_PATH]

OPTIONS:
    -w, --workspace PATH     Specify workspace path (default: current directory)
    -s, --stats             Show memory statistics and exit
    -e, --export            Export all memory to JSON and exit
    -v, --validate          Validate memory data integrity and exit
    -h, --help              Show this help message

EXAMPLES:
    # Start interactive manager in current directory
    ./memory-manager.sh

    # Show stats for current workspace
    ./memory-manager.sh --stats

    # Export memory from specific workspace
    ./memory-manager.sh --export --workspace /path/to/workspace > backup.json

    # Run from anywhere in Atlas repo (finds nearest workspace)
    cd /path/to/atlas/examples/workspaces/telephone
    /path/to/atlas/tools/memory_manager/memory-manager.sh --stats

EOF
}

# Check for help flag early
for arg in "$@"; do
    if [[ "$arg" == "--help" ]] || [[ "$arg" == "-h" ]]; then
        show_help
        exit 0
    fi
done

# Check if we have deno
if ! command -v deno &> /dev/null; then
    echo "Error: Deno is required but not found in PATH"
    echo "Please install Deno: https://deno.land/manual/getting_started/installation"
    exit 1
fi

# If a workspace path is provided as the last argument (and it's a directory), use it
if [[ $# -gt 0 ]] && [[ -d "${!#}" ]]; then
    WORKSPACE_PATH="${!#}"
fi

# Look for workspace in current directory or parent directories
find_workspace() {
    local current_dir="$1"
    while [[ "$current_dir" != "/" ]]; do
        if [[ -f "$current_dir/workspace.yml" ]] || [[ -d "$current_dir/.atlas" ]]; then
            echo "$current_dir"
            return 0
        fi
        current_dir="$(dirname "$current_dir")"
    done
    echo "$WORKSPACE_PATH"  # Fallback to provided/current path
}

# If current directory doesn't look like a workspace, try to find one
if [[ ! -f "$WORKSPACE_PATH/workspace.yml" ]] && [[ ! -d "$WORKSPACE_PATH/.atlas" ]]; then
    DETECTED_WORKSPACE=$(find_workspace "$WORKSPACE_PATH")
    if [[ "$DETECTED_WORKSPACE" != "$WORKSPACE_PATH" ]]; then
        echo "📁 Detected workspace: $DETECTED_WORKSPACE"
        WORKSPACE_PATH="$DETECTED_WORKSPACE"
    fi
fi

echo "🧠 Atlas Memory Manager"
echo "📂 Workspace: $WORKSPACE_PATH"

# Run the Deno application with the workspace path
exec deno run \
    --allow-read \
    --allow-write \
    "$SCRIPT_DIR/main.ts" \
    --workspace "$WORKSPACE_PATH" \
    "$@"