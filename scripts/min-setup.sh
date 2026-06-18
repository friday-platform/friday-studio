#!/usr/bin/env bash
# One-shot setup for Friday Studio inside a Minimal sandbox.
#
# Steps:
#   1. Copy .env.example → .env if it doesn't exist (so the daemon can boot).
#   2. deno install — pull JS/TS deps for the workspace.
#   3. scripts/setup-dev-env.sh — pre-warm uv + write daemon env vars so
#      Python user-agents can spawn.
#
# Idempotent. Safe to re-run after dep bumps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Sandbox HOME (/host/...) is read-only — pin daemon state under the
# project tree so it persists across `min run` invocations.
export FRIDAY_HOME="${FRIDAY_HOME:-$REPO_ROOT/.friday-home}"
mkdir -p "$FRIDAY_HOME"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ wrote .env from .env.example (fill in ANTHROPIC_API_KEY for real agent runs)"
else
  echo "→ .env already exists, leaving it alone"
fi

echo "→ deno install"
deno install

echo "→ scripts/setup-dev-env.sh"
bash scripts/setup-dev-env.sh

echo ""
echo "✓ Setup complete. Run 'min run start' to launch the daemon."
