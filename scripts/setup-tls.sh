#!/usr/bin/env bash
#
# Generate the TLS material the playground + daemon + webhook-tunnel need
# for local dev. Produces two cert chains with different trust requirements:
#
#   1. Browser-facing chain (the playground origin only)
#      Signed by mkcert's local CA, which `mkcert -install` adds to the
#      OS + browser trust stores. Required so Chrome/Safari accept
#      https://localhost:5200 without warnings — the only endpoint a human
#      browser hits directly.
#
#   2. Server-to-server chain (atlasd + webhook-tunnel)
#      Signed by a private CA generated locally with openssl. NOT installed
#      in any system trust store. Trust is plumbed per-process via
#      `DENO_CERT` (atlasd, atlas-cli) and `NODE_EXTRA_CA_CERTS` (vite SSR,
#      static-server proxy). The browser never sees these certs because
#      the playground proxies `/api/daemon/*` and `/api/tunnel/*` itself.
#
# Why split: the original single-cert design forced `mkcert -install`
# on every machine just to talk to the daemon and tunnel. Splitting lets
# headless/CI environments skip the system-trust step entirely
# (`SKIP_MKCERT=1`) while keeping the dev cycle working.
#
# Why HTTP/2 still matters: the playground holds 3 long-lived SSE feeds
# per tab plus the Vite HMR socket. Two open tabs saturate Chrome's
# 6-socket-per-origin HTTP/1.1 cap and every fetch (page document
# included) stalls until a tab closes. h2 multiplexes over one connection
# so the cap disappears. This is the reason the playground origin needs
# TLS at all — h2 only negotiates over ALPN, which requires TLS.
#
# Outputs in <friday-home>/tls/:
#   browser.crt / browser.key     — mkcert-signed, system-trusted
#   s2s.crt / s2s.key             — openssl-signed, NOT system-trusted
#   s2s-ca.crt / s2s-ca.key       — private CA (key kept locally, mode 600)
#
# Env vars written to <friday-home>/.env:
#   FRIDAY_BROWSER_TLS_CERT/_KEY  — playground origin (vite + static-server)
#   FRIDAY_TLS_CERT/_KEY          — s2s (atlasd + webhook-tunnel listeners)
#   FRIDAY_TLS_CA                 — private CA bundle for in-process trust
#   DENO_CERT, NODE_EXTRA_CA_CERTS — point at FRIDAY_TLS_CA
#
# Usage:
#   bash scripts/setup-tls.sh                # full setup (both chains)
#   SKIP_MKCERT=1 bash scripts/setup-tls.sh  # s2s chain only, no system root
#   SKIP_TLS=1    bash scripts/setup-tls.sh  # skip everything (CI fallback)
#
# Idempotent. Re-runs reuse fresh certs and only regenerate near expiry.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [[ "${SKIP_TLS:-0}" == "1" ]]; then
    echo "→ SKIP_TLS=1 set — skipping TLS setup."
    echo "  Playground will run on HTTP/1.1; multi-tab dev may deadlock when"
    echo "  the 3 SSE feeds × tabs saturate Chrome's 6-socket-per-origin cap."
    exit 0
fi

SKIP_MKCERT="${SKIP_MKCERT:-0}"

# ── 1. Tooling: openssl is required; mkcert only if not skipped ─────────────
if ! command -v openssl >/dev/null 2>&1; then
    echo "✗ openssl not found on PATH" >&2
    echo "  install: macOS ships openssl by default; on Linux \`apt install openssl\`." >&2
    exit 1
fi
echo "→ openssl: $(command -v openssl)"

if [[ "$SKIP_MKCERT" == "1" ]]; then
    echo "→ SKIP_MKCERT=1 — skipping browser-trusted cert generation."
    echo "  The playground origin will run on HTTP and tabs > 1 will deadlock,"
    echo "  but daemon + tunnel still get their (private-CA) s2s certs."
else
    if ! command -v mkcert >/dev/null 2>&1; then
        if [[ "$OSTYPE" == "darwin"* ]] && command -v brew >/dev/null 2>&1; then
            echo "→ mkcert not found — installing via Homebrew"
            brew install mkcert nss
        else
            echo "✗ mkcert not found on PATH" >&2
            echo "  install: https://github.com/FiloSottile/mkcert#installation" >&2
            echo "  on Debian/Ubuntu: apt install libnss3-tools && go install filippo.io/mkcert@latest" >&2
            echo "  or re-run with SKIP_MKCERT=1 to set up s2s certs only." >&2
            exit 1
        fi
    fi
    echo "→ mkcert: $(command -v mkcert)"
    # Idempotent. First run on a machine prompts for admin (system keychain
    # on macOS, sudo on Linux); subsequent runs detect the CA is already
    # trusted and exit fast.
    echo "→ Ensuring mkcert root CA is trusted (may prompt for admin password)"
    # Hide JAVA_HOME from mkcert: when set, mkcert also tries to install the
    # CA into the JDK's cacerts via keytool. Friday doesn't run on the JVM,
    # and a half-installed JDK (cacerts missing) makes mkcert exit non-zero
    # — which under `set -e` kills this script before s2s certs are written,
    # even though the macOS/Linux system-trust install already succeeded.
    env -u JAVA_HOME mkcert -install
