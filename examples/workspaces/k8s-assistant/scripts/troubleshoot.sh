#!/bin/bash

# Troubleshoot Kubernetes cluster using Atlas workspace
# This script demonstrates how to use the k8s assistant workspace to troubleshoot cluster issues

set -e
cd "$(dirname "$0")/.."

echo "🔧 Troubleshooting Kubernetes cluster using Atlas K8s Assistant..."

# Using Atlas CLI to trigger the troubleshoot signal
OTEL_DENO=true \
OTEL_SERVICE_NAME=atlas \
OTEL_SERVICE_VERSION=1.0.0 \
OTEL_RESOURCE_ATTRIBUTES=service.name=atlas,service.version=1.0.0 \
deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel --env-file ../../../src/cli.tsx signal trigger http-troubleshoot --port 3001 --data '{
  "message": "Analyze the cluster for common issues: failed pods, resource constraints, networking problems, and deployment issues. Provide specific recommendations for resolution."
}'

echo ""
echo "✅ Troubleshooting analysis request sent!"
echo "💡 You can also check specific failed pods with:"
echo "   ./scripts/list-failed-pods.sh"
