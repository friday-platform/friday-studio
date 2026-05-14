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

# Pull s2s + browser TLS env keys from <friday-home>/.env BEFORE
# exec'ing node. Two reasons it has to happen here, not in
# vite.config.ts:
#
#   1. vite.config.ts reads FRIDAY_TLS_CERT/_KEY at module load to
#      decide the daemon + tunnel URL scheme (http vs https). If the
#      env vars aren't set at that point, the URL is frozen at
#      http://, and every SSR proxy fetch hits the wrong scheme.
#
#   2. Node's RootCertStore initializes on first TLS use, which fires
#      before vite.config.ts can run. Setting NODE_EXTRA_CA_CERTS
#      after that has no effect and the daemon-proxy fetch fails with
#      "self signed certificate in certificate chain".
#
# Pre-existing shell exports win over .env (mirrors run-atlasd.sh).
# Each cert/key/CA path is sanity-checked for file existence before
# export — pointing NODE_EXTRA_CA_CERTS at a missing file makes Node
# warn and abort every handshake, which is worse than not setting it.
env_file="${FRIDAY_HOME:-$HOME/.atlas}/.env"
if [[ -f "$env_file" ]]; then
    for key in FRIDAY_TLS_CERT FRIDAY_TLS_KEY FRIDAY_TLS_CA FRIDAY_BROWSER_TLS_CERT FRIDAY_BROWSER_TLS_KEY DENO_CERT NODE_EXTRA_CA_CERTS; do
        [[ -n "${!key:-}" ]] && continue
        line="$(grep "^${key}=" "$env_file" | head -1 || true)"
        [[ -z "$line" ]] && continue
        value="${line#${key}=}"
        [[ -f "$value" ]] || continue
        export "$key=$value"
    done
fi

cd "$PLAYGROUND_DIR"
exec node "$VITE_BIN" dev "$@"