fi

# ── 2. Resolve dev Friday home ──────────────────────────────────────────────
#
# This is a DEV-ONLY script. ~/.friday/local is the installed-Studio home
# and the launcher owns the cert chain there (s2s_generator.go writes the
# private CA + leaf, tls_renewer.go fetches the LE browser cert from
# download.fridayplatform.io). Writing into ~/.friday/local from here
# would clobber the launcher's certs and the LE browser chain — and would
# silently switch the installed playground origin from the LE cert (for
# local.hellofriday.ai:15200) to a mkcert cert for localhost, breaking the
# tray's https URL.
#
# Resolution order:
#   1. `FRIDAY_HOME` env var, if set — explicit caller intent wins (e.g.
#      a dev pinning a custom home dir). The user accepts whatever they
#      pointed it at, including ~/.friday/local if they really mean it.
#   2. Default to ~/.atlas (the dev convention pinned in deno.json's
#      `atlas` / `atlas:dev` tasks). Created if absent.
declare -a FRIDAY_HOMES=()
if [[ -n "${FRIDAY_HOME:-}" ]]; then
    FRIDAY_HOMES=("$FRIDAY_HOME")
    mkdir -p "$FRIDAY_HOME"
else
    mkdir -p "$HOME/.atlas"
    FRIDAY_HOMES=("$HOME/.atlas")
fi

# ── 3. Env helpers ──────────────────────────────────────────────────────────
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
# user to re-trust after every dev setup.
cert_is_fresh() {
    local cert="$1" days_min="${2:-30}"
    [[ -f "$cert" ]] || return 1
    local secs=$(( days_min * 86400 ))
    openssl x509 -checkend "$secs" -noout -in "$cert" >/dev/null 2>&1
}

# Generate a private CA + leaf cert pair with openssl. The CA stays local
# (key file mode 600 in $tls_dir/s2s-ca.key); the leaf is what daemon +
# tunnel present. Trust is plumbed via env (DENO_CERT, NODE_EXTRA_CA_CERTS)
# pointing at the CA cert, so no system keystore install is needed.
generate_s2s_chain() {
    local tls_dir="$1"
    local ca_crt="$tls_dir/s2s-ca.crt"
    local ca_key="$tls_dir/s2s-ca.key"
    local crt="$tls_dir/s2s.crt"
    local key="$tls_dir/s2s.key"

    if cert_is_fresh "$crt" && cert_is_fresh "$ca_crt"; then
        echo "  → s2s.crt valid >30d, reusing"
        return 0
    fi

    # CA: 1-year self-signed, ECDSA P-256 (small, modern, every TLS stack
    # we touch supports it). Bounded lifetime caps the blast radius of a
    # leaked s2s-ca.key — a stolen key mints trusted certs for at most
    # 1 year from generation, after which setup-tls.sh rotates on next
    # run. Regeneration only fires when missing or within 30 days of
    # expiry — otherwise re-plumbing trust would become a daily chore.
    if ! cert_is_fresh "$ca_crt"; then
        echo "  → Generating private CA at $ca_crt"
        openssl ecparam -name prime256v1 -genkey -noout -out "$ca_key"
        openssl req -new -x509 -days 365 \
            -key "$ca_key" \
            -out "$ca_crt" \
            -subj "/CN=Friday Local Dev CA/O=Friday Local Dev" \
            -addext "basicConstraints=critical,CA:TRUE" \
            -addext "keyUsage=critical,keyCertSign,cRLSign" \
            >/dev/null 2>&1
        chmod 600 "$ca_key"
    fi

    # Leaf: 1-year ECDSA, signed by the private CA, covering localhost +
    # 127.0.0.1 + ::1 so the same cert works for daemon (:8080) and tunnel
    # (:9090) listeners.
    echo "  → Generating s2s leaf at $crt"
    local leaf_csr="$tls_dir/.s2s.csr"
    local leaf_ext="$tls_dir/.s2s.ext"
    openssl ecparam -name prime256v1 -genkey -noout -out "$key"
    openssl req -new \
        -key "$key" \
        -out "$leaf_csr" \
        -subj "/CN=localhost/O=Friday Local Dev" \
        >/dev/null 2>&1
    cat > "$leaf_ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth,clientAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1
EOF
    openssl x509 -req \
        -in "$leaf_csr" \
        -CA "$ca_crt" -CAkey "$ca_key" -CAcreateserial \
        -days 365 \
        -extfile "$leaf_ext" \
        -out "$crt" \
        >/dev/null 2>&1
    rm -f "$leaf_csr" "$leaf_ext" "$tls_dir/s2s-ca.srl"
    chmod 600 "$key"
}

