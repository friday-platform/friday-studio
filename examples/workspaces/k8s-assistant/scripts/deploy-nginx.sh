#!/bin/bash

# Deploy nginx using Atlas workspace
# This script demonstrates how to use the k8s assistant workspace to deploy nginx

set -e
cd "$(dirname "$0")/.."

echo "🚀 Deploying nginx using Atlas K8s Assistant..."

# Using Atlas CLI to trigger the deployment signal
OTEL_DENO=true \
OTEL_SERVICE_NAME=atlas \
OTEL_SERVICE_VERSION=1.0.0 \
OTEL_RESOURCE_ATTRIBUTES=service.name=atlas,service.version=1.0.0 \
deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel ../../../src/cli.tsx signal trigger http-k8s --port 3001 --data '{
  "message": "Deploy nginx web server with 3 replicas, expose it on port 80 with a LoadBalancer service, and add resource limits of 100m CPU and 128Mi memory"
}'

echo ""
echo "✅ Nginx deployment request sent!"
echo "💡 You can check the deployment status by running:"
echo "   ./scripts/list-failed-pods.sh"
