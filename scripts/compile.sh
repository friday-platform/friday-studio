#!/bin/bash
# Compile Atlas binary with all required dependencies
# Usage: ./scripts/compile.sh [output-path]

set -e

OUTPUT="${1:-./dist/atlas}"
mkdir -p "$(dirname "$OUTPUT")"

echo "Compiling Atlas to: ${OUTPUT}"

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
  --include=src \
  --include=examples \
  --include=packages \
  --output "$OUTPUT" \
  ./src/cli.tsx

echo "✅ Compilation complete: ${OUTPUT}"
