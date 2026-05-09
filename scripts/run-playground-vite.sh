#!/usr/bin/env bash
#
# Wrapper for `vite dev` that:
#   1. Invokes vite via real `node` (not `npx`) so `deno task` doesn't
#      route the bin script through Deno's node-compat — Deno's
#      `node:http2` polyfill is missing `setupConnectionsTracking`,
#      which `Http2SecureServer`'s constructor calls when vite serves
#      HTTPS. Real Node 22+ has it.
#   2. Sets `NODE_EXTRA_CA_CERTS` to mkcert's root CA *before* Node
#      starts. Node 25 reads this only at startup; setting it from
#      inside `vite.config.ts` is too late — the default secure context
#      is created before our config runs, and the SvelteKit dev proxy's
#      fetch to https://daemon then fails with `fetch failed` because
#      the mkcert leaf chains to an untrusted CA.
#
# Without TLS / mkcert this still works — `NODE_EXTRA_CA_CERTS` simply
# isn't set, vite serves HTTP, and the proxy fetches HTTP. No-op cost.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PLAYGROUND_DIR="$REPO_ROOT/tools/agent-playground"
VITE_BIN="$REPO_ROOT/node_modules/vite/bin/vite.js"

if [[ ! -f "$VITE_BIN" ]]; then
    echo "✗ vite not installed at $VITE_BIN — run \`deno install\`" >&2
    exit 1
fi

# Resolve mkcert's root CA so Node trusts the (mkcert-signed) daemon. Only
# set NODE_EXTRA_CA_CERTS if we actually have a usable CA file — passing
# a missing path silently triggers a Node warning and breaks every TLS
# handshake.
if [[ -z "${NODE_EXTRA_CA_CERTS:-}" ]] && command -v mkcert >/dev/null 2>&1; then
    ca_path="$(mkcert -CAROOT 2>/dev/null)/rootCA.pem"
    if [[ -f "$ca_path" ]]; then
        export NODE_EXTRA_CA_CERTS="$ca_path"
    fi
fi

cd "$PLAYGROUND_DIR"
exec node "$VITE_BIN" dev "$@"
