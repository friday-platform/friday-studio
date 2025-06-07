#!/bin/bash

# Basic Chat Workspace Test Script

echo "🧪 Testing Basic Chat workspace..."
echo "================================="

# Navigate to Atlas root  
cd "$(dirname "$0")/../../.."

# Load workspace IDs
SCRIPT_DIR="$(dirname "$0")"
if [ ! -f "$SCRIPT_DIR/workspace-ids.txt" ]; then
    echo "❌ Workspace not set up. Run ./setup.sh first"
    exit 1
fi

source "$SCRIPT_DIR/workspace-ids.txt"

echo "Testing workspace: $WORKSPACE_ID"
echo "Testing agent: $AGENT_ID"
echo ""

# Test 1: Simple greeting
echo "🔹 Test 1: Simple greeting"
echo "Message: 'Hello Atlas!'"
echo "Response:"
deno task atlas chat --message "Hello Atlas!" --workspace "$WORKSPACE_ID" --agent "$AGENT_ID"
echo ""
echo "---"
echo ""

# Test 2: Technical question  
echo "🔹 Test 2: Technical question"
echo "Message: 'How does agent orchestration work?'"
echo "Response:"
deno task atlas chat --message "How does agent orchestration work?" --workspace "$WORKSPACE_ID" --agent "$AGENT_ID"
echo ""
echo "---"
echo ""

# Test 3: Code request
echo "🔹 Test 3: Code request"
echo "Message: 'Write a TypeScript function'"
echo "Response:"
deno task atlas chat --message "Write a TypeScript function" --workspace "$WORKSPACE_ID" --agent "$AGENT_ID"
echo ""
echo "---"
echo ""

# Test 4: Verify workspace state
echo "🔹 Test 4: Workspace status"
echo "Workspace list:"
deno task atlas workspace list
echo ""
echo "Agent list:"  
deno task atlas agent list
echo ""

echo "✅ Basic chat tests completed!"
echo ""
echo "💡 You can run more tests manually:"
echo "   atlas chat --message \"Your message\" --workspace $WORKSPACE_ID --agent $AGENT_ID"