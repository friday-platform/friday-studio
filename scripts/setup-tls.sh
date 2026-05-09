#!/usr/bin/env bash
#
# Generate a local TLS cert pair for the dev playground + daemon, so both
# can negotiate HTTP/2 from the browser. HTTP/1.1 caps Chrome at 6 sockets
# per origin, and the playground holds 3 long-lived SSE streams plus the
# Vite HMR socket — multiple tabs deadlock waiting for a free socket. With
# HTTP/2 every fetch multiplexes onto a single connection.
#
# What this does:
#   1. Ensures `mkcert` is on PATH (brew on macOS, instruction on Linux).
#   2. Runs `mkcert -install` so the generated cert chains to a CA your OS
#      and browsers already trust — no "self-signed cert" prompts.
#   3. Generates a cert pair valid for localhost + 127.0.0.1 + ::1 in
#      `<friday-home>/tls/`, idempotent: skips regen if the existing cert
#      is still valid for >30 days.
#   4. Upserts `FRIDAY_TLS_CERT` / `FRIDAY_TLS_KEY` into `<friday-home>/.env`
#      so atlasd, the playground binary, and the Vite dev server can find
#      them at runtime.
#
# Usage:
#   bash scripts/setup-tls.sh                    # uses detected FRIDAY_HOME(s)
#   FRIDAY_HOME=/path bash scripts/setup-tls.sh  # override
#
# Idempotent. Safe to re-run after `mkcert -install` updates the local CA.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Honor SKIP_TLS=1 from any caller (setup-dev-env.sh, manual run, CI). The
# parent script already gates the call on this, but checking here too means
# `SKIP_TLS=1 bash scripts/setup-tls.sh` no-ops cleanly instead of installing
# mkcert and writing certs the user explicitly asked us to skip.
if [[ "${SKIP_TLS:-0}" == "1" ]]; then
    echo "→ SKIP_TLS=1 set — skipping TLS setup."
    echo "  Playground will run on HTTP/1.1; multi-tab dev may deadlock when"
    echo "  the 3 SSE feeds × tabs saturate Chrome's 6-socket-per-origin cap."
    exit 0
fi

# ── 1. Ensure mkcert ─────────────────────────────────────────────────────────
# mkcert ships a small self-signed CA into the OS trust store and signs
# leaf certs from it — the only sane way to get trusted certs for
# localhost without paying for ACME-via-DNS or maintaining your own CA.
if ! command -v mkcert >/dev/null 2>&1; then
    if [[ "$OSTYPE" == "darwin"* ]] && command -v brew >/dev/null 2>&1; then
        echo "→ mkcert not found — installing via Homebrew"
        brew install mkcert nss
    else
        echo "✗ mkcert not found on PATH" >&2
        echo "  install: https://github.com/FiloSottile/mkcert#installation" >&2
        echo "  on Debian/Ubuntu: apt install libnss3-tools && go install filippo.io/mkcert@latest" >&2
        exit 1
    fi
fi
echo "→ mkcert: $(command -v mkcert)"

# ── 2. Install local CA into system + browser trust stores ──────────────────
# `mkcert -install` is idempotent. First run on a machine prompts for
# admin (system keychain on macOS, sudo on Linux); subsequent runs
# detect the CA is already trusted and exit fast.
echo "→ Ensuring mkcert root CA is trusted (may prompt for admin password)"
mkcert -install

# ── 3. Resolve Friday home(s) — match setup-dev-env.sh's detection ──────────
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

# Always seed ~/.atlas/.env so the `atlas` / `atlas:dev` deno tasks (which
# load `--env-file=$HOME/.atlas/.env` at process start so DENO_CERT lands
# before Deno's RootCertStore initializes) find a usable file regardless
# of which home is the user's primary. Deno's task shell doesn't support
# ${VAR:-default} expansion, so the path is hardcoded; making sure the
# file exists is the simpler half of the contract.
if [[ ! " ${FRIDAY_HOMES[*]} " =~ " $HOME/.atlas " ]]; then
    mkdir -p "$HOME/.atlas"
    FRIDAY_HOMES+=("$HOME/.atlas")
fi

# ── 4. Generate or reuse cert per home ──────────────────────────────────────
# One cert pair covers both the playground (5200) and the daemon (8080) —
# they share the localhost / 127.0.0.1 / ::1 SAN set, so a single mkcert
# leaf is enough. Browsers cache trust by SAN+CA, not by port.
upsert_env() {
    local file="$1" key="$2" value="$3"
    if [[ -f "$file" ]] && grep -qE "^${key}=" "$file"; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            sed -i '' -E "s|^${key}=.*$|${key}=${value}|" "$file"
        else
            sed -i -E "s|^${key}=.*$|${key}=${value}|" "$file"
        fi
    else
        printf '%s=%s\n' "$key" "$value" >> "$file"
    fi
}

