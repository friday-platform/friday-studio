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

# ── Resolve Friday home ─────────────────────────────────────────────────────
# Two possible homes — match the daemon's resolution:
#   - Launcher mode: launcher sets FRIDAY_HOME=~/.friday/local before spawning
#     the daemon. packages/utils/src/paths.ts:getFridayHome reads that.
#   - Out-of-tree dev mode: daemon falls through to ~/.atlas (the TS-side
#     default when FRIDAY_HOME is unset and we're not in system mode).
#
# Detection: pick the home that holds live daemon state (agents/, chats/,
# sessions/ — anything beyond pids/ and our own uv/ scratch dir). Fall back
# to whichever has a populated .env, then to the canonical new path.
declare -a FRIDAY_HOMES=()
detect_home() {
    local candidate="$1"
    [[ -d "$candidate" ]] || return 1
    # Live state markers — daemon writes these
    for marker in agents chats sessions activity.db skills.db storage.db; do
        if [[ -e "$candidate/$marker" ]]; then return 0; fi
    done
    return 1
}

if [[ -n "${FRIDAY_HOME:-}" ]]; then
    FRIDAY_HOMES=("$FRIDAY_HOME")
else
    # Both candidates can be active (launcher run + out-of-tree run on
    # the same machine). Write to whichever has live state; if both, write
    # to both — keeps env vars coherent across both daemon launch modes.
    detect_home "$HOME/.atlas" && FRIDAY_HOMES+=("$HOME/.atlas")
    detect_home "$HOME/.friday/local" && FRIDAY_HOMES+=("$HOME/.friday/local")
    # Neither has state? Use canonical new path.
    if [[ ${#FRIDAY_HOMES[@]} -eq 0 ]]; then
        FRIDAY_HOMES=("$HOME/.friday/local")
        mkdir -p "${FRIDAY_HOMES[0]}"
    fi
fi

echo "→ Friday home(s): ${FRIDAY_HOMES[*]}"
echo "→ Pinned SDK:    friday-agent-sdk==$PINNED_SDK_VERSION"

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
        # Homebrew/system Pythons are PEP 668 "externally managed" and refuse
        # `pip uninstall` without --break-system-packages. We're explicitly
        # uninstalling a stale dev install we own, so the flag is the
        # correct tool here. Suppress success/failure noise but capture for
        # the post-loop verification.
        "$py" -m pip uninstall -y --break-system-packages friday-agent-sdk \
            >/dev/null 2>&1 || \
            "$py" -m pip uninstall -y friday-agent-sdk >/dev/null 2>&1 || true
        # Verify and warn if it didn't take. uv-run in step 4 still
        # produces the clean SDK so the daemon's primary path is fine —
        # but bare-python3 fallback would still hit the stale path.
        if "$py" -c "import friday_agent_sdk" >/dev/null 2>&1; then
            still_at=$("$py" -c "import friday_agent_sdk; print(friday_agent_sdk.__file__)" 2>/dev/null || echo "<unknown>")
            echo "  ⚠ uninstall did not take — $py still resolves friday_agent_sdk at $still_at"
            echo "    (daemon uv-run path is unaffected; only the dev fallback would hit this)"
        fi
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

for home in "${FRIDAY_HOMES[@]}"; do
    ENV_FILE="$home/.env"
    touch "$ENV_FILE"
    upsert_env "FRIDAY_UV_PATH"            "$UV_PATH"
    upsert_env "UV_PYTHON_INSTALL_DIR"     "$home/uv/python"
    upsert_env "UV_CACHE_DIR"              "$home/uv/cache"
    upsert_env "FRIDAY_AGENT_SDK_VERSION"  "$PINNED_SDK_VERSION"
    echo "→ Wrote env vars to $ENV_FILE"
done

# ── 4. Pre-warm uv cache ────────────────────────────────────────────────────
# Triggers Python 3.12 download (if missing) and friday-agent-sdk wheel fetch.
# First run: ~5–30s depending on network. Subsequent runs: noop.
# Warm the *first* home — uv's cache is content-addressed, so warming
# either path effectively warms shared wheel storage; pre-warming both is
# wasteful. Use the first detected home (preferring live state).
PRIMARY_HOME="${FRIDAY_HOMES[0]}"
echo "→ Pre-warming uv cache at $PRIMARY_HOME/uv/ (Python 3.12 + friday-agent-sdk==$PINNED_SDK_VERSION)"
UV_PYTHON_INSTALL_DIR="$PRIMARY_HOME/uv/python" \
UV_CACHE_DIR="$PRIMARY_HOME/uv/cache" \
"$UV_PATH" run --python 3.12 \
    --with "friday-agent-sdk==$PINNED_SDK_VERSION" \
    python -c "import friday_agent_sdk; print(f'  ✓ friday_agent_sdk imported from {friday_agent_sdk.__file__}')"

echo ""
echo "✓ Dev environment ready."
echo "  Daemon will spawn user agents via:"
echo "    $UV_PATH run --python 3.12 --with friday-agent-sdk==$PINNED_SDK_VERSION agent.py"
