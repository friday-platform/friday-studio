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
if [[ ! -f "EULA.txt" ]]; then
    echo "ERROR: EULA.txt file not found!"
    exit 1
fi
EULA_CONTENT=$(cat EULA.txt)

# Create package structure
PKG_DIR="atlas_${DEB_VERSION}_${DEB_ARCH}"
rm -rf "${PKG_DIR}"
mkdir -p "${PKG_DIR}/DEBIAN"
mkdir -p "${PKG_DIR}/usr/bin"
mkdir -p "${PKG_DIR}/usr/share/doc/atlas"

# Copy binary
cp "build/atlas" "${PKG_DIR}/usr/bin/atlas"
chmod 755 "${PKG_DIR}/usr/bin/atlas"

# Copy credential fetching script
mkdir -p "${PKG_DIR}/usr/share/atlas/scripts"
cp "scripts/fetch-credentials.sh" "${PKG_DIR}/usr/share/atlas/scripts/fetch-credentials.sh"
chmod 755 "${PKG_DIR}/usr/share/atlas/scripts/fetch-credentials.sh"


# Create control file
cat > "${PKG_DIR}/DEBIAN/control" << EOF
Package: atlas
Version: ${DEB_VERSION}
Architecture: ${DEB_ARCH}
Maintainer: Tempest Labs, Inc. <support@tempestdx.com>
Depends: libc6, debconf (>= 1.5.19), wget
Section: utils
Priority: optional
Homepage: https://atlas.tempestdx.com
Description: Atlas AI Agent Orchestration Platform
 Atlas creates intelligent systems from simple conversations. Simply tell Atlas
 what you want to achieve, and it creates intelligent operations that plan,
 execute, and adapt, all without brittle workflows or technical setup.
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

Template: atlas/atlaskey
Type: string
Default:
Description: Enter your Atlas Key:
 To use Atlas, you need an Atlas Key (JWT token).
 Get your Atlas Key from: https://atlas.tempestdx.com/
 .
 The Atlas Key will be used to automatically fetch your AI agent credentials.
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

    # Ask for Atlas Key if not already configured
    if [ ! -f /etc/atlas/env ] || ! grep -q "^ANTHROPIC_API_KEY=" /etc/atlas/env 2>/dev/null; then
        db_input high atlas/atlaskey || true
        db_go || true
    fi
fi

exit 0
EOF
chmod 755 "${PKG_DIR}/DEBIAN/config"

# Create preinst script
cat > "${PKG_DIR}/DEBIAN/preinst" << 'EOF'
#!/bin/bash
set -e

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

# Handle Atlas Key from debconf
if [ "$1" = "configure" ]; then
    # Get Atlas Key from debconf
    db_get atlas/atlaskey
    if [ -n "$RET" ]; then
        # Save the Atlas Key to environment file
        echo "Atlas Key provided. Saving to configuration..."

        # Create or update the environment file with ATLAS_KEY
        if [ -f /etc/atlas/env ]; then
            # Remove any existing ATLAS_KEY line
            grep -v "^ATLAS_KEY=" /etc/atlas/env > /etc/atlas/env.tmp || true
            mv /etc/atlas/env.tmp /etc/atlas/env
        fi

        # Add the new ATLAS_KEY
        echo "ATLAS_KEY=$RET" >> /etc/atlas/env
        chmod 644 /etc/atlas/env
        chown root:root /etc/atlas/env

        echo "Atlas Key saved successfully."
        echo "Credentials will be fetched when the daemon starts."
    else
        echo "No Atlas Key provided. You can configure credentials manually in /etc/atlas/env"
    fi
fi

# Create systemd service file
cat > /etc/systemd/system/atlas.service << 'EOSF'
[Unit]
Description=Atlas AI Agent Orchestration Daemon
After=network.target
# Ensure environment file exists before starting
ConditionPathExists=/etc/atlas/env
# Additional check that ANTHROPIC_API_KEY is configured
ExecCondition=/bin/bash -c 'grep -q "^ATLAS_KEY=" /etc/atlas/env'

[Service]
Type=exec
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
else
    echo "Atlas daemon enabled but not started - no credentials configured."
    echo "Configure credentials in /etc/atlas/env and run: systemctl start atlas.service"
fi

# Clean up debconf
db_stop

echo ""
echo "=== Atlas Installation Complete ==="
echo ""
if systemctl is-active --quiet atlas.service 2>/dev/null; then
    echo "Atlas daemon has been installed and started as a systemd service."
else
    echo "Atlas daemon has been installed and enabled as a systemd service."
    echo "Service will start automatically when credentials are properly configured."
fi
echo "Service status: systemctl status atlas.service"
echo "View logs: journalctl -u atlas.service -f"
echo ""
echo "Atlas CLI is available at: /usr/bin/atlas"
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

# Build the package
dpkg-deb --build "${PKG_DIR}"

# Move to dist directory
mkdir -p dist
mv "${PKG_DIR}.deb" "dist/"

echo "Package built: dist/${PKG_DIR}.deb"