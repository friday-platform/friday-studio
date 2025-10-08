#!/bin/bash
set -e

# Platform bundle creation script
# Usage: ./create-platform-bundle.sh <version> <os> <arch>

VERSION=$1
OS=$2
ARCH=$3

if [[ -z "$VERSION" || -z "$OS" || -z "$ARCH" ]]; then
  echo "Usage: $0 <version> <os> <arch>"
  exit 1
fi

BUNDLE_NAME="atlas-bundle-${VERSION}-${OS}-${ARCH}"
mkdir -p "$BUNDLE_NAME"

# Copy installers based on platform
case "$OS" in
  darwin)
    cp dist/atlas_*.zip "$BUNDLE_NAME/" || { echo "Missing Atlas CLI installer"; exit 1; }

    echo "Atlas Bundle - macOS

Installation Steps:
1. Unzip and run Atlas CLI installer
2. Atlas Web Client.app will be installed automatically" > "$BUNDLE_NAME/README.txt"
    ;;

  windows)
    # Copy Atlas Installer (GUI app in zip format)
    cp dist/atlas_*.zip "$BUNDLE_NAME/" || { echo "Missing Atlas Installer"; exit 1; }

    echo "Atlas Bundle - Windows

Installation Steps:
1. Extract atlas_*.zip
2. Run Atlas Installer.exe to install Atlas" > "$BUNDLE_NAME/README.txt"
    ;;

  linux)
    # Copy CLI packages
    cp dist/atlas_*.deb "$BUNDLE_NAME/" 2>/dev/null || true
    cp dist/atlas-*.rpm "$BUNDLE_NAME/" 2>/dev/null || true

    # Verify at least one CLI installer exists
    if ! ls "$BUNDLE_NAME"/atlas_*.deb "$BUNDLE_NAME"/atlas-*.rpm 2>/dev/null | grep -q .; then
      echo "Missing Atlas CLI installer (.deb or .rpm)"
      exit 1
    fi

    echo "Atlas Bundle - Linux

Installation Steps:
1. Install Atlas CLI:
   - Debian/Ubuntu: sudo dpkg -i atlas_*.deb
   - RHEL/Fedora: sudo rpm -i atlas-*.rpm
2. Install GUI if available" > "$BUNDLE_NAME/README.txt"
    ;;

  *)
    echo "Unknown OS: $OS"
    exit 1
    ;;
esac

# Create archive
if [[ "$OS" == "windows" ]]; then
  7z a "dist/${BUNDLE_NAME}.zip" "$BUNDLE_NAME"/*
else
  tar -czf "dist/${BUNDLE_NAME}.tar.gz" "$BUNDLE_NAME"
fi

echo "Bundle created: ${BUNDLE_NAME}"
ls -la "dist/${BUNDLE_NAME}."*