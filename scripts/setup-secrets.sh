#!/bin/bash
# Setup development secrets from 1Password
# Usage: ./scripts/setup-secrets.sh [secret-name]
#
# Requires: 1Password CLI (op) - https://developer.1password.com/docs/cli/
#
# Available secrets:
#   google-oauth   - Google OAuth credentials for Link service
#   hubspot-oauth  - HubSpot OAuth credentials for Link service
#   slack-oauth    - Slack App OAuth credentials for Link service
#   gateway        - Gateway service secrets (JWT public, SendGrid, Parallel)
#   bounce         - Bounce service secrets (JWT private/public)
#   litellm        - LiteLLM proxy configuration and master key
#   all            - Set up all secrets (default)
#
# The script fetches secrets from 1Password and writes them to:
#   - ~/.atlas/ for shared credential files
#   - apps/<service>/.env for service-specific env files

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

ATLAS_DIR="$HOME/.atlas"

# 1Password secret references (op:// format)
OP_GOOGLE="op://Engineering/atlas-link-google-oauth-sandbox"
OP_HUBSPOT="op://Engineering/atlas-link-hubspot-sandbox"
OP_SLACK="op://Engineering/atlas-link-slack-sandbox"
OP_SENDGRID="op://Engineering/atlas-gateway-sendgrid-sandbox"
OP_PARALLEL="op://Engineering/atlas-gateway-parallel-sandbox"
OP_JWT="op://Engineering/atlas-jwt-keypair-sandbox"
OP_LITELLM_CONFIG="op://Engineering/LiteLLM Production Config (tempest-sandbox)"
OP_LITELLM_MASTER_KEY="op://Engineering/LiteLLM Sandbox Master Key/password"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info() { echo -e "${BLUE}info:${NC} $*"; }
success() { echo -e "${GREEN}ok:${NC} $*"; }
warn() { echo -e "${YELLOW}warn:${NC} $*"; }
error() { echo -e "${RED}error:${NC} $*" >&2; }
die() {
	error "$@"
	exit 1
}

require_op() {
	if ! command -v op &>/dev/null; then
		error "1Password CLI (op) not found."
		echo ""
		echo "Install with:"
		echo "  brew install 1password-cli"
		echo ""
		echo "Then enable biometric unlock (optional but recommended):"
		echo "  op account add --address tempestlabs.1password.com"
		echo ""
		echo "More info: https://developer.1password.com/docs/cli/"
		exit 1
	fi

	# Check if signed in (will prompt for auth if needed)
	if ! op account get &>/dev/null; then
		info "Authenticating with 1Password..."
		if ! op signin; then
			die "Failed to authenticate with 1Password"
		fi
	fi
}

# Fetch a secret using op:// reference
# Usage: op_read <op://reference>
op_read() {
	local ref="$1"
	local value

	value=$(op read "$ref" 2>&1) || {
		die "Failed to read '$ref' from 1Password: $value"
	}

	echo "$value"
}

# Write content to a file with restricted permissions
# Usage: write_secret <path> <content>
write_secret() {
	local path="$1"
	local content="$2"

	mkdir -p "$(dirname "$path")"
	echo "$content" >"$path"
	chmod 600 "$path"
}

# Find repo root (where .git is)
repo_root() {
	git rev-parse --show-toplevel 2>/dev/null || pwd
}

# ---------------------------------------------------------------------------
# Secret setup functions
# ---------------------------------------------------------------------------

setup_google_oauth() {
	info "Fetching Google OAuth credentials from 1Password..."

	write_secret "$ATLAS_DIR/google_client_id" "$(op_read "$OP_GOOGLE/client_id")"
	write_secret "$ATLAS_DIR/google_client_secret" "$(op_read "$OP_GOOGLE/client_secret")"
	success "Wrote Google credentials to $ATLAS_DIR/"
}

setup_hubspot_oauth() {
	info "Fetching HubSpot OAuth credentials from 1Password..."

	write_secret "$ATLAS_DIR/hubspot_client_id" "$(op_read "$OP_HUBSPOT/client_id")"
	write_secret "$ATLAS_DIR/hubspot_client_secret" "$(op_read "$OP_HUBSPOT/client_secret")"
	success "Wrote HubSpot credentials to $ATLAS_DIR/"
}

