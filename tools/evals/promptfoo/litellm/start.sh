#!/usr/bin/env bash
# Starts the LiteLLM proxy on :4000 with the friday-* model aliases.
#
# Required env vars (any subset — only models with their key set work):
#   - ANTHROPIC_API_KEY  → friday-md, friday-lg
#   - GROQ_API_KEY       → friday-sm
#
# Optional:
#   - LITELLM_MASTER_KEY (defaults to a dev-only literal — override in CI)
#
# Stop with Ctrl+C; container is removed on exit.
#
# Image is pinned to a concrete version (not :main-stable) so eval cost/behavior
# stays reproducible. v1.86.2 is the release :main-stable resolved to when pinned.
# Bump intentionally, and re-verify the cost-header name in the handler — LiteLLM
# renamed it at >=1.86 (see litellm/README.md).

set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || {
  echo "docker is required but not installed; see https://docs.docker.com/get-docker/" >&2
  exit 1
}

export LITELLM_MASTER_KEY="${LITELLM_MASTER_KEY:-sk-friday-evals-dev}"

docker run --rm -i \
  -p 4000:4000 \
  -v "$PWD/litellm_config.yaml:/app/config.yaml:ro" \
  -e ANTHROPIC_API_KEY \
  -e GROQ_API_KEY \
  -e LITELLM_MASTER_KEY \
  ghcr.io/berriai/litellm:v1.86.2 \
  --config /app/config.yaml --port 4000
