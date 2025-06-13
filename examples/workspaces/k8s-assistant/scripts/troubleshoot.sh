#!/bin/bash

# Troubleshoot Kubernetes cluster using Atlas workspace
# This script demonstrates how to use the k8s assistant workspace to troubleshoot cluster issues

set -e
cd "$(dirname "$0")/.."

echo "🔧 Troubleshooting Kubernetes cluster using Atlas K8s Assistant..."

# Using direct HTTP call to the k8s endpoint (faster than CLI signal trigger)
echo "📡 Sending troubleshooting request to Atlas workspace..."
response=$(curl -X POST http://localhost:3001/k8s \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Analyze the cluster for common issues: failed pods, resource constraints, networking problems, and deployment issues. Provide specific recommendations for resolution."
  }' \
  --max-time 300 \
  --fail \
  --silent \
  --show-error)

echo "📄 Response:"
echo "$response" | jq . 2>/dev/null || echo "$response"

echo ""
echo "✅ Troubleshooting analysis request sent!"
echo "💡 You can also check specific failed pods with:"
echo "   ./scripts/list-failed-pods.sh"
