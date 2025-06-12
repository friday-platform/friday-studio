#!/bin/bash

# Get the directory of this script
SCRIPT_DIR="$(dirname "$0")"
cd "$SCRIPT_DIR"

echo "🚀 Starting Atlas k8s-assistant workspace..."
echo "📡 Port: 3001 (configured to avoid conflicts with k8s-deployment-demo on port 8080)"
echo "🔗 Endpoint: http://localhost:3001"
echo ""

# Check if k8s-deployment-demo is running
if curl -s http://localhost:8080/health > /dev/null 2>&1; then
    echo "✅ k8s-deployment-demo main agent is running on port 8080"
else
    echo "⚠️  k8s-deployment-demo main agent is NOT running on port 8080"
    echo "   Start it with: cd ../../../k8s-deployment-demo && make dev-main"
    echo ""
fi

echo "🌟 Starting Atlas workspace with OpenTelemetry..."

# Use the correct path to the Atlas CLI
OTEL_DENO=true \
    OTEL_SERVICE_NAME=atlas-k8s-assistant \
    OTEL_SERVICE_VERSION=1.0.0 \
    OTEL_RESOURCE_ATTRIBUTES=service.name=atlas-k8s-assistant,service.version=1.0.0 \
    deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel --env-file ../../../src/cli.tsx workspace serve --port 3001 