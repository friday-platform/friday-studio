#!/bin/bash

# Quick test script to validate Atlas workspace endpoint
set -e
cd "$(dirname "$0")/.."

echo "🧪 Testing Atlas K8s Assistant endpoint..."

# Test 1: Check if workspace server is running
echo "📡 Checking if workspace server is running on port 3001..."
if curl -s http://localhost:3001/health >/dev/null 2>&1; then
    echo "✅ Workspace server is responding"
else
    echo "❌ Workspace server is not responding on port 3001"
    echo "💡 Start it with: ./start-workspace.sh"
    exit 1
fi

# Test 2: Send a simple test message
echo "📡 Sending test message to /k8s endpoint..."
response=$(curl -X POST http://localhost:3001/k8s \
  -H "Content-Type: application/json" \
  -d '{"message": "test connection"}' \
  --max-time 60 \
  --fail \
  --silent \
  --show-error)

echo "📄 Response:"
echo "$response" | jq . 2>/dev/null || echo "$response"

echo ""
echo "✅ Endpoint test completed!"