setup_slack_oauth() {
	info "Fetching Slack App OAuth credentials from 1Password..."

	write_secret "$ATLAS_DIR/slack_app_client_id" "$(op_read "$OP_SLACK/client_id")"
	write_secret "$ATLAS_DIR/slack_app_client_secret" "$(op_read "$OP_SLACK/client_secret")"
	success "Wrote Slack credentials to $ATLAS_DIR/"
}

setup_gateway() {
	info "Fetching Gateway JWT public key from 1Password..."

	write_secret "$ATLAS_DIR/jwt_public_key.pem" "$(op_read "$OP_JWT/public_key")"
	success "Wrote JWT public key to $ATLAS_DIR/"
}

setup_bounce() {
	info "Fetching Bounce secrets from 1Password..."

	# JWT keys
	write_secret "$ATLAS_DIR/jwt_private_key.pem" "$(op_read "$OP_JWT/private_key")"
	write_secret "$ATLAS_DIR/jwt_public_key.pem" "$(op_read "$OP_JWT/public_key")"

	# Google OAuth as JSON file (bounce expects Google Cloud credentials JSON format)
	local google_client_id google_client_secret
	google_client_id=$(op_read "$OP_GOOGLE/client_id")
	google_client_secret=$(op_read "$OP_GOOGLE/client_secret")
	write_secret "$ATLAS_DIR/google_oauth_credentials.json" "{
  \"web\": {
    \"client_id\": \"${google_client_id}\",
    \"client_secret\": \"${google_client_secret}\",
    \"auth_uri\": \"https://accounts.google.com/o/oauth2/auth\",
    \"token_uri\": \"https://oauth2.googleapis.com/token\",
    \"auth_provider_x509_cert_url\": \"https://www.googleapis.com/oauth2/v1/certs\",
    \"redirect_uris\": [\"http://localhost:8083/oauth/google/callback\"]
  }
}"

	# SendGrid API key as file
	local sendgrid_key
	sendgrid_key=$(op_read "$OP_SENDGRID/credential")
	write_secret "$ATLAS_DIR/sendgrid_api_key" "$sendgrid_key"

	success "Wrote Bounce secrets to $ATLAS_DIR/"
}

setup_litellm() {
	info "Fetching LiteLLM configuration from 1Password..."

	# Download the config document
	local config_file="$ATLAS_DIR/litellm-config.yaml"
	op document get "LiteLLM Production Config (tempest-sandbox)" --vault Engineering --out-file "$config_file" --force 2>/dev/null || {
		die "Failed to download LiteLLM config from 1Password"
	}
	chmod 600 "$config_file"

	# Get the master key
	write_secret "$ATLAS_DIR/litellm_master_key" "$(op_read "$OP_LITELLM_MASTER_KEY")"

	success "Wrote LiteLLM config to $config_file"
}

# Generate ~/.atlas/litellm.env
generate_litellm_env() {
	local master_key
	master_key=$(cat "$ATLAS_DIR/litellm_master_key" 2>/dev/null) || {
		warn "LiteLLM master key not found, run 'setup-secrets.sh litellm' first"
		return 1
	}

	local env_file="$ATLAS_DIR/litellm.env"

	cat >"$env_file" <<EOF
LITELLM_API_KEY=${master_key}
LITELLM_BASE_URL=http://localhost:4000
EOF

	chmod 600 "$env_file"
	success "Created $env_file"

	echo ""
	info "To start LiteLLM proxy locally, run:"
	echo "  deno task litellm:start"
	echo ""
	info "Or with the full config:"
	echo "  docker run -d --name litellm-proxy -p 4000:4000 -v $ATLAS_DIR/litellm-config.yaml:/app/config.yaml ghcr.io/berriai/litellm:main-latest --config /app/config.yaml"
}

# Generate ~/.atlas/link.env
generate_link_env() {
	local env_file="$ATLAS_DIR/link.env"

	cat >"$env_file" <<EOF
LINK_DEV_MODE=true
GOOGLE_CLIENT_ID_FILE=${ATLAS_DIR}/google_client_id
GOOGLE_CLIENT_SECRET_FILE=${ATLAS_DIR}/google_client_secret
HUBSPOT_CLIENT_ID_FILE=${ATLAS_DIR}/hubspot_client_id
HUBSPOT_CLIENT_SECRET_FILE=${ATLAS_DIR}/hubspot_client_secret
SLACK_APP_CLIENT_ID_FILE=${ATLAS_DIR}/slack_app_client_id
SLACK_APP_CLIENT_SECRET_FILE=${ATLAS_DIR}/slack_app_client_secret
EOF

	chmod 600 "$env_file"
	success "Created $env_file"
}

