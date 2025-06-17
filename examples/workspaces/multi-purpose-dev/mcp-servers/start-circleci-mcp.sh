#!/bin/bash
cd ~/.atlas/mcp-servers/circleci-mcp
export PORT=3027

# Load environment variables if available
ENV_FILE=""
for possible_env in "../../../.env" "../../../../.env" "../../../../../.env"; do
    if [ -f "$possible_env" ]; then
        ENV_FILE="$possible_env"
        break
    fi
done

if [ ! -z "$ENV_FILE" ]; then
    export $(grep -v '^#' "$ENV_FILE" | xargs) 2>/dev/null || true
    echo "✅ Environment loaded from $ENV_FILE"
else
    echo "⚠️  .env file not found, using defaults"
fi

echo "🚀 Starting circleci-mcp on port 3027..."

# Check if the server directory exists and has index.js
if [ ! -f "index.js" ]; then
    echo "❌ index.js not found in ~/.atlas/mcp-servers/circleci-mcp"
    echo "Available files:"
    ls -la
    exit 1
fi

node index.js
