#!/bin/sh
set -e

args="--transport streamable-http"

if [ -n "$TOOL_TIER" ]; then
    args="$args --tool-tier $TOOL_TIER"
fi

if [ -n "$TOOLS" ]; then
    args="$args --tools $TOOLS"
fi

# PORT is read directly from environment by FastMCP, not via CLI arg
exec workspace-mcp $args "$@"
