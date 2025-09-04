#!/bin/bash
set -e

VERSION=${VERSION:-1.0.0}
ARCH=${ARCH:-amd64}

# Convert edge/nightly versions to valid RPM version format
# 0.0.0-edge.YYYYMMDD.HHMMSS.gitsha -> Version: 0.0.0, Release: edge.YYYYMMDD.HHMMSS.gitsha
# 0.0.0-nightly.YYYYMMDD.gitsha -> Version: 0.0.0, Release: nightly.YYYYMMDD.gitsha
if [[ "${VERSION}" == *-edge.* ]]; then
    # Extract parts: 0.0.0-edge.20250716.002537.5e1e160
    RPM_VERSION=$(echo "${VERSION}" | cut -d'-' -f1)  # 0.0.0
    RPM_RELEASE=$(echo "${VERSION}" | cut -d'-' -f2-)  # edge.20250716.002537.5e1e160
elif [[ "${VERSION}" == *-nightly.* ]]; then
    # Extract parts: 0.0.0-nightly.20250716.5e1e160
    RPM_VERSION=$(echo "${VERSION}" | cut -d'-' -f1)  # 0.0.0
    RPM_RELEASE=$(echo "${VERSION}" | cut -d'-' -f2-)  # nightly.20250716.5e1e160
# Legacy formats for backward compatibility
elif [[ "${VERSION}" == edge-* ]]; then
    # Extract parts: edge-20250716-002537-5e1e160
    date_part=$(echo "${VERSION}" | cut -d'-' -f2)
    time_part=$(echo "${VERSION}" | cut -d'-' -f3)
    git_hash=$(echo "${VERSION}" | cut -d'-' -f4)
    RPM_VERSION="0.0.0"
    RPM_RELEASE="0.edge${date_part}${time_part}.${git_hash}"
elif [[ "${VERSION}" == nightly-* ]]; then
    # Extract parts: nightly-20250716-5e1e160
    date_part=$(echo "${VERSION}" | cut -d'-' -f2)
    git_hash=$(echo "${VERSION}" | cut -d'-' -f3)
    RPM_VERSION="0.0.0"
    RPM_RELEASE="0.nightly${date_part}.${git_hash}"
else
    # Remove v prefix if present
    RPM_VERSION="${VERSION#v}"
    RPM_RELEASE="1"
fi

# Map Go architectures to RPM architectures
case "${ARCH}" in
    "amd64") RPM_ARCH="x86_64" ;;
    "arm64") RPM_ARCH="aarch64" ;;
    *) echo "Unsupported architecture: ${ARCH}"; exit 1 ;;
esac

echo "Building Atlas .rpm package version ${RPM_VERSION}-${RPM_RELEASE} for ${RPM_ARCH} (from ${VERSION})"

# Read EULA.txt content for injection
if [[ ! -f "EULA.txt" ]]; then
    echo "ERROR: EULA.txt file not found!"
    exit 1
fi
EULA_CONTENT=$(cat EULA.txt)

# Check if we're trying to build ARM64 on x86_64
if [ "${RPM_ARCH}" = "aarch64" ] && [ "$(uname -m)" = "x86_64" ]; then
    echo "WARNING: Cannot build ARM64 RPMs on x86_64 host. Skipping RPM build."
    echo "ARM64 RPMs must be built on ARM64 hosts or using QEMU emulation."
    exit 0
fi

# Create RPM build structure
BUILD_ROOT="rpmbuild"
rm -rf "${BUILD_ROOT}"
mkdir -p "${BUILD_ROOT}"/{BUILD,RPMS,SOURCES,SPECS,SRPMS}
mkdir -p "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}"/{usr/bin,etc/atlas,"usr/share/doc/atlas-${RPM_VERSION}"}

# Copy both binaries to RPM build structure
cp "build/atlas" "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas"
cp "build/atlas-diagnostics" "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas-diagnostics"  # NEW
chmod 755 "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas"
chmod 755 "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas-diagnostics"  # NEW

# Copy credential fetching script
mkdir -p "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/atlas/scripts"
cp "tools/atlas-installer/scripts/fetch-credentials.sh" "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/atlas/scripts/fetch-credentials.sh"
chmod 755 "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/atlas/scripts/fetch-credentials.sh"

# Create systemd service file
mkdir -p "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/lib/systemd/system"
cat > "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/lib/systemd/system/atlas.service" << 'EOF'
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
EOF

# Create LICENSE file with full EULA content
cat > "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/doc/atlas-${RPM_VERSION}/LICENSE" << EOF
${EULA_CONTENT}
EOF

# Create spec file
cat > "${BUILD_ROOT}/SPECS/atlas.spec" << EOF
Name:           atlas
Version:        ${RPM_VERSION}
Release:        ${RPM_RELEASE}%{?dist}
Summary:        Atlas AI Agent Orchestration Platform
License:        Proprietary
URL:            https://atlas.tempestdx.com
BuildArch:      ${RPM_ARCH}

Requires:       glibc
Requires:       systemd
Requires:       wget
Requires(pre):  /usr/sbin/useradd, /usr/bin/getent
Requires(post): systemd
Requires(preun): systemd
Requires(postun): systemd

%description
Atlas creates intelligent systems from simple conversations. Simply tell Atlas
what you want to achieve, and it creates intelligent operations that plan,
execute, and adapt, all without brittle workflows or technical setup.

