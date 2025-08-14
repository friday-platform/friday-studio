#!/bin/bash

# Atlas Memory Manager Runner Script
#
# This script provides an easy way to run the Atlas Memory Manager
# from anywhere in the Atlas repository.

set -e

# Get the script directory (where this script is located)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# No default workspace path - let the main.ts handle workspace selection
WORKSPACE_PATH=""

# Help function
show_help() {
    cat << EOF
Atlas Memory Manager - MECMF Edition

A terminal-based tool for navigating and managing Atlas workspace memory using 
the Memory-Enhanced Context Management Framework (MECMF).

USAGE:
    ./memory-manager.sh [OPTIONS] [WORKSPACE_PATH]

OPTIONS:
    -w, --workspace PATH     Specify workspace path (default: current directory)
    -s, --stats             Show memory statistics and exit
    -e, --export            Export all memory to JSON and exit
    -v, --validate          Validate memory data integrity and exit
    -h, --help              Show this help message

FEATURES:
    • MECMF Integration: Uses Atlas's advanced memory system
    • Vector Search: Semantic search for episodic and semantic memories
    • Workspace Isolation: Respects workspace boundaries
    • Real-time Sync: Direct integration with Atlas memory system

EXAMPLES:
    # Start interactive manager with workspace selection
    ./memory-manager.sh

    # Start interactive manager in specific directory
    ./memory-manager.sh --workspace /path/to/workspace

    # Show stats for current workspace
    ./memory-manager.sh --stats --workspace /path/to/workspace

    # Export memory from specific workspace
    ./memory-manager.sh --export --workspace /path/to/workspace > backup.json

    # Run from anywhere in Atlas repo (finds nearest workspace)
    cd /path/to/atlas/examples/workspaces/telephone
    /path/to/atlas/tools/memory_manager/memory-manager.sh --stats

SYSTEM REQUIREMENTS:
    • Deno runtime
    • Full system permissions (--allow-all) for ONNX runtime and embeddings
    • Network access for downloading embedding models (first run)

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

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        -w|--workspace)
            WORKSPACE_PATH="$2"
            shift 2
            ;;
        -s|--stats)
            STATS_MODE=true
            shift
            ;;
        -e|--export)
            EXPORT_MODE=true
            shift
            ;;
        -v|--validate)
            VALIDATE_MODE=true
            shift
            ;;
        *)
            # If it's a directory, treat it as workspace path
            if [[ -d "$1" ]]; then
                WORKSPACE_PATH="$1"
            fi
            shift
            ;;
    esac
done

# Look for workspace in current directory or parent directories if no workspace specified
find_workspace() {
    local current_dir="$1"
    while [[ "$current_dir" != "/" ]]; do
        if [[ -f "$current_dir/workspace.yml" ]] || [[ -d "$current_dir/.atlas" ]]; then
            echo "$current_dir"
            return 0
        fi
        current_dir="$(dirname "$current_dir")"
    done
    echo ""  # No workspace found
}

# If no workspace path provided and we're in stats/export/validate mode, try to find one
if [[ -z "$WORKSPACE_PATH" ]] && [[ "$STATS_MODE" == true || "$EXPORT_MODE" == true || "$VALIDATE_MODE" == true ]]; then
    DETECTED_WORKSPACE=$(find_workspace "$PWD")
    if [[ -n "$DETECTED_WORKSPACE" ]]; then
        echo "📁 Detected workspace: $DETECTED_WORKSPACE"
        WORKSPACE_PATH="$DETECTED_WORKSPACE"
    else
        echo "❌ No workspace found. Please specify a workspace path with --workspace"
        exit 1
    fi
fi

echo "🧠 Atlas Memory Manager - MECMF Edition"
if [[ -n "$WORKSPACE_PATH" ]]; then
    echo "📂 Workspace: $WORKSPACE_PATH"
else
    echo "📂 Starting workspace selection..."
fi

# Check if this is the first run (no model cache exists)
if [[ ! -d "$HOME/.atlas/memory/.cache" ]]; then
    echo "🔄 First run detected - MECMF will download embedding models (~200MB)"
    echo "⏳ This may take a few minutes on first startup..."
fi

# Run the Deno application with full permissions required for MECMF
# The MECMF system needs extensive permissions for:
# - FFI: ONNX runtime for embeddings
# - Net: Downloading embedding models
# - Env: Environment variable access
# - Sys: System information access

# Build arguments for main.ts
MAIN_ARGS=""
if [[ -n "$WORKSPACE_PATH" ]]; then
    MAIN_ARGS="$MAIN_ARGS --workspace $WORKSPACE_PATH"
fi
if [[ "$STATS_MODE" == true ]]; then
    MAIN_ARGS="$MAIN_ARGS --stats"
fi
if [[ "$EXPORT_MODE" == true ]]; then
    MAIN_ARGS="$MAIN_ARGS --export"
fi
if [[ "$VALIDATE_MODE" == true ]]; then
    MAIN_ARGS="$MAIN_ARGS --validate"
fi

exec deno run \
    --allow-all \
    "$SCRIPT_DIR/main.ts" \
    $MAIN_ARGS