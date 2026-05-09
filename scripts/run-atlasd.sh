#!/usr/bin/env bash
#
# Wrapper for `atlas-cli` (otel-bootstrap.ts). Exports the small set of
# env vars that are consumed at *module-load time* (i.e. before user
# code can dotenv-load anything) and exec's deno. Everything else
# (FRIDAY_KEY, ANTHROPIC_API_KEY, OAuth tokens, etc.) is loaded by
# atlas-cli's own dotenv.load() in start.tsx — no double-parse.
#
# What needs to land before module load:
#   - DENO_CERT             — Deno's RootCertStore initializes on first
#                             TLS use, which fires before user code.
#                             OTEL traffic hits TLS during bootstrap.
#   - FRIDAY_TLS_CERT/_KEY  — getAtlasDaemonUrl() in @atlas/oapi-client
#                             reads these at module-init to decide
#                             between http:// and https:// when building
#                             baseUrl in @atlas/client/v2. The baseUrl
#                             is *frozen* at first import — if these
#                             aren't set yet, every subsequent client
#                             call hits the wrong scheme.
#
# Installer (friday-launcher Go) doesn't go through this wrapper — it
# pre-populates process.env via commonServiceEnv() before spawning the
# compiled atlasd binary. This wrapper is the dev-mode equivalent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Pick the canonical .env: FRIDAY_HOME wins (installer points at
# ~/.friday/local; manual overrides ditto), otherwise dev default
# ~/.atlas/.env which setup-tls.sh always seeds.
ENV_FILE="${FRIDAY_HOME:-$HOME/.atlas}/.env"

# Extract a single key=value line from .env, returning the value with
# the key prefix stripped. Path values may contain spaces (mkcert's
# CAROOT on macOS lives under `Application Support`); taking the head
# of grep + parameter expansion handles them correctly without quoting
# games.
read_env_var() {
    local key="$1" file="$2"
    local line
    line="$(grep "^${key}=" "$file" | head -1 || true)"
    [[ -n "$line" ]] && printf '%s' "${line#${key}=}"
}

if [[ -f "$ENV_FILE" ]]; then
    for key in DENO_CERT FRIDAY_TLS_CERT FRIDAY_TLS_KEY; do
        # Don't clobber a shell-exported value — explicit > .env.
        [[ -n "${!key:-}" ]] && continue
        value="$(read_env_var "$key" "$ENV_FILE")"
        [[ -n "$value" ]] && export "$key=$value"
    done
fi

cd "$REPO_ROOT"
exec deno run -q --allow-all --unstable-worker-options --unstable-kv --unstable-raw-imports apps/atlas-cli/src/otel-bootstrap.ts "$@"
