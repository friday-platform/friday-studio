#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Atlas telephone game server with OpenTelemetry..."
OTEL_DENO=true \
OTEL_SERVICE_NAME=atlas \
OTEL_SERVICE_VERSION=1.0.0 \
OTEL_RESOURCE_ATTRIBUTES=service.name=atlas,service.version=1.0.0 \
deno task atlas workspace serve
