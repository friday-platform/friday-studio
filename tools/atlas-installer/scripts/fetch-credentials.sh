#!/bin/bash

# Atlas Installer - Credential Fetching Script
# This script fetches credentials using an Atlas Key (JWT token)
# and updates the .env file with the received credentials.
# Uses only standard Linux tools (no curl, jq, or other non-standard dependencies)

set -e

# Configuration
ATLAS_DIR="$HOME/.atlas"
ENV_FILE="$ATLAS_DIR/.env"
DEFAULT_API_URL="https://atlas.tempestdx.com/api/credentials"
API_URL="${ATLAS_URL:-$DEFAULT_API_URL}"

# Color codes for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Function to print colored output
print_error() {
    echo -e "${RED}Error: $1${NC}" >&2
}

print_success() {
    echo -e "${GREEN}Success: $1${NC}"
}

print_info() {
    echo -e "${YELLOW}Info: $1${NC}"
}

# Function to decode base64url (JWT uses base64url encoding)
base64url_decode() {
    local input="$1"
    # Convert base64url to base64 by replacing URL-safe characters
    local base64=$(echo "$input" | tr '_-' '/+')
    # Add padding if needed
    local padding=$((4 - ${#base64} % 4))
    if [[ $padding -ne 4 ]]; then
        base64="${base64}$(printf '%*s' $padding | tr ' ' '=')"
    fi
    # Decode using base64
    echo "$base64" | base64 -d 2>/dev/null
}

# Function to extract JSON value (simple parser for our specific use case)
extract_json_value() {
    local json="$1"
    local key="$2"
    # Simple regex to extract string values from JSON
    echo "$json" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n1
}

# Function to extract JSON number value
extract_json_number() {
    local json="$1"
    local key="$2"
    # Simple regex to extract number values from JSON
    echo "$json" | sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\\([0-9]*\\).*/\\1/p" | head -n1
}

# Function to parse credentials from JSON response
parse_credentials() {
    local json="$1"
    local temp_file=$(mktemp)

    # Extract credentials object content
    local credentials_block=$(echo "$json" | sed -n '/"credentials"[[:space:]]*:[[:space:]]*{/,/}/p' | sed '1d;$d')

    # Parse each credential line
    echo "$credentials_block" | while IFS= read -r line; do
        # Skip empty lines and comments
        [[ -z "$line" || "$line" =~ ^[[:space:]]*$ ]] && continue

        # Extract key-value pairs
        if [[ "$line" =~ \"([^\"]+)\"[[:space:]]*:[[:space:]]*\"([^\"]+)\" ]]; then
            key="${BASH_REMATCH[1]}"
            value="${BASH_REMATCH[2]}"
            echo "${key}=${value}" >> "$temp_file"
        fi
    done

    if [[ -s "$temp_file" ]]; then
        cat "$temp_file"
        rm -f "$temp_file"
        return 0
    else
        rm -f "$temp_file"
        return 1
    fi
}

# Function to validate JWT format
validate_jwt() {
    local jwt="$1"

    # Check if JWT has 3 parts separated by dots
    if [[ $(echo "$jwt" | tr -cd '.' | wc -c) -ne 2 ]]; then
        return 1
    fi

    # Extract payload (second part)
    local payload=$(echo "$jwt" | cut -d'.' -f2)

    # Try to decode payload using our base64url decoder
    if ! decoded_payload=$(base64url_decode "$payload"); then
        return 1
    fi

    # Check if it contains required claims using simple text matching
    if ! echo "$decoded_payload" | grep -q '"email"' || \
       ! echo "$decoded_payload" | grep -q '"iss"' || \
       ! echo "$decoded_payload" | grep -q '"sub"' || \
       ! echo "$decoded_payload" | grep -q '"exp"' || \
       ! echo "$decoded_payload" | grep -q '"iat"'; then
        return 1
    fi

    # Check if issuer is correct
    local issuer=$(extract_json_value "$decoded_payload" "iss")
    if [[ "$issuer" != "tempest-atlas" ]]; then
        return 1
    fi

    # Check if token is expired
    local exp=$(extract_json_number "$decoded_payload" "exp")
    local now=$(date +%s)
    if [[ -z "$exp" || $exp -le $now ]]; then
        return 1
    fi

    return 0
}

# Function to fetch credentials from API using wget (standard on most Linux distros)
fetch_credentials() {
    local atlas_key="$1"
    local temp_file=$(mktemp)

    # Use wget to make the HTTP POST request
    if ! command -v wget >/dev/null 2>&1; then
        print_error "wget is not available. Please install wget to fetch credentials."
        rm -f "$temp_file"
        return 1
    fi

    # Make the request with wget
    if wget -q -O "$temp_file" \
        --header="Authorization: Bearer $atlas_key" \
        --header="Content-Type: application/json" \
        --post-data="" \
        "$API_URL" 2>/dev/null; then
        echo "$temp_file"
        return 0
    else
        rm -f "$temp_file"
        return 1
    fi
}

# Function to update .env file with credentials
update_env_file() {
    local credentials_json="$1"
    local temp_env=$(mktemp)
    local credentials_list=$(mktemp)

    # Create .atlas directory if it doesn't exist
    mkdir -p "$ATLAS_DIR"

    # Read existing .env file if it exists
    if [[ -f "$ENV_FILE" ]]; then
        cp "$ENV_FILE" "$temp_env"
    fi

    # Parse credentials from JSON using our custom parser
    if ! parse_credentials "$credentials_json" > "$credentials_list"; then
        print_error "Failed to parse credentials from response"
        rm -f "$temp_env" "$credentials_list"
        return 1
    fi

    # Update .env file with new credentials
    while IFS= read -r credential; do
        [[ -z "$credential" ]] && continue

        local key=$(echo "$credential" | cut -d'=' -f1)
        local value=$(echo "$credential" | cut -d'=' -f2-)

        # Remove existing entry if present
        if [[ -f "$temp_env" ]]; then
            sed -i "/^${key}=/d" "$temp_env"
        fi

        # Add new entry
        echo "${key}=${value}" >> "$temp_env"
    done < "$credentials_list"

    # Replace original .env file
    mv "$temp_env" "$ENV_FILE"

    # Set proper permissions
    chmod 600 "$ENV_FILE"

    # Clean up
    rm -f "$credentials_list"

    print_success "Credentials saved to $ENV_FILE"
}

# Main function
main() {
    local atlas_key="$1"

    if [[ -z "$atlas_key" ]]; then
        print_error "Atlas key is required"
        echo "Usage: $0 <atlas_key>"
        exit 1
    fi

    print_info "Validating Atlas key..."
    if ! validate_jwt "$atlas_key"; then
        print_error "Invalid Atlas key format or expired token"
        exit 1
    fi

    print_info "Fetching credentials from $API_URL..."
    if response_file=$(fetch_credentials "$atlas_key"); then
        local response_content=$(cat "$response_file")

        # Basic JSON validation - check if it looks like JSON
        if ! echo "$response_content" | grep -q "^{.*}$"; then
            print_error "Invalid JSON response from server"
            rm -f "$response_file"
            exit 1
        fi

        # Check if response contains credentials object
        if ! echo "$response_content" | grep -q '"credentials"'; then
            print_error "No credentials found in response"
            rm -f "$response_file"
            exit 1
        fi

        print_info "Updating .env file..."
        if update_env_file "$response_content"; then
            rm -f "$response_file"
            print_success "Credentials configured successfully"
        else
            rm -f "$response_file"
            print_error "Failed to update .env file"
            exit 1
        fi
    else
        print_error "Failed to fetch credentials from server"
        exit 1
    fi
}

# Run main function with all arguments
main "$@"