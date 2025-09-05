#!/bin/bash

# List failed pods using Atlas workspace
# This script demonstrates how to use the k8s assistant workspace to troubleshoot failed pods

set -e
cd "$(dirname "$0")/.."

echo "🔍 Checking for failed pods using Atlas K8s Assistant..."

# Using Atlas CLI to trigger the list signal to find failed pods
OTEL_DENO=true \
OTEL_SERVICE_NAME=atlas \
OTEL_SERVICE_VERSION=1.0.0 \
OTEL_RESOURCE_ATTRIBUTES=service.name=atlas,service.version=1.0.0 \
deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file ../../src/cli.tsx signal trigger http-k8s --port 8080 --data '{
  "message": "List all pods that are in Failed, CrashLoopBackOff, or Error state. Show their names, namespaces, status, and recent events or logs to help with troubleshooting."
}'

echo ""
echo "✅ Failed pods query sent!"
echo "💡 For more detailed troubleshooting, you can also run:"
echo "   ./scripts/troubleshoot.sh" 
