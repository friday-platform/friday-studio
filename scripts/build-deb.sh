#!/bin/bash
set -e

VERSION=${VERSION:-1.0.0}
ARCH=${ARCH:-amd64}

# Convert edge/nightly versions to valid Debian version format
# edge-20250716-002537-5e1e160 -> 0.0.0~edge20250716002537.5e1e160
# nightly-20250716-5e1e160 -> 0.0.0~nightly20250716.5e1e160
if [[ "${VERSION}" == edge-* ]]; then
    # Extract parts: edge-20250716-002537-5e1e160
    date_part=$(echo "${VERSION}" | cut -d'-' -f2)
    time_part=$(echo "${VERSION}" | cut -d'-' -f3)
    git_hash=$(echo "${VERSION}" | cut -d'-' -f4)
    DEB_VERSION="0.0.0~edge${date_part}${time_part}.${git_hash}"
elif [[ "${VERSION}" == nightly-* ]]; then
    # Extract parts: nightly-20250716-5e1e160
    date_part=$(echo "${VERSION}" | cut -d'-' -f2)
    git_hash=$(echo "${VERSION}" | cut -d'-' -f3)
    DEB_VERSION="0.0.0~nightly${date_part}.${git_hash}"
else
    # Remove v prefix if present
    DEB_VERSION="${VERSION#v}"
fi

# Map Go architectures to Debian architectures
case "${ARCH}" in
    "amd64") DEB_ARCH="amd64" ;;
    "arm64") DEB_ARCH="arm64" ;;
    *) echo "Unsupported architecture: ${ARCH}"; exit 1 ;;
esac

echo "Building Atlas .deb package version ${DEB_VERSION} for ${DEB_ARCH} (from ${VERSION})"

# Read EULA.txt content for injection
EULA_PATH="apps/atlas-installer/eula.txt"
if [[ ! -f "${EULA_PATH}" ]]; then
    echo "ERROR: ${EULA_PATH} file not found!"
    exit 1
fi
EULA_CONTENT=$(cat "${EULA_PATH}")

# Create package structure
PKG_DIR="atlas_${DEB_VERSION}_${DEB_ARCH}"
rm -rf "${PKG_DIR}"
mkdir -p "${PKG_DIR}/DEBIAN"
mkdir -p "${PKG_DIR}/usr/bin"
mkdir -p "${PKG_DIR}/usr/share/doc/atlas"

# Copy CLI binary
cp "build/atlas" "${PKG_DIR}/usr/bin/atlas"
chmod 755 "${PKG_DIR}/usr/bin/atlas"

# Copy credential fetching script
mkdir -p "${PKG_DIR}/usr/share/atlas/scripts"
cp "scripts/fetch-credentials.sh" "${PKG_DIR}/usr/share/atlas/scripts/fetch-credentials.sh"
chmod 755 "${PKG_DIR}/usr/share/atlas/scripts/fetch-credentials.sh"

