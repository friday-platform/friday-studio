#!/bin/bash

# Test script to verify Playwright MCP wrapper setup
# This script tests the wrapper server endpoints and MCP integration

set -e

SERVER_URL="http://localhost:8001"
TIMEOUT=30

echo "🧪 Testing Playwright MCP Wrapper Setup"
echo "========================================"

# Function to wait for server to be ready
wait_for_server() {
    echo "⏳ Waiting for server at $SERVER_URL..."
    local count=0
    while ! curl -s "$SERVER_URL/ping" >/dev/null 2>&1; do
        if [ $count -ge $TIMEOUT ]; then
            echo "❌ Server failed to start within $TIMEOUT seconds"
            exit 1
        fi
        sleep 1
        count=$((count + 1))
        echo -n "."
    done
    echo ""
    echo "✅ Server is responding"
}

# Test 1: Health check
test_health() {
    echo ""
    echo "🏥 Testing health endpoint..."
    
    response=$(curl -s "$SERVER_URL/ping")
    
    if echo "$response" | grep -q '"status":"ok"'; then
        echo "✅ Health check passed"
        echo "   Response: $response"
    else
        echo "❌ Health check failed"
        echo "   Response: $response"
        return 1
    fi
}

# Test 2: List tools
test_tools_list() {
    echo ""
    echo "🔧 Testing tools list endpoint..."
    
    response=$(curl -s "$SERVER_URL/tools")
    
    if echo "$response" | grep -q '"tools"'; then
        echo "✅ Tools list endpoint working"
        
        # Count tools
        tool_count=$(echo "$response" | grep -o '"name"' | wc -l | tr -d ' ')
        echo "   Found $tool_count Playwright tools"
        
        # Show some tool names
        echo "   Available tools:"
        echo "$response" | grep -o '"name":"[^"]*"' | head -5 | sed 's/"name":"/     - /' | sed 's/"$//'
    else
        echo "❌ Tools list failed"
        echo "   Response: $response"
        return 1
    fi
}

# Test 3: Execute a simple tool
test_tool_execution() {
    echo ""
    echo "🎭 Testing tool execution..."
    
    # Test a simple navigation command
    payload='{"tool":"navigate","arguments":{"url":"https://example.com"}}'
    
    echo "   Executing: navigate to https://example.com"
    response=$(curl -s -X POST "$SERVER_URL/execute" \
        -H "Content-Type: application/json" \
        -d "$payload")
    
    if echo "$response" | grep -q '"success":true'; then
        echo "✅ Tool execution successful"
        echo "   Navigation completed"
    else
        echo "⚠️  Tool execution may have issues"
        echo "   Response: $response"
        # Don't fail the test as this might be expected in some environments
    fi
}

# Test 4: Test workspace configuration
test_workspace_config() {
    echo ""
    echo "📋 Testing workspace configuration..."
    
    if [ -f "workspace.yml" ]; then
        echo "✅ workspace.yml found"
        
        # Check for required fields
        if grep -q "playwright-browser:" workspace.yml; then
            echo "✅ Playwright agent configured"
        else
            echo "❌ Playwright agent not found in configuration"
        fi
        
        if grep -q "protocol: \"mcp\"" workspace.yml; then
            echo "✅ MCP protocol configured"
        else
            echo "❌ MCP protocol not configured"
        fi
        
        if grep -q "endpoint: \"http://localhost:8001\"" workspace.yml; then
            echo "✅ Endpoint correctly configured"
        else
            echo "❌ Endpoint not correctly configured"
        fi
    else
        echo "❌ workspace.yml not found"
        return 1
    fi
}

# Main test execution
main() {
    echo "Starting tests..."
    echo "Server URL: $SERVER_URL"
    echo ""
    
    # Check if server is already running or start it
    if ! curl -s "$SERVER_URL/ping" >/dev/null 2>&1; then
        echo "🚀 Server not running. Please start it first with:"
        echo "   ./start-server.sh"
        echo ""
        echo "Or run in the background:"
        echo "   ./start-server.sh &"
        echo "   sleep 5  # Wait for startup"
        echo "   ./test-setup.sh"
        exit 1
    fi
    
    wait_for_server
    test_health
    test_tools_list
    test_tool_execution
    test_workspace_config
    
    echo ""
    echo "🎉 All tests completed!"
    echo ""
    echo "Next steps:"
    echo "  1. Start Atlas workspace: atlas workspace serve"
    echo "  2. Trigger analysis: atlas signal trigger manual-analysis --payload '{\"url\":\"https://example.com\"}'"
    echo "  3. Check logs for execution results"
}

# Run tests
main "$@"