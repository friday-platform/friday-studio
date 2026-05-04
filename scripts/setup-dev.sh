#!/usr/bin/env bash
set -euo pipefail

# This script launches Claude with --dangerously-skip-permissions, which is
# only safe inside the ephemeral Minimal sandbox. Refuse to run on a host
# shell so an accidental invocation cannot lower safety.
if [ "${IS_SANDBOX:-}" != "1" ]; then
  echo "scripts/setup-dev.sh must be run inside the Minimal sandbox (IS_SANDBOX=1)." >&2
  echo "Use 'min run dev' instead." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# One-shot install: deno deps, .env, uv pre-warm. Idempotent.
bash "$SCRIPT_DIR/min-setup.sh"

# Pin daemon state under the project so it persists across sandbox runs
# (the sandbox HOME mount is read-only).
export FRIDAY_HOME="${FRIDAY_HOME:-$REPO_ROOT/.friday-home}"

# tmux layout:
#   pane 0 (left)        — claude
#   pane 1 (right-top)   — daemon (`deno task atlas daemon start`)
#   pane 2 (right-bottom)— bash shell, FRIDAY_HOME exported
tmux -f tmux.conf new-session -d -s dev -x 220 -y 50
tmux send-keys -t dev:0.0 'claude --dangerously-skip-permissions' Enter

tmux split-window -t dev:0.0 -h
tmux send-keys -t dev:0.1 "export FRIDAY_HOME=$FRIDAY_HOME && deno task atlas daemon start" Enter

tmux split-window -t dev:0.1 -v "bash"
tmux send-keys -t dev:0.2 "export FRIDAY_HOME=$FRIDAY_HOME" Enter
tmux send-keys -t dev:0.2 "echo 'Daemon: top-right pane. Health: curl http://localhost:8080/health'" Enter

tmux select-layout -t dev main-vertical
tmux select-pane -t dev:0.0
tmux attach-session -t dev