%pre
# Create atlas user if it doesn't exist
getent group atlas >/dev/null || groupadd -r atlas
getent passwd atlas >/dev/null || useradd -r -g atlas -d /var/lib/atlas -s /sbin/nologin -c "Atlas daemon user" atlas

# Stop existing atlas daemon if running
if systemctl is-active --quiet atlas.service 2>/dev/null; then
    echo "Stopping existing Atlas daemon..."
    systemctl stop atlas.service || true
fi

# Kill any remaining atlas processes
pkill -f "atlas daemon" || true

%post
# Create necessary directories
mkdir -p /etc/atlas
mkdir -p /var/lib/atlas
mkdir -p /var/log/atlas

# Set proper permissions
chown atlas:atlas /var/lib/atlas
chown atlas:atlas /var/log/atlas
chmod 755 /usr/bin/atlas

# Only configure on first install, not upgrades
if [ \$1 -eq 1 ]; then
    # Display EULA for acceptance
    echo ""
    echo "=== Atlas End User License Agreement ==="
    echo ""
    cat << 'EULA_TEXT'
${EULA_CONTENT}
EULA_TEXT
    echo ""
    read -r -p "Do you accept the license agreement? (yes/no): " ACCEPT_EULA

    if [ "\\${ACCEPT_EULA}" != "yes" ]; then
        echo "You must accept the End User License Agreement to install Atlas."
        exit 1
    fi

    # Check if credentials already exist
    if [ ! -f /etc/atlas/env ] || ! grep -q "^ANTHROPIC_API_KEY=" /etc/atlas/env 2>/dev/null; then
        echo ""
        echo "=== Atlas Key Configuration ==="
        echo ""
        echo "To use Atlas, you need an Atlas Key (JWT token)."
        echo "Get your Atlas Key from: https://atlas.tempestdx.com/"
        echo ""

        # Read Atlas Key
        while true; do
            read -r -p "Enter your Atlas Key (JWT token): " ATLAS_KEY

            if [ -z "\${ATLAS_KEY}" ]; then
                echo "No Atlas Key provided. You can configure credentials manually in /etc/atlas/env"
                break
            fi

            # Basic JWT format validation (three parts separated by dots)
            if echo "\${ATLAS_KEY}" | grep -q '^[A-Za-z0-9_-]\+\.[A-Za-z0-9_-]\+\.[A-Za-z0-9_-]\+$'; then
                # Save the Atlas Key to environment file
                echo "Saving Atlas Key..."

                # Create or update the environment file
                if [ -f /etc/atlas/env ]; then
                    # Remove any existing ATLAS_KEY line
                    grep -v "^ATLAS_KEY=" /etc/atlas/env > /etc/atlas/env.tmp || true
                    mv /etc/atlas/env.tmp /etc/atlas/env
                fi

                # Add the new ATLAS_KEY
                echo "ATLAS_KEY=\${ATLAS_KEY}" >> /etc/atlas/env
                chmod 644 /etc/atlas/env
                chown root:root /etc/atlas/env

                echo "Atlas Key saved successfully."
                echo "Credentials will be fetched when the daemon starts."
                break
            else
                echo "Invalid Atlas Key format. Atlas Keys are JWT tokens with three parts separated by dots."
                read -r -p "Try again? (y/n): " TRY_AGAIN
                if [ "\${TRY_AGAIN}" != "y" ]; then
                    echo "Skipping Atlas Key configuration. Configure manually in /etc/atlas/env"
                    break
                fi
            fi
        done
    fi
fi

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

%preun
# Stop and disable the service before removal
if [ \$1 -eq 0 ]; then
    if systemctl is-active --quiet atlas.service 2>/dev/null; then
        systemctl stop atlas.service || true
    fi
    if systemctl is-enabled --quiet atlas.service 2>/dev/null; then
        systemctl disable atlas.service || true
    fi
fi

%postun
# Clean up on complete removal
if [ \$1 -eq 0 ]; then
    # Remove configuration and data
    rm -rf /etc/atlas
    rm -rf /var/lib/atlas
    rm -rf /var/log/atlas

    # Remove atlas user
    if getent passwd atlas >/dev/null; then
        userdel atlas || true
    fi

    # Reload systemd
    systemctl daemon-reload || true
fi

%files
%defattr(-,root,root,-)
/usr/bin/atlas
/usr/bin/atlas-diagnostics
/usr/lib/systemd/system/atlas.service
/usr/share/atlas/scripts/fetch-credentials.sh
%doc /usr/share/doc/atlas-${RPM_VERSION}/LICENSE

%changelog
* $(date "+%a %b %d %Y") Tempest Labs <support@tempestdx.com> - ${VERSION}-1
- Initial release of Atlas
EOF

# Build the RPM
cd "${BUILD_ROOT}"
rpmbuild --define "_topdir $(pwd)" \
         --define "_rpmdir $(pwd)/RPMS" \
         --define "debug_package %{nil}" \
         --buildroot "$(pwd)/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}" \
         -bb SPECS/atlas.spec

# Move the built RPM to the dist directory
cd ..
mkdir -p dist
mv "${BUILD_ROOT}/RPMS/${RPM_ARCH}/atlas-${RPM_VERSION}-${RPM_RELEASE}"*."${RPM_ARCH}.rpm" "dist/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}.rpm"

echo "Package built: dist/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}.rpm"