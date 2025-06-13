#!/bin/bash

# Deploy nginx using Atlas workspace
# This script demonstrates how to use the k8s assistant workspace to deploy nginx

set -e
cd "$(dirname "$0")/.."

echo "🚀 Deploying nginx using Atlas K8s Assistant..."

# Using direct HTTP call to the k8s endpoint (faster than CLI signal trigger)
echo "📡 Sending deployment request to Atlas workspace..."
response=$(curl -X POST http://localhost:3001/k8s \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Deploy nginx web server with 3 replicas, expose it on port 80 with a LoadBalancer service, and add resource limits of 100m CPU and 128Mi memory"
  }' \
  --max-time 300 \
  --fail \
  --silent \
  --show-error)

echo "📄 Response:"
echo "$response" | jq . 2>/dev/null || echo "$response"

echo ""
echo "✅ Nginx deployment request sent!"
echo "💡 You can check the deployment status by running:"
echo "   ./scripts/list-failed-pods.sh"
