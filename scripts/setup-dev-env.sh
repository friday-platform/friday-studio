#!/usr/bin/env bash
#
# Friday-studio dev-environment bootstrap. Run once after cloning, and
# again whenever the pinned friday-agent-sdk version bumps in
# tools/friday-launcher/paths.go (`bundledAgentSDKVersion`).
#
# What this does:
#   0. Preflight: verifies `node` (>= MIN) and `git` are on PATH. We do
#      not auto-install these — Node has too many version-manager flavors
#      (nvm/fnm/volta/asdf/system) to clobber safely, and git on macOS
#      triggers an interactive xcode-select GUI prompt that would stall
#      the script.
#   1. Installs Deno if missing or below MIN (user-scoped curl install)
#      and runs `deno install` for JS/TS workspace deps.
#   2. Installs Go if missing or below MIN — Homebrew on macOS only; Linux
#      tarball installs need sudo / PATH wiring we don't assume.
#   3. Installs uv if missing or below MIN (curl from astral.sh).
#   4. Installs nats-server if missing or below MIN (Homebrew on macOS,
#      otherwise `go install` from the pinned tag — used by the daemon's
#      JetStream bus, see packages/jetstream/src/spawn.ts).
#   5. Installs agent-browser CLI if missing (npm + `agent-browser install`
#      to fetch its Chromium — used by the bundled `web` agent).
#   6. Uninstalls editable / system-Python `friday-agent-sdk` installs that
#      would shadow the uv-managed one. (See plans/user-agent-sdk-cohesion.md
#      § E1 — historical local installs from before the PyPI release have
#      been silently masking install gaps for in-tree dev.)
#   7. Writes daemon envfile (FRIDAY_UV_PATH, UV_*, FRIDAY_AGENT_SDK_VERSION,
#      FRIDAY_JETSTREAM_STORE_DIR).
#   8. Pre-warms the uv cache (Python 3.12 + pinned SDK).
#
# Each tool's existing install is **preferred** if it satisfies the
# minimum version — we never replace a working toolchain. Auto-install
# only triggers on missing or stale.
#
# This is NOT part of the installer flow. The installer's launcher emits
# the same env vars at runtime and bundles its own nats-server + Chromium.
# This script is in-tree dev only.
#
# Usage:  bash scripts/setup-dev-env.sh
# Idempotent.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Pinned versions ─────────────────────────────────────────────────────────
# Pinned (must match repo state):
PINNED_SDK_VERSION=$(
    grep -E '^const bundledAgentSDKVersion' \
        "$REPO_ROOT/tools/friday-launcher/paths.go" \
        | sed -E 's/.*= *"([^"]+)".*/\1/'
)
if [[ -z "${PINNED_SDK_VERSION:-}" ]]; then
    echo "✗ could not parse bundledAgentSDKVersion from tools/friday-launcher/paths.go" >&2
    exit 1
fi
# nats-server pin — keep aligned with the `nats:<version>-alpine` line in
# the repo's Dockerfile. Bump together when upgrading.
PINNED_NATS_VERSION="v2.12.8"

# Minimum versions (mirror the README's prerequisites table). When a tool
# is already on PATH at >= MIN, we keep it and don't reinstall.
DENO_MIN="2.7.0"
NODE_MIN="24.0.0"
GO_MIN="1.26.0"
UV_MIN="0.11.0"
NATS_MIN="2.12.0"

# ── Version helpers ─────────────────────────────────────────────────────────
# version_ge "1.2.3" "1.2.0" → returns 0 (true) iff first >= second.
# Uses `sort -V` (POSIX-portable on macOS BSD coreutils + GNU coreutils).
version_ge() {
    [[ "$(printf '%s\n%s\n' "$2" "$1" | sort -V | head -1)" == "$2" ]]
}

