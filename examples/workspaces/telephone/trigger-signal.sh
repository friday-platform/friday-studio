#!/bin/bash
cd "$(dirname "$0")"
echo "Triggering telephone signal with OpenTelemetry..."
OTEL_DENO=true deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel ../../../src/cli.tsx signal trigger telephone-message --data '{"message": "The cat sat on the mat"}'