# ── 4. Generate or reuse cert per home ──────────────────────────────────────
for home in "${FRIDAY_HOMES[@]}"; do
    tls_dir="$home/tls"
    env_file="$home/.env"

    mkdir -p "$tls_dir"
    chmod 700 "$tls_dir"

    # Browser cert (playground origin)
    browser_crt="$tls_dir/browser.crt"
    browser_key="$tls_dir/browser.key"
    if [[ "$SKIP_MKCERT" != "1" ]]; then
        if cert_is_fresh "$browser_crt"; then
            echo "→ $browser_crt (valid >30d, reusing)"
        else
            echo "→ Generating $browser_crt"
            ( cd "$tls_dir" && mkcert -cert-file browser.crt -key-file browser.key \
                localhost 127.0.0.1 ::1 ) >/dev/null
        fi
        chmod 600 "$browser_key"
    fi

    # S2S cert chain (daemon + tunnel)
    echo "→ S2S certs in $tls_dir"
    generate_s2s_chain "$tls_dir"

    touch "$env_file"
    # The .env in FRIDAY_HOME holds OAuth tokens and other secrets — tighten
    # perms before writing.
    chmod 600 "$env_file"

    if [[ "$SKIP_MKCERT" != "1" ]]; then
        upsert_env "$env_file" "FRIDAY_BROWSER_TLS_CERT" "$browser_crt"
        upsert_env "$env_file" "FRIDAY_BROWSER_TLS_KEY"  "$browser_key"
    else
        # If a previous run wrote browser entries, leave them; the playground
        # will pick them up if the files still exist. But a fresh SKIP_MKCERT
        # run on a virgin machine shouldn't set entries that point at
        # nonexistent files (Node/Deno warn loudly on missing cert files).
        if [[ ! -f "$browser_crt" ]]; then
            remove_env "$env_file" "FRIDAY_BROWSER_TLS_CERT"
            remove_env "$env_file" "FRIDAY_BROWSER_TLS_KEY"
        fi
    fi

    upsert_env "$env_file" "FRIDAY_TLS_CERT"     "$tls_dir/s2s.crt"
    upsert_env "$env_file" "FRIDAY_TLS_KEY"      "$tls_dir/s2s.key"
    upsert_env "$env_file" "FRIDAY_TLS_CA"       "$tls_dir/s2s-ca.crt"

    # CA trust for runtimes that talk to the (now https) daemon + tunnel:
    #   - DENO_CERT          → atlasd, atlas-cli (Deno ignores the keychain
    #     unless --use-system-ca is set; this env var is the cleanest way)
    #   - NODE_EXTRA_CA_CERTS → vite SSR proxy, static-server proxy, any
    #     Node tool fetching daemon/tunnel
    # Intentionally NOT setting SSL_CERT_FILE: that var (Python httpx/
    # requests/urllib3, curl, Rustls + rustls-native-certs) *replaces* the
    # system CA bundle, so user agents would lose verification for
    # api.openai.com / api.anthropic.com / OAuth callbacks / OTEL exporter.
    upsert_env "$env_file" "DENO_CERT"           "$tls_dir/s2s-ca.crt"
    upsert_env "$env_file" "NODE_EXTRA_CA_CERTS" "$tls_dir/s2s-ca.crt"

    # Earlier versions of this script wrote SSL_CERT_FILE here; that var
    # *replaces* the system CA bundle for Python/curl/Rust callers, so
    # outbound TLS to OpenAI/Anthropic/OAuth callbacks broke. Remove any
    # legacy entry from upgraded setups.
    remove_env "$env_file" "SSL_CERT_FILE"

    echo "  → wrote FRIDAY_{BROWSER_,}TLS_*, FRIDAY_TLS_CA, DENO_CERT, NODE_EXTRA_CA_CERTS to $env_file (chmod 600)"
done

echo ""
echo "✓ TLS ready. Restart the daemon and playground to pick up the certs:"
if [[ "$SKIP_MKCERT" != "1" ]]; then
    echo "    deno task playground   →  https://localhost:5200  (mkcert, system-trusted)"
else
    echo "    deno task playground   →  http://localhost:5200   (SKIP_MKCERT=1)"
fi
echo "    atlas daemon start     →  https://localhost:8080  (private-CA, in-process trust)"
echo "    deno task webhook-tunnel → https://localhost:9090  (private-CA, in-process trust)"
echo ""
if [[ "$SKIP_MKCERT" != "1" ]]; then
    echo "ℹ mkcert installed a local root CA in your system trust store. Any process"
    echo "  running as your user can mint certs trusted by your browsers using the"
    echo "  key in \`mkcert -CAROOT\`. Remove with: mkcert -uninstall"
fi
echo "ℹ The private CA at \`<friday-home>/tls/s2s-ca.crt\` is NOT installed in any"
echo "  system trust store. Trust flows only via DENO_CERT / NODE_EXTRA_CA_CERTS"
echo "  in <friday-home>/.env, scoped to processes that load that env file."
