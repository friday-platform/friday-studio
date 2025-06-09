#!/bin/bash
cd "$(dirname "$0")"
echo "Starting Atlas telephone game server with OpenTelemetry..."
OTEL_DENO=true deno run --allow-all --unstable-broadcast-channel --unstable-worker-options --unstable-otel ../../../src/cli.tsx workspace serve