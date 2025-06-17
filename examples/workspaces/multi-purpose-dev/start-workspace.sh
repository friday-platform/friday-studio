#!/bin/bash

# Start Multi-Purpose Development Workspace

echo "🚀 Starting Multi-Purpose Development Workspace..."

# Load environment variables
if [ -f ".env" ]; then
    export $(grep -v '^#' .env | xargs)
    echo "✅ Environment variables loaded"
else
    echo "❌ .env file not found"
    exit 1
fi

# Start Atlas workspace server
echo "🖥️  Starting Atlas workspace server..."
OTEL_DENO=true \
    OTEL_SERVICE_NAME=atlas-dev-multipurpose \
    OTEL_SERVICE_VERSION=1.0.0 \
    OTEL_RESOURCE_ATTRIBUTES=service.name=atlas-dev-multipurpose,service.version=1.0.0 \
    deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel --env-file ../../../src/cli.tsx workspace serve --port 3001
