#!/bin/bash

echo "🔍 Checking MCP server health..."

SERVERS="github-mcp:3020 filesystem-mcp:3021 postgresql-mcp:3022 fetch-mcp:3023 slack-mcp:3024 memory-mcp:3025 aws-mcp:3026 circleci-mcp:3027 sentry-mcp:3028"

for server_info in $SERVERS; do
    IFS=':' read -r server port <<< "$server_info"
    printf "%-20s " "$server:"
    
    if curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
        echo "✅ Healthy (port $port)"
    else
        echo "❌ Not responding (port $port)"
    fi
done
