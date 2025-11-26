#!/bin/bash

# --- Configuration ---
# You can change this version string
VERSION="0.0.1-localbuild"
BINARY_NAME="atlas"
DIST_DIR="./dist"
VERSION_FILE="src/utils/version.ts"
BACKUP_FILE="${VERSION_FILE}.bak"

# --- Cleanup Function ---
# This function will run on script exit to restore the original version file
cleanup() {
  if [ -f "$BACKUP_FILE" ]; then
    echo "Restoring original version file..."
    mv "$BACKUP_FILE" "$VERSION_FILE"
  fi
}

# Register the cleanup function to run on script exit (normal or error)
trap cleanup EXIT

# --- Build Process ---
set -e # Exit immediately if a command exits with a non-zero status.

echo "Starting macOS Atlas build..."

# 1. Prepare version information
GIT_SHA=$(git rev-parse --short HEAD)
echo "Version: $VERSION, Git SHA: $GIT_SHA"

# Backup and replace version placeholders (macOS `sed` syntax)
echo "Updating version file: $VERSION_FILE"
cp "$VERSION_FILE" "$BACKUP_FILE"
sed -i "" "s|__ATLAS_VERSION__|$VERSION|g" "$VERSION_FILE"
sed -i "" "s|__ATLAS_GIT_SHA__|$GIT_SHA|g" "$VERSION_FILE"

# 2. Build binary
echo "Compiling binary..."
./scripts/compile.sh "${DIST_DIR}/${BINARY_NAME}"

echo "Compilation complete."

# 3. Test the built binary
echo "Testing built binary..."
if "${DIST_DIR}/${BINARY_NAME}" --version; then
  echo "✅ Binary built and tested successfully!"
  echo "Executable is at: ${DIST_DIR}/${BINARY_NAME}"
else
  echo "❌ Binary test failed."
  exit 1
fi

set +e
# The 'trap' will handle cleanup automatically.
