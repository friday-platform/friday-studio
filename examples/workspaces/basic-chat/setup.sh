#!/bin/bash

# Basic Chat Workspace Setup Script

echo "🚀 Setting up Basic Chat workspace..."
echo "===================================="

# Navigate to Atlas root
cd "$(dirname "$0")/../../.."

# Create workspace
echo "📦 Creating workspace..."
WORKSPACE_OUTPUT=$(deno task atlas workspace init basic-chat-demo --owner demo-user)
WORKSPACE_ID=$(echo "$WORKSPACE_OUTPUT" | grep "Created workspace:" | sed 's/.*Created workspace: //' | tr -d ' ')

if [ -z "$WORKSPACE_ID" ]; then
    echo "❌ Failed to create workspace"
    exit 1
fi

echo "✅ Workspace created: $WORKSPACE_ID"

# Add echo agent
echo "🤖 Adding echo agent..."
AGENT_OUTPUT=$(deno task atlas agent add echo --workspace "$WORKSPACE_ID")
AGENT_ID=$(echo "$AGENT_OUTPUT" | grep "Agent ID:" | sed 's/.*Agent ID: //' | tr -d ' ')

if [ -z "$AGENT_ID" ]; then
    echo "❌ Failed to add agent"
    exit 1
fi

echo "✅ Agent added: $AGENT_ID"

# Save IDs to config file for testing
cat > "$(dirname "$0")/workspace-ids.txt" << EOF
WORKSPACE_ID=$WORKSPACE_ID
AGENT_ID=$AGENT_ID
EOF

echo ""
echo "🎉 Setup complete!"
echo ""
echo "Workspace ID: $WORKSPACE_ID"
echo "Agent ID:     $AGENT_ID"
echo ""
echo "Test the workspace:"
echo "  ./test.sh"
echo ""
echo "Manual chat:"
echo "  atlas chat --message \"Hello!\" --workspace $WORKSPACE_ID --agent $AGENT_ID"