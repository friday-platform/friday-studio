#!/bin/bash

echo "🛑 Stopping all MCP servers..."

# Kill by port
for port in 3020 3021 3022 3023 3024 3025 3026 3027 3028; do
    PID=$(lsof -ti :$port 2>/dev/null)
    if [ ! -z "$PID" ]; then
        echo "🔄 Stopping server on port $port (PID: $PID)"
        kill $PID 2>/dev/null || true
        sleep 1
    fi
done

# Fallback: kill by name pattern
pkill -f "mcp.*index.js" 2>/dev/null || true

echo "✅ All MCP servers stopped"
