#!/usr/bin/env bash
#
# Wrapper for `vite dev` that:
#   1. Invokes vite via real `node` (not `npx`) so `deno task` doesn't
#      route the bin script through Deno's node-compat — Deno's
#      `node:http2` polyfill is missing `setupConnectionsTracking`,
#      which `Http2SecureServer`'s constructor calls when vite serves
#      HTTPS. Real Node 22+ has it.
#   2. Sets `NODE_EXTRA_CA_CERTS` to the private s2s CA *before* Node
#      starts. Node 25 reads this only at startup; setting it from
#      inside `vite.config.ts` is too late — the default secure context
#      is created before our config runs, and the SvelteKit dev proxy's
#      fetch to https://daemon then fails with `fetch failed` because
#      the s2s leaf chains to a CA no system trust store knows about.
#
# Without s2s TLS this still works — `NODE_EXTRA_CA_CERTS` simply isn't
# set, daemon/tunnel serve HTTP, and the proxy fetches HTTP. No-op cost.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLAYGROUND_DIR="$REPO_ROOT/tools/agent-playground"
VITE_BIN="$REPO_ROOT/node_modules/vite/bin/vite.js"

if [[ ! -f "$VITE_BIN" ]]; then
    echo "✗ vite not installed at $VITE_BIN — run \`deno install\`" >&2
    exit 1
fi

# Resolve the private s2s CA so Node trusts the (private-CA-signed) daemon
# + tunnel. Source: FRIDAY_TLS_CA in <friday-home>/.env, written by
# scripts/setup-tls.sh. Only set NODE_EXTRA_CA_CERTS if we have a real
# file — pointing at a missing path triggers a Node warning and breaks
# every TLS handshake.
if [[ -z "${NODE_EXTRA_CA_CERTS:-}" ]]; then
    env_file="${FRIDAY_HOME:-$HOME/.atlas}/.env"
    if [[ -f "$env_file" ]]; then
        ca_path="$(grep "^FRIDAY_TLS_CA=" "$env_file" | head -1 | sed -E 's/^FRIDAY_TLS_CA=//')"
        if [[ -n "$ca_path" && -f "$ca_path" ]]; then
            export NODE_EXTRA_CA_CERTS="$ca_path"
        fi
    fi
fi

cd "$PLAYGROUND_DIR"
exec node "$VITE_BIN" dev "$@"