# Copy web-app files if they exist
if [ -d "build/web-app-extract" ]; then
    echo "Including Atlas Web Client in package..."
    # Copy all extracted web-app files into the package
    cp -r build/web-app-extract/* "${PKG_DIR}/"
    echo "Web-app files included."
else
    echo "No web-app files found - building CLI-only package"
fi


# Create control file
cat > "${PKG_DIR}/DEBIAN/control" << EOF
Package: atlas
Version: ${DEB_VERSION}
Architecture: ${DEB_ARCH}
Maintainer: Tempest Labs, Inc. <support@tempestdx.com>
Depends: libc6, debconf (>= 1.5.19), wget, libgtk-3-0, libwebkit2gtk-4.1-0, libayatana-appindicator3-1
Section: utils
Priority: optional
Homepage: https://atlas.tempestdx.com
Description: Atlas AI Agent Orchestration Platform (CLI and GUI)
 Atlas creates intelligent systems from simple conversations. Simply tell Atlas
 what you want to achieve, and it creates intelligent operations that plan,
 execute, and adapt, all without brittle workflows or technical setup.
 .
 This package includes both the Atlas CLI and Atlas Web Client GUI.
EOF

# Format EULA text for debconf (add space and dot at beginning of each line)
FORMATTED_EULA=$(echo "${EULA_CONTENT}" | sed 's/^/ /; s/^$/& ./')

# Create templates file for debconf with EULA from file
cat > "${PKG_DIR}/DEBIAN/templates" << EOF
Template: atlas/eula
Type: boolean
Default: false
Description: Do you accept the Atlas End User License Agreement?
${FORMATTED_EULA}
EOF

# Create config script
cat > "${PKG_DIR}/DEBIAN/config" << 'EOF'
#!/bin/bash
set -e

# Source debconf library
. /usr/share/debconf/confmodule

# Only ask questions on fresh install, not upgrades
if [ "$1" = "configure" ] && [ -z "$2" ]; then
    # Ask for EULA acceptance
    db_input high atlas/eula || true
    db_go || true

    # Check if EULA was accepted
    db_get atlas/eula
    if [ "$RET" != "true" ]; then
        echo "You must accept the End User License Agreement to install Atlas."
        exit 1
    fi
fi

exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/config"

# Create preinst script
cat > "${PKG_DIR}/DEBIAN/preinst" << 'EOF'
#!/bin/bash
set -e

# Backup /etc/atlas/env if it contains user configuration (not just placeholder)
if [ -f /etc/atlas/env ] && grep -q "^ATLAS_KEY=" /etc/atlas/env 2>/dev/null; then
    cp /etc/atlas/env /etc/atlas/env.backup-upgrade
fi

# Stop existing atlas daemon if running
if systemctl is-active --quiet atlas.service 2>/dev/null; then
    echo "Stopping existing Atlas daemon..."
    systemctl stop atlas.service || true
fi

# Kill any remaining atlas processes
pkill -f "atlas daemon" || true

exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/preinst"

# Create postinst script
cat > "${PKG_DIR}/DEBIAN/postinst" << 'EOF'
#!/bin/bash
set -e

# Source debconf library
. /usr/share/debconf/confmodule

# Create atlas user if it doesn't exist
if ! id -u atlas >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/atlas --no-create-home --shell /bin/false atlas
fi

# Create necessary directories
mkdir -p /etc/atlas
mkdir -p /var/lib/atlas
mkdir -p /var/log/atlas

# Set proper permissions
chown atlas:atlas /var/lib/atlas
chown atlas:atlas /var/log/atlas
chmod 755 /usr/bin/atlas

# Restore backed up configuration if it exists
if [ -f /etc/atlas/env.backup-upgrade ]; then
    mv /etc/atlas/env.backup-upgrade /etc/atlas/env
elif [ ! -f /etc/atlas/env ]; then
    # Create default environment file with placeholder only if no backup and doesn't exist
    cat > /etc/atlas/env << 'ENVFILE'
# Atlas Configuration
# Get your Atlas Key from: https://atlas.tempestdx.com/
#
# Uncomment and add your Atlas Key below:
# ATLAS_KEY=your_atlas_key_here
ENVFILE
fi

# Always ensure correct permissions (fix upgrades from older versions)
chmod 640 /etc/atlas/env
chown root:atlas /etc/atlas/env

# Create systemd service file
cat > /etc/systemd/system/atlas.service << 'EOSF'
[Unit]
Description=Atlas AI Agent Orchestration Daemon
After=network.target
# Ensure environment file exists before starting
ConditionPathExists=/etc/atlas/env

[Service]
Type=exec
# Additional check that ATLAS_KEY is configured
ExecCondition=/bin/bash -c 'grep -q "^ATLAS_KEY=" /etc/atlas/env'
ExecStart=/usr/bin/atlas daemon start --port 8080
ExecStop=/usr/bin/atlas daemon stop
Restart=on-failure
RestartSec=5
User=atlas
Group=atlas
WorkingDirectory=/var/lib/atlas
Environment="HOME=/var/lib/atlas"
Environment="ATLAS_HOME=/var/lib/atlas"
Environment="ATLAS_SYSTEM_MODE=true"
EnvironmentFile=-/etc/atlas/env

# Security settings
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/atlas /var/log/atlas
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true

[Install]
WantedBy=multi-user.target
EOSF

# Reload systemd
systemctl daemon-reload

# Enable the service but DO NOT start it yet
systemctl enable atlas.service

# Only start the service if we have valid credentials
if [ -f /etc/atlas/env ] && grep -q "^ATLAS_KEY=" /etc/atlas/env 2>/dev/null; then
    echo "Starting Atlas daemon with configured credentials..."
    systemctl start atlas.service
fi

# Clean up debconf
db_stop

echo ""
echo "=== Atlas Installation Complete ==="
echo ""
if systemctl is-active --quiet atlas.service 2>/dev/null; then
    echo "✓ Atlas daemon is running"
    echo "  Status: systemctl status atlas.service"
    echo "  Logs:   journalctl -u atlas.service -f"
else
    echo "⚠ Atlas daemon is installed but not running"
    echo ""
    echo "To start Atlas:"
    echo "  1. Get your Atlas Key from https://atlas.tempestdx.com/"
    echo "  2. Edit /etc/atlas/env and add: ATLAS_KEY=your_key_here"
    echo "  3. Start the daemon: sudo systemctl start atlas.service"
fi
echo ""
echo "Atlas CLI: /usr/bin/atlas"
echo "Atlas Web Client: atlas-web-client"
echo ""

exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/postinst"

# Create prerm script
cat > "${PKG_DIR}/DEBIAN/prerm" << 'EOF'
#!/bin/bash
set -e

# Stop and disable the service before removal
if [ "$1" = "remove" ] || [ "$1" = "purge" ]; then
    if systemctl is-active --quiet atlas.service 2>/dev/null; then
        systemctl stop atlas.service || true
    fi
    if systemctl is-enabled --quiet atlas.service 2>/dev/null; then
        systemctl disable atlas.service || true
    fi
fi

exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/prerm"

# Create postrm script
cat > "${PKG_DIR}/DEBIAN/postrm" << 'EOF'
#!/bin/bash
set -e

if [ "$1" = "purge" ]; then
    # Remove configuration and data
    rm -rf /etc/atlas
    rm -rf /var/lib/atlas
    rm -rf /var/log/atlas

    # Remove atlas user
    if id -u atlas >/dev/null 2>&1; then
        userdel atlas || true
    fi

    # Remove systemd service file
    rm -f /etc/systemd/system/atlas.service
    systemctl daemon-reload || true
fi

exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/postrm"

# Create copyright file with full EULA
# Format EULA for copyright file (indent with single space)
FORMATTED_EULA_COPYRIGHT=$(printf '%s\n' "${EULA_CONTENT}" | sed 's/^/ /')

cat > "${PKG_DIR}/usr/share/doc/atlas/copyright" << EOF
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: Atlas
Upstream-Contact: Tempest Labs, Inc. <support@tempestdx.com>
Source: https://atlas.tempestdx.com

Files: *
Copyright: 2025 Tempest Labs, Inc.
License: Proprietary
${FORMATTED_EULA_COPYRIGHT}
EOF

# Build the package with root ownership
# --root-owner-group forces all files to be owned by root:root in the package
dpkg-deb --root-owner-group --build "${PKG_DIR}"

# Move to dist directory
mkdir -p dist
mv "${PKG_DIR}.deb" "dist/"

echo "Package built: dist/${PKG_DIR}.deb"