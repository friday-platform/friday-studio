#!/bin/bash

# Start Atlas web analysis server with proper environment setup

cd "$(dirname "$0")"

echo "🕷️  Starting Atlas web analysis server with Playwright MCP integration..."

# Check if .env exists and has required keys
if [ ! -f .env ]; then
    echo "❌ .env file not found. Please run ./setup-workspace.sh first"
    exit 1
fi

# Check for Anthropic API key
if ! grep -q "ANTHROPIC_API_KEY=sk-" .env 2>/dev/null; then
    echo "⚠️  Warning: ANTHROPIC_API_KEY not configured in .env"
    echo "   The web analysis agent requires an Anthropic API key to function"
    echo "   Please update .env with your API key from https://console.anthropic.com/"
fi

# Verify Playwright MCP is available
if [ ! -f package.json ] || ! command -v npx &> /dev/null; then
    echo "❌ Playwright MCP not available. Please run ./setup-workspace.sh first"
    exit 1
fi

# Test Playwright MCP server connectivity
echo "🔍 Verifying Playwright MCP server..."
if ! timeout 5s npx @playwright/mcp@latest --help > /dev/null 2>&1; then
    echo "❌ Playwright MCP server not responding. Try:"
    echo "   npm install @playwright/mcp@latest"
    echo "   npx playwright install"
    exit 1
fi

# Create logs directory if it doesn't exist
mkdir -p .atlas/logs

# Set up environment for MCP integration
export NODE_ENV=production
export PLAYWRIGHT_HEADLESS=true
export PLAYWRIGHT_TIMEOUT=30000

echo "✅ Playwright MCP server verified"
echo "🚀 Starting Atlas server..."
echo ""
echo "📊 Server Configuration:"
echo "   Workspace: Web Analysis with Playwright MCP"
echo "   MCP Server: @playwright/mcp@latest (stdio transport)"
echo "   Port: 8080 (HTTP signals)"
echo "   Agent: claude-3-5-sonnet-20241022"
echo ""
echo "🌐 Available endpoints:"
echo "   POST http://localhost:8080/analyze - Trigger web analysis"
echo ""
echo "📝 Logs will be written to .atlas/logs/"
echo "   Press Ctrl+C to stop the server"
echo ""

# Start Atlas with proper environment and telemetry
OTEL_DENO=true \
OTEL_SERVICE_NAME=atlas-web-analysis \
OTEL_SERVICE_VERSION=1.0.0 \
OTEL_RESOURCE_ATTRIBUTES=service.name=atlas-web-analysis,service.version=1.0.0,workspace.type=web-analysis,mcp.servers=playwright \
deno run \
  --allow-all \
  --unstable-broadcast-channel \
  --unstable-worker-options \
  --unstable-otel \
  --env-file \
  ../../../src/cli.tsx workspace serve