#!/bin/bash

cd "$(dirname "$0")"
echo "Starting Atlas remote server with OpenTelemetry..."
OTEL_DENO=true \
    OTEL_SERVICE_NAME=atlas \
    OTEL_SERVICE_VERSION=1.0.0 \
    OTEL_RESOURCE_ATTRIBUTES=service.name=atlas,service.version=1.0.0 \
    deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel --env-file ../../../src/cli.tsx workspace serve
