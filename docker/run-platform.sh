#!/usr/bin/env bash
#
# Platform entrypoint: starts atlasd, link, and agent-playground.
# Follows the grafana/docker-otel-lgtm shell-based supervisor pattern.
#
set -euo pipefail

cd /app

# ── Override host paths ─────────────────────────────────────────────────────
# The user's .env may contain macOS paths (e.g. /opt/homebrew/bin/npx).
# Force container-correct paths regardless of what's in the env file.
export ATLAS_NPX_PATH=/usr/bin/npx
export ATLAS_NODE_PATH=/usr/bin/node
export ATLAS_CLAUDE_PATH=/usr/local/bin/claude
export ATLAS_SQLITE3_PATH=/usr/bin/sqlite3
# No OTEL collector in this container — disable to avoid dangling metrics
unset OTEL_DENO

# ── Graceful shutdown ─────────────────────────────────────────────────────────
shutdown() {
    echo "[platform] Shutting down..."
    # Kill all background jobs
    jobs -p | xargs -r kill 2>/dev/null || true
    wait
    echo "[platform] All services stopped."
    exit 0
}
trap shutdown SIGTERM SIGINT

# ── Helpers ──────────────────────────────────────────────────────────────────

wait_for_service() {
    local name=$1
    local url=$2
    local max_attempts=60
    local attempt=0

    while [ $attempt -lt $max_attempts ]; do
        if curl -sf "$url" > /dev/null 2>&1; then
            echo "[platform] $name is ready"
            return 0
        fi
        attempt=$((attempt + 1))
        sleep 1
    done

    echo "[platform] WARNING: $name did not become healthy after ${max_attempts}s"
    return 1
}

# ── Start backend services first ─────────────────────────────────────────────

echo "[platform] Starting atlasd on :8080..."
deno run -q --allow-all \
    --unstable-worker-options --unstable-kv --unstable-raw-imports \
    apps/atlas-cli/src/cli.ts daemon start \
    --hostname 0.0.0.0 --port 8080 &
ATLASD_PID=$!

echo "[platform] Starting link on :3100..."
cd /app/apps/link
deno run --allow-all --unstable-kv src/index.ts &
LINK_PID=$!
cd /app

# Wait for backends before starting the playground — the playground proxies
# to atlasd on load, so starting it early produces 500s in the browser.
echo "[platform] Waiting for backend services..."
wait_for_service "atlasd" "http://localhost:8080/health"
wait_for_service "link"   "http://localhost:3100/health"

# ── Start playground after backends are healthy ──────────────────────────────

echo "[platform] Starting agent-playground on :5200..."
cd /app/tools/agent-playground
deno run -A npm:vite dev --host 0.0.0.0 --port 5200 &
PLAYGROUND_PID=$!
cd /app

echo "[platform] Starting pty-server on :7681..."
cd /app/tools/pty-server && deno run -A server.ts &
PTY_PID=$!
cd /app

echo "[platform] Starting webhook-tunnel on :9090..."
ATLASD_URL=http://localhost:8080 deno run --allow-all \
    /app/apps/webhook-tunnel/src/index.ts &
TUNNEL_PID=$!

wait_for_service "agent-playground" "http://localhost:5200"
wait_for_service "pty-server" "http://localhost:7681/health"
wait_for_service "webhook-tunnel" "http://localhost:9090/health"

echo ""
echo "================================================================"
echo "  Friday Platform is ready!"
echo ""
echo "  Friday Playground:   http://localhost:5200"
echo "  Daemon API:          http://localhost:8080"
echo "  Webhook Tunnel:      http://localhost:9090"
echo "  Link Service:        http://localhost:3100"
echo "  PTY Server:          http://localhost:7681"
echo "================================================================"
echo ""

# ── Keep alive ───────────────────────────────────────────────────────────────
# Wait for any service to exit — if one dies, stop everything
wait -n $ATLASD_PID $LINK_PID $PLAYGROUND_PID $PTY_PID $TUNNEL_PID 2>/dev/null || true

echo "[platform] A service exited unexpectedly. Shutting down..."
shutdown
