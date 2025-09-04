# Implementation Plan: Bundle Diagnostics Binary with Atlas Installer

## Overview

Add the `atlas-diagnostics` binary to the existing Atlas installer pipeline, deploying both binaries together in all distribution channels (Electron installer, DEB, RPM). The diagnostics tool is an internal implementation detail not exposed to users.

## Current State

- Main atlas binary: Built by `.github/actions/build-binary/action.yml`
- Diagnostics binary: Built by `.github/actions/build-diagnostics/action.yml`
- Electron installer: Deploys single binary from `atlas-binary/` directory
- Linux packages: Copy single binary from build output

## Required Changes

### 1. GitHub Workflow Changes (`.github/workflows/edge-release.yml`)

#### Add diagnostics build step after main binary build (line ~90):

**Note on parallelization**: These steps run sequentially within the job. To parallelize, you'd need to restructure into separate jobs with artifact passing, which adds complexity. Since each build takes ~2-3 minutes, sequential execution adds minimal overhead.

```yaml
- name: Build binary
  id: build
  uses: ./.github/actions/build-binary
  with:
    version: ${{ needs.check-changes.outputs.version }}
    platform: ${{ matrix.os }}
    arch: ${{ matrix.arch }}
    target: ${{ matrix.target }}

# NEW: Build diagnostics binary (runs sequentially after main binary)
- name: Build diagnostics binary
  id: build-diagnostics
  uses: ./.github/actions/build-diagnostics
  with:
    version: ${{ needs.check-changes.outputs.version }}
    platform: ${{ matrix.os }}
    arch: ${{ matrix.arch }}
    target: ${{ matrix.target }}

# NEW: Sign diagnostics binary on macOS
- name: Sign macOS diagnostics binary
  if: matrix.os == 'darwin'
  uses: ./.github/actions/macos-sign
  with:
    binary-path: ${{ steps.build-diagnostics.outputs.binary-path }}
    macos-sign-p12: ${{ secrets.MACOS_SIGN_P12 }}
    macos-sign-password: ${{ secrets.MACOS_SIGN_PASSWORD }}
    macos-sign-identity: ${{ secrets.MACOS_SIGN_IDENTITY }}
    macos-notary-issuer-id: ${{ secrets.MACOS_NOTARY_ISSUER_ID }}
    macos-notary-key-id: ${{ secrets.MACOS_NOTARY_KEY_ID }}
    macos-notary-key: ${{ secrets.MACOS_NOTARY_KEY }}
```

#### Update create archive step (line ~103) to include diagnostics:

```yaml
- name: Create archive
  run: |
    binary_name="${{ steps.build.outputs.binary-name }}"
    diagnostics_name="${{ steps.build-diagnostics.outputs.binary-name }}"  # NEW

    # ... existing archive creation ...

    if [ "${{ matrix.os }}" == "windows" ]; then
      7z a "./dist/${archive_name}" "./dist/${binary_name}" "./dist/${diagnostics_name}" README.md  # MODIFIED
    elif [ "${{ matrix.os }}" == "darwin" ]; then
      tar --format=pax -czf "./dist/${archive_name}" -C ./dist "${binary_name}" "${diagnostics_name}" -C .. README.md  # MODIFIED
    else
      tar -czf "./dist/${archive_name}" -C ./dist "${binary_name}" "${diagnostics_name}" -C .. README.md  # MODIFIED
    fi
```

#### Pass both binaries to create-installers (line ~133):

```yaml
- name: Create installers
  if: matrix.os != 'linux'
  id: installers
  uses: ./.github/actions/create-installers
  with:
    version: ${{ needs.check-changes.outputs.version }}
    platform: ${{ matrix.os }}
    arch: ${{ matrix.arch }}
    channel: edge
    binary-path: ${{ steps.build.outputs.binary-path }}
    binary-name: ${{ steps.build.outputs.binary-name }}
    diagnostics-binary-path: ${{ steps.build-diagnostics.outputs.binary-path }} # NEW
    diagnostics-binary-name: ${{ steps.build-diagnostics.outputs.binary-name }} # NEW
    # ... rest of inputs
```

#### Update Linux package build (line ~155):