remove_env() {
    local file="$1" key="$2"
    [[ -f "$file" ]] || return 0
    grep -qE "^${key}=" "$file" || return 0
    if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' -E "/^${key}=/d" "$file"
    else
        sed -i -E "/^${key}=/d" "$file"
    fi
}

# Returns 0 iff openssl can verify the cert is still valid past `days_min`
# days from now. Lets idempotent re-runs skip regen instead of forcing the
# user to re-trust after every dev setup. mkcert defaults to 825-day leaf
# certs (Apple's max); we regenerate well before expiry just to be safe.
cert_is_fresh() {
    local cert="$1" days_min="${2:-30}"
    [[ -f "$cert" ]] || return 1
    command -v openssl >/dev/null 2>&1 || return 0
    local secs=$(( days_min * 86400 ))
    openssl x509 -checkend "$secs" -noout -in "$cert" >/dev/null 2>&1
}

for home in "${FRIDAY_HOMES[@]}"; do
    tls_dir="$home/tls"
    cert_file="$tls_dir/localhost.crt"
    key_file="$tls_dir/localhost.key"
    env_file="$home/.env"

    mkdir -p "$tls_dir"
    chmod 700 "$tls_dir"

    if cert_is_fresh "$cert_file"; then
        echo "→ $cert_file (valid >30d, reusing)"
    else
        echo "→ Generating $cert_file"
        # mkcert writes to the cwd; cd into tls_dir so paths land deterministically
        # regardless of where the script was invoked from.
        ( cd "$tls_dir" && mkcert -cert-file localhost.crt -key-file localhost.key \
            localhost 127.0.0.1 ::1 ) >/dev/null
    fi
    chmod 600 "$key_file"

    touch "$env_file"
    # The .env in FRIDAY_HOME holds FRIDAY_KEY and OAuth tokens elsewhere;
    # tighten perms before writing values into it. chmod is idempotent.
    chmod 600 "$env_file"
    upsert_env "$env_file" "FRIDAY_TLS_CERT" "$cert_file"
    upsert_env "$env_file" "FRIDAY_TLS_KEY"  "$key_file"
    # CA trust for runtimes that talk to the (now https) daemon over the
    # loopback, neither of which reads the system keychain by default:
    #   - DENO_CERT          → atlasd, atlas-cli, anything `deno run`
    #     (Deno ignores the keychain unless --use-system-ca is set; the env
    #      var is the cleanest way to plumb it without touching invocations)
    #   - NODE_EXTRA_CA_CERTS → vite SSR proxy, any Node tool fetching the
    #     daemon. Also set by run-playground-vite.sh for the playground;
    #     putting it in .env covers other Node entrypoints like tests
    # Intentionally NOT setting SSL_CERT_FILE: that var (honored by Python
    # httpx/requests/urllib3, curl, Rustls + rustls-native-certs) replaces
    # the system CA bundle entirely, so user agents would lose verification
    # for api.openai.com, api.anthropic.com, OAuth callbacks, OTEL exporter,
    # etc. None of those clients need to reach the local daemon over TLS
    # today; if a future path does, scope the var to that subprocess.
    # mkcert puts its CA at `mkcert -CAROOT`/rootCA.pem; resolve once.
    ca_root="$(mkcert -CAROOT 2>/dev/null)"
    if [[ -n "$ca_root" && -f "$ca_root/rootCA.pem" ]]; then
        upsert_env "$env_file" "DENO_CERT"           "$ca_root/rootCA.pem"
        upsert_env "$env_file" "NODE_EXTRA_CA_CERTS" "$ca_root/rootCA.pem"
    fi
    # Earlier versions of this script wrote SSL_CERT_FILE here; that var
    # *replaces* the system CA bundle for Python/curl/Rust callers, so
    # outbound TLS to OpenAI/Anthropic/OAuth callbacks broke. Remove any
    # legacy entry from upgraded setups.
    remove_env "$env_file" "SSL_CERT_FILE"
    echo "  → wrote FRIDAY_TLS_*, DENO_CERT, NODE_EXTRA_CA_CERTS to $env_file (chmod 600)"
done

echo ""
echo "✓ TLS ready. Restart the daemon and playground to pick up the cert:"
echo "    deno task playground   →  https://localhost:5200"
echo "    atlas daemon start     →  https://localhost:8080"
echo ""
echo "ℹ A local root CA is now installed in your system trust store (and"
echo "  Firefox/Chrome stores). Any process running as your user can mint"
echo "  certs trusted by your browsers using the key in \`mkcert -CAROOT\`."
echo "  Remove with: mkcert -uninstall"
