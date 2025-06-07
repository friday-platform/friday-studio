#!/bin/bash

# Development Team Workspace Test Script

echo "👥 Testing Development Team workspace..."
echo "======================================="

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
echo "Agents:"
echo "  Code Review: $REVIEW_AGENT_ID"
echo "  Documentation: $DOCS_AGENT_ID"
echo "  Test: $TEST_AGENT_ID"
echo ""

# Test 1: Code Review
echo "🔹 Test 1: Code Review Agent"
echo "Message: 'Review this TypeScript function: function divide(a: number, b: number) { return a / b; }'"
echo "Response:"
deno task atlas chat --message "Review this TypeScript function: function divide(a: number, b: number) { return a / b; }" --workspace "$WORKSPACE_ID" --agent "$REVIEW_AGENT_ID"
echo ""
echo "---"
echo ""

# Test 2: Documentation  
echo "🔹 Test 2: Documentation Agent"
echo "Message: 'Write documentation for a REST API endpoint that creates a user account'"
echo "Response:"
deno task atlas chat --message "Write documentation for a REST API endpoint that creates a user account" --workspace "$WORKSPACE_ID" --agent "$DOCS_AGENT_ID"
echo ""
echo "---"
echo ""

# Test 3: Test Planning
echo "🔹 Test 3: Test Agent"
echo "Message: 'Create a test plan for the user authentication feature'"
echo "Response:"
deno task atlas chat --message "Create a test plan for the user authentication feature" --workspace "$WORKSPACE_ID" --agent "$TEST_AGENT_ID"
echo ""
echo "---"
echo ""

# Test 4: Team coordination
echo "🔹 Test 4: Code Review with Documentation Follow-up"
echo "Step 1 - Code Review:"
deno task atlas chat --message "Review this code and suggest improvements: async function fetchUser(id) { const response = await fetch('/api/users/' + id); return response.json(); }" --workspace "$WORKSPACE_ID" --agent "$REVIEW_AGENT_ID"
echo ""
echo "Step 2 - Document the improved version:"
deno task atlas chat --message "Document the fetchUser function, including proper TypeScript types and error handling patterns" --workspace "$WORKSPACE_ID" --agent "$DOCS_AGENT_ID"
echo ""
echo "---"
echo ""

# Test 5: Workspace status
echo "🔹 Test 5: Workspace Status"
echo "All workspace agents:"
deno task atlas agent list
echo ""

echo "✅ Development team tests completed!"
echo ""
echo "💡 Try more complex workflows:"
echo ""
echo "Code Review:"
echo "  atlas chat --message \"Your code here\" --workspace $WORKSPACE_ID --agent $REVIEW_AGENT_ID"
echo ""
echo "Documentation:"  
echo "  atlas chat --message \"Document this API\" --workspace $WORKSPACE_ID --agent $DOCS_AGENT_ID"
echo ""
echo "Test Planning:"
echo "  atlas chat --message \"Test plan for feature\" --workspace $WORKSPACE_ID --agent $TEST_AGENT_ID"