# Extract a tool's version string. Returns empty if it can't parse, which
# `check_min_version` below treats as "assume OK" (don't punish edge formats).
get_tool_version() {
    case "$1" in
        deno)        deno --version 2>/dev/null | head -1 | awk '{print $2}' ;;
        node)        node --version 2>/dev/null | sed 's/^v//' ;;
        go)          go version 2>/dev/null | awk '{print $3}' | sed 's/^go//' ;;
        uv)          uv --version 2>/dev/null | awk '{print $2}' ;;
        nats-server) nats-server --version 2>/dev/null | awk '{print $NF}' | sed 's/^v//' ;;
    esac
}

# Returns 0 if installed and >= min; 1 if installed but too old; 2 if missing.
check_min_version() {
    local tool="$1" min="$2"
    if ! command -v "$tool" >/dev/null 2>&1; then
        return 2
    fi
    local v
    v="$(get_tool_version "$tool")"
    if [[ -z "$v" ]]; then
        # Couldn't parse — assume OK rather than reinstalling something
        # that's working. Surface a hint in case it's actually broken.
        echo "  ⚠ $tool present but couldn't parse version — keeping as-is" >&2
        return 0
    fi
    if version_ge "$v" "$min"; then
        return 0
    fi
    return 1
}

# brew_install_or_upgrade <formula>: returns 0 on success, 1 if Homebrew
# isn't usable on this platform. Picks `upgrade` for an already-installed
# formula (since `brew install` on an existing formula is a no-op, not an
# upgrade — the script's stale branches need explicit `upgrade`). This
# also lets the deno/uv stale paths avoid `deno upgrade` / `uv self update`,
# which fail on Homebrew-managed installs.
brew_install_or_upgrade() {
    [[ "$OSTYPE" == "darwin"* ]] || return 1
    command -v brew >/dev/null 2>&1 || return 1
    if brew list "$1" >/dev/null 2>&1; then
        brew upgrade "$1"
    else
        brew install "$1"
    fi
}

