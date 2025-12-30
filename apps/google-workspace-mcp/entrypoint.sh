#!/bin/sh
set -e

args="--transport streamable-http"

if [ -n "$TOOL_TIER" ]; then
    args="$args --tool-tier $TOOL_TIER"
fi

if [ -n "$TOOLS" ]; then
    args="$args --tools $TOOLS"
fi

if [ -n "$PORT" ]; then
    args="$args --port $PORT"
fi

exec workspace-mcp $args "$@"