```yaml
- name: Build Linux packages
  if: matrix.os == 'linux'
  run: |
    # ... existing setup ...

    # Create build directory and copy BOTH binaries
    mkdir -p build
    cp "${{ steps.build.outputs.binary-path }}" build/atlas
    cp "${{ steps.build-diagnostics.outputs.binary-path }}" build/atlas-diagnostics  # NEW
    chmod +x build/atlas
    chmod +x build/atlas-diagnostics  # NEW

    # ... rest remains same
```

#### Update artifact uploads to include diagnostics (line ~167-188):

```yaml
- name: Upload binary archives
  uses: actions/upload-artifact@v4
  with:
    name: atlas-${{ matrix.os }}-${{ matrix.arch }}
    path: |
      ./dist/atlas_*.tar.gz
      ./dist/atlas_*.zip
      ./dist/atlas_*.deb
      ./dist/atlas-*.rpm
      ./dist/atlas_*.sha256
      ./dist/atlas-diagnostics*  # NEW: Include diagnostics binaries
    retention-days: 1
```

### 2. Create Installers Action Changes (`.github/actions/create-installers/action.yml`)

#### Add new inputs (after line 21):

```yaml
diagnostics-binary-path:
  description: "Path to the diagnostics binary to package"
  required: false
diagnostics-binary-name:
  description: "Name of the diagnostics binary file"
  required: false
```

#### Update binary preparation step (line ~69):

```yaml
- name: Prepare Atlas binaries for installer
  shell: bash
  run: |
    # Create a staging directory for the installer
    mkdir -p tools/atlas-installer/atlas-binary

    # Copy the main binary
    cp "${{ inputs.binary-path }}" "tools/atlas-installer/atlas-binary/${{ inputs.binary-name }}"
    chmod +x "tools/atlas-installer/atlas-binary/${{ inputs.binary-name }}"

    # Copy the diagnostics binary if provided
    if [ -n "${{ inputs.diagnostics-binary-path }}" ]; then
      cp "${{ inputs.diagnostics-binary-path }}" "tools/atlas-installer/atlas-binary/${{ inputs.diagnostics-binary-name }}"
      chmod +x "tools/atlas-installer/atlas-binary/${{ inputs.diagnostics-binary-name }}"
      echo "Diagnostics binary prepared: tools/atlas-installer/atlas-binary/${{ inputs.diagnostics-binary-name }}"
    fi

    echo "Binaries prepared for installer"
```

### 3. Electron Installer Changes (`tools/atlas-installer/main.js`)

#### Modify install-atlas-binary handler (line ~130):

```javascript
ipcMain.handle("install-atlas-binary", async () => {
  try {
    // Define binaries to install
    const binaries = [
      { name: process.platform === "win32" ? "atlas.exe" : "atlas" },
      {
        name:
          process.platform === "win32"
            ? "atlas-diagnostics.exe"
            : "atlas-diagnostics",
      },
    ];

    const resourcesPath =
      process.resourcesPath || path.dirname(path.dirname(__dirname));
    const results = [];

    for (const binary of binaries) {
      let binarySource = path.join(
        resourcesPath,
        "app.asar.unpacked",
        "atlas-binary",
        binary.name,
      );

      if (!fs.existsSync(binarySource)) {
        // Fallback to development location
        binarySource = path.join(__dirname, "atlas-binary", binary.name);
      }

      // Fail if any binary doesn't exist (both are required)
      if (!fs.existsSync(binarySource)) {
        throw new Error(`Required binary ${binary.name} not found in installer package`);
      }

      // Determine installation path based on platform
      let installPath;
      if (process.platform === "win32") {
        const userProfile =
          process.env.USERPROFILE || process.env.HOME || "C:\\Users\\Default";
        installPath = path.join(
          userProfile,
          "AppData",
          "Local",
          "Atlas",
          binary.name,
        );
      } else if (process.platform === "darwin") {
        installPath = path.join(
          "/usr/local/bin",
          binary.name.replace(".exe", ""),
        );
      } else {
        installPath = path.join(os.homedir(), ".local", "bin", binary.name);
      }

      // ... existing installation logic for each binary ...

      results.push({ binary: binary.name, installed: installPath });
    }

    return {
      success: true,
      message: "Atlas CLI installed successfully",
      // Internal tracking of what was installed
      _installed: results,
    };
  } catch (error) {
    return { success: false, error: error.message };
  }
});
```

