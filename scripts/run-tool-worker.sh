#!/usr/bin/env bash
#
# run-tool-worker.sh — launch a Friday tool worker in the current process.
#
# Designed to run INSIDE whatever sandbox the operator chose (a microVM, a k8s
# pod, a Docker container, or just a bare subprocess). It connects to NATS and
# serves tool calls until it receives SIGTERM/SIGINT.
#
# Configuration is by env vars only — no flags — so the same script works
# unchanged across runtimes:
#
#   FRIDAY_NATS_URL      Broker to connect to. Defaults to nats://localhost:4222.
#                        In sandboxes that share localhost (microvm with port
#                        forwarding, k8s sidecar) this is fine. Otherwise point
#                        at the broker reachable from inside the sandbox.
#   FRIDAY_WORKER_TOOLS  Comma-separated allowlist (e.g. "bash,webfetch").
#                        Default is all known tools.
#   FRIDAY_WORKER_CMD    Override the worker entrypoint. When set, the script
#                        execs this command verbatim (via `sh -c`) and forwards
#                        the env vars above. Right when the worker isn't our
#                        bundled tool-worker-entry — e.g. an MCP-server bridge
#                        that runs `uv run my_server` or `npx some-mcp`, or a
#                        precompiled `friday-worker` binary.
#                        When unset, we fall back to deno running our own entry.
#   FRIDAY_DENO_BIN      Path to deno (default: `deno` on PATH). Only used by
#                        the deno fallback.
#
# Why a shell script and not just exec the runtime directly? Because:
#   1. Different sandboxes pick the entrypoint by path; a single script makes
#      that one stable thing whose internals can change.
#   2. Future MCP-server bridges will use FRIDAY_WORKER_CMD to run their own
#      runtimes (uv, npx, python, docker) inside the sandbox, no edits needed.

set -euo pipefail

# If the operator gave us a worker command, run it verbatim. We don't try to
# parse it — a workspace-level MCP bridge can pass `uv run mcp-foo` or
# `npx -y @org/mcp-bar` and we just exec.
if [ -n "${FRIDAY_WORKER_CMD:-}" ]; then
  exec sh -c "$FRIDAY_WORKER_CMD"
fi

# Default: run our bundled tool-worker-entry under deno. This is what the
# daemon's local `subprocess` launcher does today.
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$REPO_ROOT/apps/atlasd/src/tool-worker-entry.ts"

DENO_BIN="${FRIDAY_DENO_BIN:-deno}"
if ! command -v "$DENO_BIN" >/dev/null 2>&1; then
  echo "run-tool-worker: deno binary not found ('$DENO_BIN'). Set FRIDAY_DENO_BIN" >&2
  echo "                 or set FRIDAY_WORKER_CMD to use a different runtime." >&2
  exit 127
fi

if [ ! -f "$ENTRY" ]; then
  echo "run-tool-worker: entry not found at $ENTRY" >&2
  exit 1
fi

exec "$DENO_BIN" run \
  --allow-all \
  --unstable-kv \
  --unstable-worker-options \
  "$ENTRY"
