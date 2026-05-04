#!/usr/bin/env bash
# Start the Friday Studio daemon in the foreground.
#
# Run setup first (`min run setup`) to install deps and prepare uv/.env.
# Ctrl+C to stop.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Match min-setup.sh — keep daemon state under the project tree.
export FRIDAY_HOME="${FRIDAY_HOME:-$REPO_ROOT/.friday-home}"

if [ ! -d node_modules ] && [ ! -f deno.lock ]; then
  echo "✗ deps not installed — run 'min run setup' first" >&2
  exit 1
fi

exec deno task atlas daemon start