### 4. Linux Package Script Changes

#### DEB Script (`scripts/build-deb.sh`, line ~49):

```bash
# Copy both binaries
cp "build/atlas" "${PKG_DIR}/usr/bin/atlas"
cp "build/atlas-diagnostics" "${PKG_DIR}/usr/bin/atlas-diagnostics"  # NEW
chmod 755 "${PKG_DIR}/usr/bin/atlas"
chmod 755 "${PKG_DIR}/usr/bin/atlas-diagnostics"  # NEW
```

Note: The DEB package's postrm script already removes `/usr/bin/*` so both binaries will be removed on uninstall.

#### RPM Script (`scripts/build-rpm.sh`, line ~59):

```bash
# Copy both binaries to RPM build structure
cp "build/atlas" "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas"
cp "build/atlas-diagnostics" "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas-diagnostics"  # NEW
chmod 755 "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas"
chmod 755 "${BUILD_ROOT}/BUILDROOT/atlas-${RPM_VERSION}-${RPM_RELEASE}.${RPM_ARCH}/usr/bin/atlas-diagnostics"  # NEW
```

Also update the spec file `%files` section (around line ~250) to include:

```
%files
/usr/bin/atlas
/usr/bin/atlas-diagnostics
# ... rest of files
```

Note: RPM uninstall automatically removes all files listed in `%files`, so both binaries will be removed.

## Testing Requirements

1. **Build verification**:
   - Both binaries are built successfully in CI
   - Both binaries are included in archives

2. **Installer testing**:
   - Electron installer deploys both binaries to correct paths
   - Both commands work after installation (`atlas --version`, `atlas-diagnostics --version`)

3. **Linux package testing**:
   - DEB/RPM packages include both binaries
   - Both commands available after package installation

4. **Platform-specific testing**:
   - Windows: Both .exe files in `AppData\Local\Atlas`
   - macOS: Both binaries in `/usr/local/bin`
   - Linux: Both binaries in `/usr/bin` (packages) or `~/.local/bin` (installer)

## Critical Fixes Required Before Implementation

1. **macOS signing**: The diagnostics binary also needs to go through the macos-sign action after build (currently missing)
2. **Artifact upload**: The artifact upload steps (line ~167-188) need to include diagnostics binaries in the path patterns
3. **Archive checksums**: Checksum generation needs to handle both binaries

## Potential Issues to Watch

1. **Size increase**: Installers will roughly double in size (~60-100MB total)
2. **Signing complexity**: Both binaries need signing on macOS
3. **PATH conflicts**: Ensure no conflicts if user has existing atlas-diagnostics
4. **Version synchronization**: Both binaries will share the same version from the workflow
5. **Build failures**: Any failure in either binary build will fail the entire pipeline

## Design Decisions

1. **Build failure handling**: The build will fail if the diagnostics binary fails to build (both binaries are required)
2. **User messaging**: No user-facing messaging about diagnostics - it's an internal implementation detail
3. **Uninstall behavior**: Uninstalling Atlas will remove both binaries

## Implementation Order

1. Test diagnostics build action locally first
2. Update workflow to build both binaries
3. Update create-installers action
4. Update Electron installer main.js
5. Update Linux package scripts
6. Test full pipeline in a PR

## Future Optimization: Parallel Builds

If build time becomes an issue (currently adds ~2-3 minutes per platform), consider restructuring to parallel jobs:

```yaml
# Alternative approach with parallel jobs
jobs:
  build-atlas:
    # ... build main atlas binary, upload as artifact
  
  build-diagnostics:
    # ... build diagnostics binary, upload as artifact
  
  package:
    needs: [build-atlas, build-diagnostics]
    # ... download both artifacts, create installers
```

This would require more complex artifact management but would cut build time nearly in half.

## Validation Checklist

- [ ] Both binaries build successfully on all platforms
- [ ] Both binaries are signed on macOS
- [ ] Electron installer installs both binaries
- [ ] Linux packages include both binaries
- [ ] Both commands work after installation (`atlas --version`, `atlas-diagnostics` runs)
- [ ] Installer size remains reasonable (<150MB)
- [ ] Uninstall removes both binaries cleanly
- [ ] Build fails if either binary fails to compile
- [ ] No user-facing mentions of diagnostics in installer UI
