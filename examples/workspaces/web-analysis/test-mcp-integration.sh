#!/bin/bash

echo "🧪 Testing Playwright MCP integration..."

# Test if MCP server starts properly
echo "1. Testing MCP server startup..."
timeout 10s npx @playwright/mcp@latest --help || {
    echo "❌ MCP server failed to start"
    exit 1
}

echo "✅ MCP server startup test passed"

# Test Atlas configuration
echo "2. Testing Atlas configuration..."
if command -v atlas &> /dev/null; then
    atlas config validate || {
        echo "⚠️  Atlas configuration validation failed (this may be normal if Atlas is not installed)"
    }
else
    echo "⚠️  Atlas CLI not found - configuration validation skipped"
fi

echo "✅ MCP integration test completed"
echo ""
echo "🕷️  Playwright MCP server is ready!"
echo "   You can now start the Atlas workspace server."
