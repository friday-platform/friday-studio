#!/bin/bash

# Development Team Workspace Setup Script

echo "👥 Setting up Development Team workspace..."
echo "==========================================="

# Navigate to Atlas root
cd "$(dirname "$0")/../../.."

# Check for .env file
if [ ! -f ".env" ]; then
    echo "⚠️  No .env file found. Claude agents will fail without ANTHROPIC_API_KEY"
    echo "   Copy .env.example to .env and add your API key"
    read -p "Continue anyway? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        exit 1
    fi
fi

# Create workspace
echo "📦 Creating workspace..."
WORKSPACE_OUTPUT=$(deno task atlas workspace init dev-team-demo --owner tech-lead)
WORKSPACE_ID=$(echo "$WORKSPACE_OUTPUT" | grep "Created workspace:" | sed 's/.*Created workspace: //' | tr -d ' ')

if [ -z "$WORKSPACE_ID" ]; then
    echo "❌ Failed to create workspace"
    exit 1
fi

echo "✅ Workspace created: $WORKSPACE_ID"

# Add Code Review Agent (Claude)
echo "🔍 Adding Code Review Agent (Claude)..."
REVIEW_OUTPUT=$(deno task atlas agent add claude --workspace "$WORKSPACE_ID" --model claude-3-haiku-20240307)
REVIEW_AGENT_ID=$(echo "$REVIEW_OUTPUT" | grep "Agent ID:" | sed 's/.*Agent ID: //' | tr -d ' ')

if [ -z "$REVIEW_AGENT_ID" ]; then
    echo "❌ Failed to add code review agent"
    exit 1
fi

echo "✅ Code Review Agent added: $REVIEW_AGENT_ID"

# Add Documentation Agent (Claude)  
echo "📚 Adding Documentation Agent (Claude)..."
DOCS_OUTPUT=$(deno task atlas agent add claude --workspace "$WORKSPACE_ID" --model claude-3-haiku-20240307)
DOCS_AGENT_ID=$(echo "$DOCS_OUTPUT" | grep "Agent ID:" | sed 's/.*Agent ID: //' | tr -d ' ')

if [ -z "$DOCS_AGENT_ID" ]; then
    echo "❌ Failed to add documentation agent"
    exit 1
fi

echo "✅ Documentation Agent added: $DOCS_AGENT_ID"

# Add Test Agent (Echo for now)
echo "🧪 Adding Test Agent (Echo)..."
TEST_OUTPUT=$(deno task atlas agent add echo --workspace "$WORKSPACE_ID")
TEST_AGENT_ID=$(echo "$TEST_OUTPUT" | grep "Agent ID:" | sed 's/.*Agent ID: //' | tr -d ' ')

if [ -z "$TEST_AGENT_ID" ]; then
    echo "❌ Failed to add test agent"
    exit 1
fi

echo "✅ Test Agent added: $TEST_AGENT_ID"

# Save IDs to config file
cat > "$(dirname "$0")/workspace-ids.txt" << EOF
WORKSPACE_ID=$WORKSPACE_ID
REVIEW_AGENT_ID=$REVIEW_AGENT_ID
DOCS_AGENT_ID=$DOCS_AGENT_ID
TEST_AGENT_ID=$TEST_AGENT_ID
EOF

echo ""
echo "🎉 Development Team workspace setup complete!"
echo ""
echo "Workspace ID:         $WORKSPACE_ID"
echo "Code Review Agent:    $REVIEW_AGENT_ID"
echo "Documentation Agent:  $DOCS_AGENT_ID"  
echo "Test Agent:           $TEST_AGENT_ID"
echo ""
echo "Test the workspace:"
echo "  ./test.sh"
echo ""
echo "Example usage:"
echo "  atlas chat --message \"Review this code: console.log('hello')\" \\"
echo "    --workspace $WORKSPACE_ID --agent $REVIEW_AGENT_ID"