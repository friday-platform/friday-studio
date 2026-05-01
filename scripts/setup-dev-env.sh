#!/usr/bin/env bash
#
# Friday-studio dev-environment setup. Run once after cloning, and again
# whenever the pinned friday-agent-sdk version bumps in
# tools/friday-launcher/paths.go (`bundledAgentSDKVersion`).
#
# What this does:
#   1. Verifies `uv` is on PATH (or installs it from astral.sh).
#   2. Writes FRIDAY_UV_PATH / UV_PYTHON_INSTALL_DIR / UV_CACHE_DIR /
#      FRIDAY_AGENT_SDK_VERSION into the daemon's .env so the spawn-resolution
#      path in apps/atlasd/src/agent-spawn.ts picks up uv-run.
#   3. Pre-warms the uv cache so the first user-agent spawn doesn't pay
#      the Python 3.12 download + SDK wheel fetch as cold-start.
#   4. Uninstalls any editable / system-Python `friday-agent-sdk` installs
#      that would shadow the uv-managed one. (See plans/user-agent-sdk-cohesion.md
#      § E1 — historical local installs from before the PyPI release have
#      been silently masking install gaps for in-tree dev.)
#
# This is NOT part of the installer flow. The installer's launcher emits
# the same env vars at runtime. This script is in-tree dev only.
#
# Usage:  bash scripts/setup-dev-env.sh
# Idempotent: safe to re-run.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Pinned SDK version (must match tools/friday-launcher/paths.go) ──────────
PINNED_SDK_VERSION=$(
    grep -E '^const bundledAgentSDKVersion' \
        "$REPO_ROOT/tools/friday-launcher/paths.go" \
        | sed -E 's/.*= *"([^"]+)".*/\1/'
)
if [[ -z "${PINNED_SDK_VERSION:-}" ]]; then
    echo "✗ could not parse bundledAgentSDKVersion from tools/friday-launcher/paths.go" >&2
    exit 1
fi

# ── Resolve Friday home (canonical: ~/.friday/local; legacy: ~/.atlas) ──────
if [[ -d "$HOME/.friday/local" ]]; then
    FRIDAY_HOME="$HOME/.friday/local"
elif [[ -d "$HOME/.atlas" ]]; then
    FRIDAY_HOME="$HOME/.atlas"
else
    FRIDAY_HOME="$HOME/.friday/local"
    mkdir -p "$FRIDAY_HOME"
fi
ENV_FILE="$FRIDAY_HOME/.env"

echo "→ Friday home: $FRIDAY_HOME"
echo "→ Pinned SDK:  friday-agent-sdk==$PINNED_SDK_VERSION"

# ── 1. Ensure uv is on PATH ─────────────────────────────────────────────────
if ! command -v uv >/dev/null 2>&1; then
    echo "→ uv not found — installing from astral.sh"
    curl -LsSf https://astral.sh/uv/install.sh | sh
    # The installer adds to ~/.local/bin; pick it up for this script's session.
    export PATH="$HOME/.local/bin:$PATH"
fi
UV_PATH="$(command -v uv)"
echo "→ uv:          $UV_PATH"

# ── 2. Uninstall stale editable / system-Python friday-agent-sdk installs ───
# Historic editable installs (e.g. /Users/<you>/tempest/agent-sdk/packages/python)
# silently shadow the uv-managed SDK and have caused real "works on my
# machine" divergence. Strip them.
declare -a STALE_PYTHONS=()
if command -v python3 >/dev/null 2>&1; then
    STALE_PYTHONS+=("$(command -v python3)")
fi
# Common Homebrew-installed alternates that may also have it editable.
for v in 3.12 3.13 3.14; do
    if command -v "python$v" >/dev/null 2>&1; then
        STALE_PYTHONS+=("$(command -v "python$v")")
    fi
done

for py in "${STALE_PYTHONS[@]}"; do
    if "$py" -c "import friday_agent_sdk" >/dev/null 2>&1; then
        installed=$("$py" -c "import friday_agent_sdk; print(friday_agent_sdk.__file__)" 2>/dev/null || echo "<unknown>")
        echo "→ Removing stale install at $installed (was importable from $py)"
        "$py" -m pip uninstall -y friday-agent-sdk >/dev/null 2>&1 || true
    fi
done

# ── 3. Write env vars to the daemon's .env (idempotent upsert) ──────────────
upsert_env() {
    local key="$1"
    local value="$2"
    if [[ -f "$ENV_FILE" ]] && grep -qE "^${key}=" "$ENV_FILE"; then
        # Replace existing line in-place (BSD sed compatible: provide -i '' on macOS).
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' -E "s|^${key}=.*$|${key}=${value}|" "$ENV_FILE"
        else
            sed -i -E "s|^${key}=.*$|${key}=${value}|" "$ENV_FILE"
        fi
    else
        printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
    fi
}

touch "$ENV_FILE"
upsert_env "FRIDAY_UV_PATH"            "$UV_PATH"
upsert_env "UV_PYTHON_INSTALL_DIR"     "$FRIDAY_HOME/uv/python"
upsert_env "UV_CACHE_DIR"              "$FRIDAY_HOME/uv/cache"
upsert_env "FRIDAY_AGENT_SDK_VERSION"  "$PINNED_SDK_VERSION"

echo "→ Wrote env vars to $ENV_FILE"

# ── 4. Pre-warm uv cache ────────────────────────────────────────────────────
# Triggers Python 3.12 download (if missing) and friday-agent-sdk wheel fetch.
# First run: ~5–30s depending on network. Subsequent runs: noop.
echo "→ Pre-warming uv cache (Python 3.12 + friday-agent-sdk==$PINNED_SDK_VERSION)"
UV_PYTHON_INSTALL_DIR="$FRIDAY_HOME/uv/python" \
UV_CACHE_DIR="$FRIDAY_HOME/uv/cache" \
"$UV_PATH" run --python 3.12 \
    --with "friday-agent-sdk==$PINNED_SDK_VERSION" \
    python -c "import friday_agent_sdk; print(f'  ✓ friday_agent_sdk imported from {friday_agent_sdk.__file__}')"

echo ""
echo "✓ Dev environment ready."
echo "  Daemon will spawn user agents via:"
echo "    $UV_PATH run --python 3.12 --with friday-agent-sdk==$PINNED_SDK_VERSION agent.py"
