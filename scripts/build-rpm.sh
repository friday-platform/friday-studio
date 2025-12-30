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
EULA_PATH="apps/atlas-installer/eula.txt"
if [[ ! -f "${EULA_PATH}" ]]; then
    echo "ERROR: ${EULA_PATH} file not found!"
    exit 1
fi
EULA_CONTENT=$(cat "${EULA_PATH}")

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

# Copy CLI binary to RPM build structure
cp "build/atlas" "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas"
chmod 755 "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas"

# Copy credential fetching script
mkdir -p "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/atlas/scripts"
cp "scripts/fetch-credentials.sh" "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/atlas/scripts/fetch-credentials.sh"
chmod 755 "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/atlas/scripts/fetch-credentials.sh"

# Copy web-app files if they exist
if [ -d "build/web-app-extract" ]; then
    echo "Including Atlas Web Client in package..."
    # Copy all extracted web-app files into the package
    cp -r build/web-app-extract/* "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/"
    echo "Web-app files included."
else
    echo "No web-app files found - building CLI-only package"
fi

# Create systemd service file
mkdir -p "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/lib/systemd/system"
cat > "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/lib/systemd/system/atlas.service" << 'EOF'
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
EOF

# Create LICENSE file with full EULA content
cat > "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/share/doc/atlas-${RPM_VERSION}/LICENSE" << EOF
${EULA_CONTENT}
EOF

# Generate file list for %files section dynamically
# This captures all files including web-app files if present
BUILDROOT_PATH="${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}"

# Create a temporary file for the file list to avoid shell expansion issues
FILES_LIST_FILE="${BUILD_ROOT}/files.list"
> "${FILES_LIST_FILE}"

# Find all files and symlinks, output with null delimiter to handle spaces
while IFS= read -r -d '' file; do
    # Remove the buildroot prefix to get the actual install path
    install_path="${file#${BUILDROOT_PATH}}"
    if [[ -n "$install_path" && "$install_path" != "/" ]]; then
        # Quote paths with spaces for RPM spec
        if [[ "$install_path" =~ [[:space:]] ]]; then
            echo "\"${install_path}\"" >> "${FILES_LIST_FILE}"
        else
            echo "${install_path}" >> "${FILES_LIST_FILE}"
        fi
    fi
done < <(find "${BUILDROOT_PATH}" \( -type f -o -type l \) -print0 | sort -z)

# Create a temporary file for the directory list
DIRS_LIST_FILE="${BUILD_ROOT}/dirs.list"
> "${DIRS_LIST_FILE}"

# Find all directories, output with null delimiter
while IFS= read -r -d '' dir; do
    dir_path="${dir#${BUILDROOT_PATH}}"
    if [[ -n "$dir_path" && "$dir_path" != "/" ]]; then
        # Quote paths with spaces for RPM spec
        if [[ "$dir_path" =~ [[:space:]] ]]; then
            echo "%dir \"${dir_path}\"" >> "${DIRS_LIST_FILE}"
        else
            echo "%dir ${dir_path}" >> "${DIRS_LIST_FILE}"
        fi
    fi
done < <(find "${BUILDROOT_PATH}" -type d ! -path "${BUILDROOT_PATH}" -print0 | sort -z)

# Create spec file
cat > "${BUILD_ROOT}/SPECS/atlas.spec" << EOF
Name:           atlas
Version:        ${RPM_VERSION}
Release:        ${RPM_RELEASE}%{?dist}
Summary:        Atlas AI Agent Orchestration Platform (CLI and GUI)
License:        Proprietary
URL:            https://hellofriday.ai
BuildArch:      ${RPM_ARCH}

Requires:       glibc
Requires:       systemd
Requires:       wget
Requires:       gtk3
Requires:       webkit2gtk4.1
Requires:       libayatana-appindicator-gtk3
Requires(pre):  /usr/sbin/useradd, /usr/bin/getent
Requires(post): systemd
Requires(preun): systemd
Requires(postun): systemd

%description
Atlas creates intelligent systems from simple conversations. Simply tell Atlas
what you want to achieve, and it creates intelligent operations that plan,
execute, and adapt, all without brittle workflows or technical setup.

This package includes both the Atlas CLI and Atlas Web Client GUI.

%pre
# Backup /etc/atlas/env if it contains user configuration (not just placeholder)
if [ -f /etc/atlas/env ] && grep -q "^ATLAS_KEY=" /etc/atlas/env 2>/dev/null; then
    cp /etc/atlas/env /etc/atlas/env.backup-upgrade
fi

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

# Restore backed up configuration if it exists
if [ -f /etc/atlas/env.backup-upgrade ]; then
    mv /etc/atlas/env.backup-upgrade /etc/atlas/env
elif [ ! -f /etc/atlas/env ]; then
    # Create default environment file with placeholder only if no backup and doesn't exist
    cat > /etc/atlas/env << 'ENVFILE'
# Atlas Configuration
# Get your Atlas Key from: https://hellofriday.ai/
#
# Uncomment and add your Atlas Key below:
# ATLAS_KEY=your_atlas_key_here
ENVFILE
fi

# Always ensure correct permissions (fix upgrades from older versions)
chmod 640 /etc/atlas/env
chown root:atlas /etc/atlas/env

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
fi

# Reload systemd
systemctl daemon-reload

# Enable the service but DO NOT start it yet
systemctl enable atlas.service

# Only start the service if we have valid credentials
if [ -f /etc/atlas/env ] && grep -q "^ATLAS_KEY=" /etc/atlas/env 2>/dev/null; then
    echo "Starting Atlas daemon with configured credentials..."
    systemctl start atlas.service
fi

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
    echo "  1. Get your Atlas Key from https://hellofriday.ai/"
    echo "  2. Edit /etc/atlas/env and add: ATLAS_KEY=your_key_here"
    echo "  3. Start the daemon: sudo systemctl start atlas.service"
fi
echo ""
echo "Atlas CLI: /usr/bin/atlas"
echo "Atlas Web Client: atlas-web-client"
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
$(cat "${DIRS_LIST_FILE}")
$(cat "${FILES_LIST_FILE}")

%changelog
* $(date "+%a %b %d %Y") Tempest Labs <support@tempestdx.com> - ${VERSION}-1
- Initial release of Atlas
EOF

# Build the RPM
# The %defattr(-,root,root,-) in the spec file handles ownership
cd "${BUILD_ROOT}"
rpmbuild --define "_topdir $(pwd)" \
         --define "_rpmdir $(pwd)/RPMS" \
         --define "debug_package %{nil}" \
         --define "_build_id_links none" \
         --buildroot "$(pwd)/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}" \
         -bb SPECS/atlas.spec

# Move the built RPM to the dist directory
cd ..
mkdir -p dist
mv "${BUILD_ROOT}/RPMS/${RPM_ARCH}/atlas-${RPM_VERSION}-${RPM_RELEASE}"*."${RPM_ARCH}.rpm" "dist/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}.rpm"

echo "Package built: dist/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}.rpm"