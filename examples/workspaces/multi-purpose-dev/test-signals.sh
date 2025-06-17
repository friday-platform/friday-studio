#!/bin/bash

# Test Multi-Purpose Development Workspace Signals

echo "🧪 Testing workspace signals..."

# Check if workspace server is running
if ! curl -s http://localhost:3001/health > /dev/null 2>&1; then
    echo "❌ Workspace server is not running on localhost:3001"
    echo "   Start the workspace with: ./start-workspace.sh"
    exit 1
fi

echo "✅ Workspace server is running"

# Test code review request
echo "📝 Testing code review request..."
curl -X POST http://localhost:3001/signals/code-review-request \
  -H "Content-Type: application/json" \
  -d '{
    "files": ["README.md", "workspace.yml"],
    "focus_areas": ["documentation", "configuration"]
  }' | jq '.' 2>/dev/null || echo "Response received"

echo ""

# Test file operation
echo "📁 Testing file operation..."
curl -X POST http://localhost:3001/signals/file-operation-request \
  -H "Content-Type: application/json" \
  -d '{
    "operation": "read",
    "path": "./README.md"
  }' | jq '.' 2>/dev/null || echo "Response received"

echo ""

# Test research request
echo "🔍 Testing research request..."
curl -X POST http://localhost:3001/signals/research-request \
  -H "Content-Type: application/json" \
  -d '{
    "topic": "Atlas workspace configuration",
    "focus_areas": ["best-practices", "examples"]
  }' | jq '.' 2>/dev/null || echo "Response received"

echo ""
echo "✅ Test signals completed"
echo "💡 Check workspace logs for agent execution details"