# is_brew_managed <tool-name>: returns 0 iff the tool currently on PATH
# resolves into Homebrew's prefix. Used to gate stale-branch upgrades:
# without this check, a curl-installed (e.g. ~/.deno/bin/deno) tool that's
# below MIN would trigger `brew install <tool>`, dropping a second copy
# alongside the first and leaving PATH order to pick the winner. With it,
# we only route through brew when brew already owns the binary — otherwise
# fall through to the tool's own self-upgrade (or, for tools without one,
# a clear fail-fast asking the user to upgrade via their existing manager).
is_brew_managed() {
    [[ "$OSTYPE" == "darwin"* ]] || return 1
    command -v brew >/dev/null 2>&1 || return 1
    local p prefix resolved
    p="$(command -v "$1" 2>/dev/null)"
    [[ -n "$p" ]] || return 1
    prefix="$(brew --prefix 2>/dev/null)"
    [[ -n "$prefix" ]] || return 1
    # Resolve symlinks. macOS BSD `readlink` lacks `-f`, so use `realpath`
    # if present, else fall back to comparing the symlink path itself —
    # which still hits brew's prefix for the canonical /opt/homebrew/bin
    # entries that brew installs.
    resolved="$p"
    if command -v realpath >/dev/null 2>&1; then
        resolved="$(realpath "$p" 2>/dev/null || echo "$p")"
    fi
    [[ "$resolved" == "$prefix"/* || "$p" == "$prefix"/* ]]
}

# Tools that this run elected to skip rather than fail. Surfaced in the
# final summary so the user knows which functionality won't work yet.
declare -a SKIPPED_TOOLS=()

# ── 0. Preflight: tools we do not auto-install ──────────────────────────────
# macOS-only: Xcode Command Line Tools provide git, make, and the toolchain
# Homebrew itself depends on. Without CLT, `git --version` triggers an
# interactive GUI install prompt via the xcrun shim — we'd rather catch
# that here with a clear message than mid-flight.
if [[ "$OSTYPE" == "darwin"* ]] && ! xcode-select -p >/dev/null 2>&1; then
    echo "✗ Xcode Command Line Tools not installed" >&2
    echo "  macOS requires CLT for git, make, and the Homebrew toolchain." >&2
    echo "  Install: xcode-select --install" >&2
    echo "  (a GUI prompt will appear; complete it and re-run this script)" >&2
    exit 1
fi

preflight_failed=0
case "$(check_min_version node "$NODE_MIN"; echo $?)" in
    0) echo "→ node:          $(command -v node) ($(get_tool_version node))" ;;
    1) echo "✗ node $(get_tool_version node) is below minimum $NODE_MIN" >&2
       echo "  upgrade via your Node manager (fnm/volta/nvm) — we don't auto-install Node" >&2
       preflight_failed=1 ;;
    2) echo "✗ node not found on PATH" >&2
       echo "  install: Node.js $NODE_MIN+ — recommended via fnm/volta/nvm (https://nodejs.org/)" >&2
       preflight_failed=1 ;;
esac
if ! command -v git >/dev/null 2>&1; then
    echo "✗ git not found on PATH" >&2
    echo "  install: git via your system package manager (https://git-scm.com/)" >&2
    preflight_failed=1
fi
if [[ $preflight_failed -eq 1 ]]; then
    echo "" >&2
    echo "Install the missing tools above and re-run this script." >&2
    exit 1
fi
echo "→ git:           $(command -v git)"

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
    for marker in agents chats sessions activity.db skills.db storage.db; do
        if [[ -e "$candidate/$marker" ]]; then return 0; fi
    done
    return 1
}

if [[ -n "${FRIDAY_HOME:-}" ]]; then
    FRIDAY_HOMES=("$FRIDAY_HOME")
else
    detect_home "$HOME/.atlas" && FRIDAY_HOMES+=("$HOME/.atlas")
    detect_home "$HOME/.friday/local" && FRIDAY_HOMES+=("$HOME/.friday/local")
    if [[ ${#FRIDAY_HOMES[@]} -eq 0 ]]; then
        FRIDAY_HOMES=("$HOME/.friday/local")
        mkdir -p "${FRIDAY_HOMES[0]}"
    fi
fi

echo "→ Friday home(s): ${FRIDAY_HOMES[*]}"
echo "→ Pinned SDK:     friday-agent-sdk==$PINNED_SDK_VERSION"
echo "→ Pinned NATS:    nats-server $PINNED_NATS_VERSION"

# ── 1. Ensure Deno + workspace deps ─────────────────────────────────────────
case "$(check_min_version deno "$DENO_MIN"; echo $?)" in
    0) echo "→ deno:          $(command -v deno) ($(get_tool_version deno))" ;;
    1) if is_brew_managed deno; then
           echo "→ deno (homebrew) is below $DENO_MIN — upgrading via brew"
           brew_install_or_upgrade deno
       else
           echo "→ deno $(get_tool_version deno) is below $DENO_MIN — upgrading via deno upgrade"
           deno upgrade
       fi ;;
    2) echo "→ deno not found — installing user-scoped from deno.land"
       echo "  ℹ The Deno installer will ask which shells to configure (e.g. [ ] bash)."
       echo "    Use ↑/↓ to navigate, Space to toggle, Enter to confirm."
       curl -fsSL https://deno.land/install.sh | sh
       export PATH="$HOME/.deno/bin:$PATH"
       if ! command -v deno >/dev/null 2>&1; then
           echo "✗ deno install completed but \`deno\` still not on PATH." >&2
           echo "  Add to your shell profile: export PATH=\"\$HOME/.deno/bin:\$PATH\"" >&2
           exit 1
       fi
       echo "→ deno:          $(command -v deno) ($(get_tool_version deno))" ;;
esac
echo "→ Running deno install (idempotent — fast on re-runs)"
( cd "$REPO_ROOT" && deno install )

# ── 2. Ensure Go ────────────────────────────────────────────────────────────
# Used to build apps/atlas-cli's Go services and (below, fallback path) to
# `go install` nats-server. Auto-install only on macOS via brew — Linux
# tarball installs to /usr/local/go need sudo we don't want to assume,
# and shadowing an asdf/gvm-managed Go is a common footgun.
install_go_via_brew_or_fail() {
    if brew_install_or_upgrade go; then
        return 0
    fi
    echo "✗ Go $1 — install or upgrade manually: https://go.dev/dl/" >&2
    echo "  (auto-install on Linux skipped to avoid sudo / asdf clobber)" >&2
    exit 1
}
case "$(check_min_version go "$GO_MIN"; echo $?)" in
    0) echo "→ go:            $(command -v go) ($(get_tool_version go))" ;;
    1) # Stale: only auto-upgrade if the existing binary is brew-managed.
       # Otherwise (asdf/gvm/manual install, system tarball) we'd shadow
       # their toolchain with a brew copy — defer to their installer.
       if is_brew_managed go; then
           echo "→ go (homebrew) is below $GO_MIN — upgrading via brew"
           brew_install_or_upgrade go
       else
           echo "✗ go $(get_tool_version go) is below $GO_MIN" >&2
           echo "  Upgrade via your existing installer (asdf/gvm/system) and re-run." >&2
           echo "  Auto-upgrade skipped to avoid shadowing the existing Go with a brew copy." >&2
           exit 1
       fi ;;
    2) echo "→ go not found — installing"
       install_go_via_brew_or_fail "missing" ;;
esac

# ── 3. Ensure uv ────────────────────────────────────────────────────────────
case "$(check_min_version uv "$UV_MIN"; echo $?)" in
    0) echo "→ uv:            $(command -v uv) ($(get_tool_version uv))" ;;
    1) if is_brew_managed uv; then
           echo "→ uv (homebrew) is below $UV_MIN — upgrading via brew"
           brew_install_or_upgrade uv
       else
           echo "→ uv $(get_tool_version uv) is below $UV_MIN — upgrading via uv self update"
           uv self update
       fi ;;
    2) echo "→ uv not found — installing from astral.sh"
       curl -LsSf https://astral.sh/uv/install.sh | sh
       export PATH="$HOME/.local/bin:$PATH"
       echo "→ uv:            $(command -v uv) ($(get_tool_version uv))" ;;
esac
UV_PATH="$(command -v uv)"

# ── 4. Ensure nats-server ───────────────────────────────────────────────────
# Daemon spawns nats-server for the JetStream bus
# (packages/jetstream/src/spawn.ts).
install_nats_server() {
    if brew_install_or_upgrade nats-server; then
        return 0
    fi
    echo "  via: go install github.com/nats-io/nats-server/v2@$PINNED_NATS_VERSION"
    go install "github.com/nats-io/nats-server/v2@$PINNED_NATS_VERSION"
    # go install writes to $(go env GOBIN) or $(go env GOPATH)/bin. The
    # daemon's `which nats-server` won't find it unless that's on PATH.
    local gobin
    gobin="$(go env GOBIN)"
    [[ -z "$gobin" ]] && gobin="$(go env GOPATH)/bin"
    # Prefer symlinking into ~/.local/bin if it's writable and on PATH —
    # the uv installer adds ~/.local/bin to PATH for most users, so this
    # makes the install idempotent across fresh-shell re-runs without
    # requiring the user to edit their shell profile for $gobin.
    if [[ -x "$gobin/nats-server" ]] && [[ -d "$HOME/.local/bin" ]] \
        && echo ":$PATH:" | grep -q ":$HOME/.local/bin:"; then
        ln -sf "$gobin/nats-server" "$HOME/.local/bin/nats-server"
        echo "  → symlinked $gobin/nats-server → $HOME/.local/bin/nats-server"
    elif ! echo ":$PATH:" | grep -q ":$gobin:"; then
        export PATH="$gobin:$PATH"
        echo "  ⚠ $gobin is not on your PATH — add this to your shell profile:"
        echo "      export PATH=\"$gobin:\$PATH\""
    fi
}
case "$(check_min_version nats-server "$NATS_MIN"; echo $?)" in
    0) echo "→ nats-server:   $(command -v nats-server) ($(get_tool_version nats-server))" ;;
    1) # Stale: same shadow-avoidance logic as Go. If the existing binary
       # came from `go install` or a manual download, brew-installing
       # would put a second copy alongside; defer to whoever owns it.
       if is_brew_managed nats-server; then
           echo "→ nats-server (homebrew) is below $NATS_MIN — upgrading via brew"
           brew_install_or_upgrade nats-server
       else
           echo "✗ nats-server $(get_tool_version nats-server) is below $NATS_MIN" >&2
           echo "  Upgrade via wherever it came from (go install, GitHub release, etc.) and re-run." >&2
           echo "  Auto-upgrade skipped to avoid shadowing with a brew copy." >&2
           exit 1
       fi ;;
    2) echo "→ nats-server not found — installing $PINNED_NATS_VERSION"
       install_nats_server ;;
esac
if ! command -v nats-server >/dev/null 2>&1; then
    echo "✗ nats-server still not on PATH after install attempt" >&2
    echo "  fix manually: brew install nats-server  (or download from" >&2
    echo "  https://github.com/nats-io/nats-server/releases)" >&2
    exit 1
fi

# ── 5. Ensure agent-browser CLI ─────────────────────────────────────────────
# The bundled `web` agent (packages/bundled-agents/src/web/) shells out to
# the agent-browser CLI to drive Chromium. The install pulls a Chromium
# build (~150MB) on first run; soft-failure if npm rejects (system Node
# permissions) — daemon doesn't hard-depend on this, only web agents do.
# No min version — agent-browser releases fast and we want latest.
if ! command -v agent-browser >/dev/null 2>&1; then
    echo "→ agent-browser not found — installing globally via npm"
    if ! npm i -g agent-browser; then
        echo "  ⚠ npm install failed (likely a permissions issue on a system Node)." >&2
        echo "    Re-run with sudo, or use a user-scoped Node manager (nvm/fnm/volta)." >&2
        echo "    Skipping agent-browser — web/browser agents will not work until installed." >&2
    fi
fi
if command -v agent-browser >/dev/null 2>&1; then
    # `agent-browser install` is idempotent: re-runs verify the cached
    # Chromium and exit fast if already present.
    if ! agent-browser install >/dev/null 2>&1; then
        echo "  ⚠ agent-browser install failed — run manually to debug:" >&2
        echo "      agent-browser install" >&2
        SKIPPED_TOOLS+=("agent-browser install (Chromium fetch) — re-run \`agent-browser install\` to debug")
    fi
    echo "→ agent-browser: $(command -v agent-browser)"
else
    echo "→ agent-browser: SKIPPED (web/browser agents disabled until installed)"
    SKIPPED_TOOLS+=("agent-browser — web/browser agents disabled. Switch to a user-scoped Node manager (fnm/volta/nvm) and re-run.")
fi

# ── 6. Uninstall stale editable / system-Python friday-agent-sdk installs ───
# Historic editable installs (e.g. /Users/<you>/tempest/agent-sdk/packages/python)
# silently shadow the uv-managed SDK and have caused real "works on my
# machine" divergence. Strip them.
declare -a STALE_PYTHONS=()
if command -v python3 >/dev/null 2>&1; then
    STALE_PYTHONS+=("$(command -v python3)")
fi
for v in 3.12 3.13 3.14; do
    if command -v "python$v" >/dev/null 2>&1; then
        STALE_PYTHONS+=("$(command -v "python$v")")
    fi
done
# Dedup: python3 and python3.12 commonly resolve to the same binary on
# Homebrew. `[[ a -ef b ]]` tests same-inode (POSIX-ish, supported in bash).
if [[ ${#STALE_PYTHONS[@]} -gt 1 ]]; then
    declare -a _deduped=()
    for p in "${STALE_PYTHONS[@]}"; do
        _seen=0
        for d in "${_deduped[@]:-}"; do
            [[ -n "$d" && "$p" -ef "$d" ]] && { _seen=1; break; }
        done
        [[ $_seen -eq 0 ]] && _deduped+=("$p")
    done
    STALE_PYTHONS=("${_deduped[@]}")
fi

for py in "${STALE_PYTHONS[@]}"; do
    if "$py" -c "import friday_agent_sdk" >/dev/null 2>&1; then
        installed=$("$py" -c "import friday_agent_sdk; print(friday_agent_sdk.__file__)" 2>/dev/null || echo "<unknown>")
        echo "→ Removing stale install at $installed (was importable from $py)"
        # PEP 668 "externally managed" Pythons (Homebrew, system) refuse
        # `pip uninstall` without --break-system-packages. We're explicitly
        # uninstalling a stale dev install we own, so the flag is correct.
        "$py" -m pip uninstall -y --break-system-packages friday-agent-sdk \
            >/dev/null 2>&1 || \
            "$py" -m pip uninstall -y friday-agent-sdk >/dev/null 2>&1 || true
        if "$py" -c "import friday_agent_sdk" >/dev/null 2>&1; then
            still_at=$("$py" -c "import friday_agent_sdk; print(friday_agent_sdk.__file__)" 2>/dev/null || echo "<unknown>")
            echo "  ⚠ uninstall did not take — $py still resolves friday_agent_sdk at $still_at"
            echo "    (daemon uv-run path is unaffected; only the dev fallback would hit this)"
        fi
    fi
done

# ── 7. Write env vars to the daemon's .env (idempotent upsert) ──────────────
upsert_env() {
    local key="$1"
    local value="$2"
    if [[ -f "$ENV_FILE" ]] && grep -qE "^${key}=" "$ENV_FILE"; then
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
    upsert_env "FRIDAY_UV_PATH"               "$UV_PATH"
    upsert_env "UV_PYTHON_INSTALL_DIR"        "$home/uv/python"
    upsert_env "UV_CACHE_DIR"                 "$home/uv/cache"
    upsert_env "FRIDAY_AGENT_SDK_VERSION"     "$PINNED_SDK_VERSION"
    # JetStream store dir: identical to the daemon/launcher default
    # (apps/atlasd/src/nats-manager.ts and tools/friday-launcher/project.go
    # both compute join(getFridayHome(), "nats")). Pinned in .env so the
    # value is immune to default-changes and visible in `cat ~/.atlas/.env`
    # for operators debugging. nats-server appends `jetstream/` itself, so
    # data lands at $home/nats/jetstream/$G/streams/...
    upsert_env "FRIDAY_JETSTREAM_STORE_DIR"   "$home/nats"
    echo "→ Wrote env vars to $ENV_FILE"
done

# ── 8. Pre-warm uv cache ────────────────────────────────────────────────────
# `uv run --python 3.12` auto-fetches the interpreter on first use — no
# separate `uv python install` is needed. This step pre-pays that download
# plus the friday-agent-sdk wheel fetch so the daemon's first user-agent
# spawn isn't a cold start.
# First run: ~5–30s. Subsequent runs: noop. uv's cache is content-addressed,
# so warming either FRIDAY_HOME shares wheel storage; pre-warm only the
# first detected home.
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

if [[ ${#SKIPPED_TOOLS[@]} -gt 0 ]]; then
    echo ""
    echo "⚠ Skipped (re-run after fixing to enable):"
    for t in "${SKIPPED_TOOLS[@]}"; do
        echo "  - $t"
    done
fi
