#!/bin/bash

echo "🚀 Starting all MCP servers..."

# Load environment variables
if [ -f "../.env" ]; then
    export $(grep -v '^#' ../.env | xargs) 2>/dev/null || true
    echo "✅ Environment variables loaded"
else
    echo "⚠️  .env file not found - some servers may have limited functionality"
fi

# List of MCP servers with their ports
SERVERS="github-mcp:3020 filesystem-mcp:3021 postgresql-mcp:3022 fetch-mcp:3023 slack-mcp:3024 memory-mcp:3025 aws-mcp:3026 circleci-mcp:3027 sentry-mcp:3028"

# Start each MCP server in background
for server_info in $SERVERS; do
    IFS=':' read -r server port <<< "$server_info"
    echo "🔄 Starting $server on port $port..."
    
    # Check if port is already in use
    if command -v lsof >/dev/null 2>&1 && lsof -i :$port >/dev/null 2>&1; then
        echo "⚠️  Port $port already in use, skipping $server"
        continue
    fi
    
    if [ -f "./start-${server}.sh" ]; then
        ./start-${server}.sh > "./logs/${server}.log" 2>&1 &
        SERVER_PID=$!
        echo "  └─ PID: $SERVER_PID"
        
        # Give server time to start
        sleep 2
        
        # Test if server started successfully
        if command -v curl >/dev/null 2>&1 && curl -s "http://localhost:$port/health" >/dev/null 2>&1; then
            echo "  ✅ $server started successfully"
        else
            echo "  ⚠️  $server may have failed to start (check logs/${server}.log)"
        fi
    else
        echo "  ❌ Startup script for $server not found"
    fi
done

echo ""
echo "✅ MCP server startup completed"
echo "📋 Check status: curl http://localhost:PORT/health"
echo "🛑 Stop all: ./stop-all-mcp.sh"
echo "📄 View logs: tail -f logs/*.log"
