#!/bin/bash
cd "$(dirname "$0")"
echo "Triggering telephone signal with OpenTelemetry..."
OTEL_DENO=true \
OTEL_SERVICE_NAME=atlas \
OTEL_SERVICE_VERSION=1.0.0 \
OTEL_RESOURCE_ATTRIBUTES=service.name=atlas,service.version=1.0.0 \
deno task atlas signal trigger telephone-message --data '{"message": "The cat sat on the mat"}'