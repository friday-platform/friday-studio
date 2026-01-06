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

# Generate apps/link/.env with all configured providers
generate_link_env() {
	local root
	root=$(repo_root)

	if [[ ! -d "$root/apps/link" ]]; then
		warn "apps/link not found - skipping .env creation"
		return
	fi

	local env_file="$root/apps/link/.env"

	cat >"$env_file" <<'EOF'
LINK_DEV_MODE=true
GOOGLE_CLIENT_ID_FILE=$HOME/.atlas/google_client_id
GOOGLE_CLIENT_SECRET_FILE=$HOME/.atlas/google_client_secret
HUBSPOT_CLIENT_ID_FILE=$HOME/.atlas/hubspot_client_id
HUBSPOT_CLIENT_SECRET_FILE=$HOME/.atlas/hubspot_client_secret
SLACK_APP_CLIENT_ID_FILE=$HOME/.atlas/slack_app_client_id
SLACK_APP_CLIENT_SECRET_FILE=$HOME/.atlas/slack_app_client_secret
EOF

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
	echo "  all            Set up all secrets (default)"
	echo ""
	echo "Examples:"
	echo "  $0               # Set up all secrets"
	echo "  $0 google-oauth  # Set up only Google OAuth"
	echo "  $0 hubspot-oauth # Set up only HubSpot OAuth"
	echo "  $0 slack-oauth   # Set up only Slack OAuth"
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
	all)
		require_op
		setup_google_oauth
		setup_hubspot_oauth
		setup_slack_oauth
		generate_link_env
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
