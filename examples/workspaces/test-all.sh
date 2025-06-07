#!/bin/bash

# Test All Workspaces Script

echo "🚀 Testing All Atlas Workspace Examples"
echo "========================================"

SCRIPT_DIR="$(dirname "$0")"
cd "$SCRIPT_DIR"

# Test basic-chat
echo ""
echo "🔹 Testing Basic Chat Workspace"
echo "--------------------------------"
cd basic-chat
if [ ! -f "workspace-ids.txt" ]; then
    echo "Setting up basic-chat workspace..."
    ./setup.sh
fi
./test.sh
cd ..

# Test dev-team  
echo ""
echo "🔹 Testing Development Team Workspace"
echo "-------------------------------------"
cd dev-team
if [ ! -f "workspace-ids.txt" ]; then
    echo "Setting up dev-team workspace..."
    ./setup.sh
fi
./test.sh
cd ..

echo ""
echo "✅ All workspace tests completed!"
echo ""
echo "📊 Summary:"
echo "  - Basic Chat: Echo agent functionality"
echo "  - Dev Team: Multi-agent Claude coordination"
echo ""
echo "💡 Next steps:"
echo "  - Create custom workspaces in examples/workspaces/"
echo "  - Add more specialized agents"
echo "  - Build workflows connecting multiple agents"