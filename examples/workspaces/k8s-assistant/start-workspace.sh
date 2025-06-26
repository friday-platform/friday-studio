#!/bin/bash

# Get the directory of this script and navigate to Atlas root
SCRIPT_DIR="$(dirname "$0")"
ATLAS_ROOT="$(cd "$SCRIPT_DIR/../../../" && pwd)"
WORKSPACE_NAME="k8s-assistant"
WORKSPACE_PATH="$SCRIPT_DIR"

echo "🚀 Starting Atlas k8s-assistant workspace (Atlas 2.0)..."
echo "🏠 Atlas Root: $ATLAS_ROOT"
echo "📁 Workspace Path: $WORKSPACE_PATH"
echo ""

# Navigate to Atlas root for CLI commands
cd "$ATLAS_ROOT"

# Check if Atlas daemon is running
echo "🔍 Checking Atlas daemon status..."
if deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file src/cli.tsx daemon status > /dev/null 2>&1; then
    echo "✅ Atlas daemon is running"
else
    echo "⚠️  Atlas daemon is not running. Starting daemon..."
    echo "🌟 Starting Atlas daemon with OpenTelemetry..."
    
    # Start daemon in background
    NODE_ENV=development \
        OTEL_DENO=true \
        OTEL_SERVICE_NAME=atlas-daemon \
        OTEL_SERVICE_VERSION=1.0.0 \
        OTEL_RESOURCE_ATTRIBUTES=service.name=atlas-daemon,service.version=1.0.0 \
        deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel --unsafely-ignore-certificate-errors --env-file src/cli.tsx daemon start &
    
    # Wait for daemon to start
    echo "⏳ Waiting for daemon to start..."
    sleep 5
    
    # Verify daemon started
    if deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file src/cli.tsx daemon status > /dev/null 2>&1; then
        echo "✅ Atlas daemon started successfully"
    else
        echo "❌ Failed to start Atlas daemon"
        exit 1
    fi
fi

# Check if standalone-coordinator agent is running
echo ""
echo "🔍 Checking standalone-coordinator agent..."
if curl -s http://localhost:8085/health > /dev/null 2>&1; then
    echo "✅ standalone-coordinator agent is running on port 8085"
else
    echo "⚠️  standalone-coordinator agent is NOT running on port 8085"
    echo "   Start it with your k8s agent on port 8085"
    echo ""
fi

# Initialize/register the workspace with the daemon
echo "📝 Registering workspace with daemon..."
deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file src/cli.tsx workspace init "$WORKSPACE_NAME" "$WORKSPACE_PATH"

# Check workspace status
echo "📊 Checking workspace status..."
deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --env-file src/cli.tsx workspace status "$WORKSPACE_NAME"

echo ""
echo "🎉 k8s-assistant workspace is ready!"
echo "🔗 Atlas daemon running on: http://localhost:8080"
echo "📡 Workspace signals available:"
echo "   • HTTP: POST /signals/linear-webhook"
echo "   • CLI: atlas signal trigger linear-webhook --workspace $WORKSPACE_NAME"
echo ""
echo "📋 Useful commands:"
echo "   • atlas ps                                    # List active sessions"
echo "   • atlas workspace status $WORKSPACE_NAME     # Check workspace status"
echo "   • atlas workspace logs $WORKSPACE_NAME       # View workspace logs"
echo "   • atlas daemon stop                          # Stop daemon when done"
echo ""
echo "🧪 Test the workspace:"
echo "   • ./test.sh                                   # Run test script"
echo "   • atlas signal trigger linear-webhook --workspace $WORKSPACE_NAME --data '{\"action\": \"create\"}'" 