# Generate ~/.atlas/gateway.env
generate_gateway_env() {
	info "Fetching Gateway API keys from 1Password..."
	local sendgrid_key parallel_key
	sendgrid_key=$(op_read "$OP_SENDGRID/credential")
	parallel_key=$(op_read "$OP_PARALLEL/credential")

	local env_file="$ATLAS_DIR/gateway.env"

	cat >"$env_file" <<EOF
JWT_PUBLIC_KEY_FILE=${ATLAS_DIR}/jwt_public_key.pem
SENDGRID_API_KEY=${sendgrid_key}
PARALLEL_API_KEY=${parallel_key}
EOF

	chmod 600 "$env_file"
	success "Created $env_file"
}

# Generate ~/.atlas/bounce.env
generate_bounce_env() {
	# Generate HMAC secret for signup if not exists
	local hmac_secret_file="$ATLAS_DIR/signup_hmac_secret"
	if [[ ! -f "$hmac_secret_file" ]]; then
		info "Generating SIGNUP_HMAC_SECRET..."
		write_secret "$hmac_secret_file" "$(openssl rand -hex 32)"
	fi
	local hmac_secret
	hmac_secret=$(cat "$hmac_secret_file")

	local env_file="$ATLAS_DIR/bounce.env"

	cat >"$env_file" <<EOF
JWT_PRIVATE_KEY_FILE=${ATLAS_DIR}/jwt_private_key.pem
JWT_PUBLIC_KEY_FILE=${ATLAS_DIR}/jwt_public_key.pem
OAUTH_GOOGLE_CREDENTIALS_FILE=${ATLAS_DIR}/google_oauth_credentials.json
SENDGRID_API_KEY_FILE=${ATLAS_DIR}/sendgrid_api_key
SIGNUP_HMAC_SECRET=${hmac_secret}
EOF

	chmod 600 "$env_file"
	success "Created $env_file"
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

usage() {
	echo "Usage: $0 [secret-name]"
	echo ""
	echo "Available secrets:"
	echo "  google-oauth   Google OAuth credentials for Link service"
	echo "  hubspot-oauth  HubSpot OAuth credentials for Link service"
	echo "  slack-oauth    Slack App OAuth credentials for Link service"
	echo "  gateway        Gateway service secrets (JWT public, SendGrid, Parallel)"
	echo "  bounce         Bounce service secrets (JWT keypair, SendGrid)"
	echo "  litellm        LiteLLM proxy configuration and master key"
	echo "  all            Set up all secrets (default)"
	echo ""
	echo "Examples:"
	echo "  $0               # Set up all secrets"
	echo "  $0 google-oauth  # Set up only Google OAuth"
	echo "  $0 hubspot-oauth # Set up only HubSpot OAuth"
	echo "  $0 slack-oauth   # Set up only Slack OAuth"
	echo "  $0 gateway       # Set up only Gateway secrets"
	echo "  $0 bounce        # Set up only Bounce secrets"
	echo "  $0 litellm       # Set up only LiteLLM config"
}

main() {
	local secret="${1:-all}"

	case "$secret" in
	-h | --help)
		usage
		exit 0
		;;
	google-oauth)
		require_op
		setup_google_oauth
		;;
	hubspot-oauth)
		require_op
		setup_hubspot_oauth
		;;
	slack-oauth)
		require_op
		setup_slack_oauth
		;;
	gateway)
		require_op
		setup_gateway
		generate_gateway_env
		;;
	bounce)
		require_op
		setup_bounce
		generate_bounce_env
		;;
	litellm)
		require_op
		setup_litellm
		generate_litellm_env
		;;
	all)
		require_op
		setup_google_oauth
		setup_hubspot_oauth
		setup_slack_oauth
		setup_gateway
		setup_bounce
		setup_litellm
		generate_link_env
		generate_gateway_env
		generate_bounce_env
		generate_litellm_env
		;;
	*)
		error "Unknown secret: $secret"
		usage
		exit 1
		;;
	esac

	echo ""
	success "Secret setup complete"
}

main "$@"
