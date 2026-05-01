#!/bin/bash
# Compile Atlas binary with all required dependencies
# Usage: ./scripts/compile.sh [output-path]

set -e

OUTPUT="${1:-./dist/atlas}"
mkdir -p "$(dirname "$OUTPUT")"

echo "Compiling Atlas to: ${OUTPUT}"

# Enable OTEL at compile time so the binary has telemetry enabled.
# Runtime env vars (OTEL_EXPORTER_OTLP_ENDPOINT, etc) control WHERE data is sent.
# Without this, the compiled binary ignores console.log -> OTEL forwarding.
export OTEL_DENO=true

deno compile \
  --no-check \
  --allow-read \
  --allow-write \
  --allow-net \
  --allow-env \
  --allow-run \
  --allow-sys \
  --allow-ffi \
  --unstable-broadcast-channel \
  --unstable-worker-options \
  --include=apps/atlas-cli \
  --include=examples \
  --include=packages \
  --output "$OUTPUT" \
  ./apps/atlas-cli/src/otel-bootstrap.ts

echo "✅ Compilation complete: ${OUTPUT}"
