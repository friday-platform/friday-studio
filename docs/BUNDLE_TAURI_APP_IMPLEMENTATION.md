# Bundle Tauri App Implementation Guide

## Current State

- **Atlas CLI**: Built via Deno, packaged in Electron installer
- **Atlas Diagnostics**: Secondary Deno binary, already bundled
- **Atlas Web App**: Tauri app at `apps/web-client`, has build action but not bundled
- **Problem**: Users want single download for both CLI and GUI

## Critical Constraints

1. **Tauri outputs are themselves installers** (`.exe`, `.dmg`, `.deb`), not raw binaries
2. **macOS code signing** breaks if you move/embed `.app` bundles after signing
3. **Electron installer** runs as user, can't write to `/Applications` or `Program Files`
4. **Double runtime overhead**: Shipping both Electron (installer) and Tauri (app) = ~100MB bloat

## Implementation: Archive Bundle

**What**: ZIP containing both installers side-by-side
**Reality Check**: This is a band-aid for shipping two runtimes. Not elegant, but it works.

### Critical Path Issues Fixed

1. **Tauri outputs `.app` on macOS** - directly bundled without DMG packaging
2. **Version injection uses jq** for robust JSON manipulation
3. **Explicit file patterns** to avoid glob expansion failures
4. **Error handling** that doesn't silently swallow problems

### Implementation

**CRITICAL**: Archive creation happens in the `release` job (not `build` job) after all artifacts are downloaded.

Add to `.github/workflows/edge-release.yml` in release job after downloading artifacts:

```yaml
- name: Create combined archive
  run: |
    set -e  # Fail on any error
    mkdir atlas-bundle

    # Copy Electron installer (explicit patterns to avoid glob issues)
    if [ "${{ matrix.os }}" == "darwin" ]; then
      cp dist/atlas_*.zip atlas-bundle/ || { echo "Missing Electron installer"; exit 1; }
    elif [ "${{ matrix.os }}" == "windows" ]; then
      cp dist/atlas_*.exe atlas-bundle/atlas_installer.exe || { echo "Missing Electron installer"; exit 1; }
    else
      cp dist/atlas_*.AppImage atlas-bundle/ || { echo "Missing Electron installer"; exit 1; }
    fi

    # Copy Tauri installers (matching actual output from build-web-app action)
    if [ "${{ matrix.os }}" == "darwin" ]; then
      cp -r dist/*.app atlas-bundle/ || { echo "Missing Tauri app"; exit 1; }
      echo -e "Installation Steps:\n1. Run atlas installer\n2. Atlas Web Client.app will be installed automatically" > atlas-bundle/README.txt
    elif [ "${{ matrix.os }}" == "windows" ]; then
      # Copy both .exe and .msi from Tauri
      cp dist/Atlas_*.exe atlas-bundle/ 2>/dev/null || true
      cp dist/*.msi atlas-bundle/ 2>/dev/null || true
      if [ ! -f atlas-bundle/Atlas_*.exe ] && [ ! -f atlas-bundle/*.msi ]; then
        echo "Missing Tauri installer"; exit 1
      fi
      echo -e "Installation Steps:\n1. Run atlas_installer.exe\n2. Run Atlas installer (.exe or .msi)" > atlas-bundle/README.txt
    else
      # Linux: multiple possible formats
      cp dist/*.deb atlas-bundle/ 2>/dev/null || true
      cp dist/*.AppImage atlas-bundle/ 2>/dev/null || true
      if [ -z "$(ls atlas-bundle/*.deb atlas-bundle/*.AppImage 2>/dev/null)" ]; then
        echo "Missing Tauri installer"; exit 1
      fi
      echo -e "Installation Steps:\n1. Run atlas installer\n2. Install the .deb package OR run the AppImage" > atlas-bundle/README.txt
    fi

    # Create final archive
    if [ "${{ matrix.os }}" == "windows" ]; then
      7z a "dist/atlas_bundle_${{ needs.check-changes.outputs.version }}_${{ matrix.os }}_${{ matrix.arch }}.zip" atlas-bundle/*
    else
      tar -czf "dist/atlas_bundle_${{ needs.check-changes.outputs.version }}_${{ matrix.os }}_${{ matrix.arch }}.tar.gz" -C atlas-bundle .
    fi
    
    echo "Bundle created successfully"
    ls -la dist/atlas_bundle_*
```

## CI Pipeline Changes

### In build job matrix

```yaml
# After building diagnostics binary (line ~92)
- name: Build Tauri web app
  id: build-web-app
  uses: ./.github/actions/build-web-app
  with:
    version: ${{ needs.check-changes.outputs.version }}
    platform: ${{ matrix.os }}
    arch: ${{ matrix.arch }}
    target: ${{ matrix.target }}

# In artifact upload (line ~195)
- name: Upload all artifacts
  uses: actions/upload-artifact@v4
  with:
    name: atlas-${{ matrix.os }}-${{ matrix.arch }}
    path: |
      ./dist/atlas_*.tar.gz
      ./dist/atlas_*.zip
      ./dist/*.app          # Tauri macOS app bundle
      ./dist/Atlas_*.exe    # Tauri Windows installer
      ./dist/*.msi          # Tauri Windows MSI
      ./dist/*.deb          # Tauri Linux Debian package
      ./dist/*.AppImage     # Tauri Linux AppImage
```

### Version Injection in build-web-app Action

Add before the Tauri build step in `.github/actions/build-web-app/action.yml`:

```yaml
- name: Update version in Tauri config
  shell: bash
  working-directory: ./apps/web-client
  run: |
    # Use jq for proper JSON manipulation
    if ! command -v jq &> /dev/null; then
      echo "Installing jq..."
      if [ "${{ inputs.platform }}" == "linux" ]; then
        sudo apt-get install -y jq
      elif [ "${{ inputs.platform }}" == "darwin" ]; then
        brew install jq
      elif [ "${{ inputs.platform }}" == "windows" ]; then
        choco install jq
      fi
    fi
    
    # Update version in tauri.conf.json
    jq --arg version "${{ inputs.version }}" '.version = $version' \
      src-tauri/tauri.conf.json > src-tauri/tauri.conf.json.tmp
    mv src-tauri/tauri.conf.json.tmp src-tauri/tauri.conf.json
    
    echo "Updated Tauri version to: ${{ inputs.version }}"
    jq '.version' src-tauri/tauri.conf.json
```

## CRITICAL: Release Job Architecture Fix

The release job is already attempting bundling (lines 258-279) but using fragile pattern matching. The least-worst solution:

### Bundle in Build Jobs (Before Upload)

Add this **in the build job**, after building both components but before artifact upload:

```yaml
- name: Create platform bundle
  shell: bash
  run: |
    set -e
    bundle_name="atlas-bundle-${{ needs.check-changes.outputs.version }}-${{ matrix.os }}-${{ matrix.arch }}"
    mkdir -p "$bundle_name"
    
    # Copy Electron installer
    if [ "${{ matrix.os }}" == "darwin" ]; then
      cp dist/atlas_*.zip "$bundle_name/"
      cp -r dist/*.app "$bundle_name/" 2>/dev/null || echo "No app bundle found"
    elif [ "${{ matrix.os }}" == "windows" ]; then  
      cp dist/atlas_*.exe "$bundle_name/"
      cp dist/Atlas_*.exe "$bundle_name/" 2>/dev/null || echo "No Tauri exe"
      cp dist/*.msi "$bundle_name/" 2>/dev/null || echo "No MSI found"
    else
      cp dist/atlas_*.tar.gz "$bundle_name/" 2>/dev/null || true
      cp dist/*.AppImage "$bundle_name/" 2>/dev/null || echo "No AppImage"
      cp dist/*.deb "$bundle_name/" 2>/dev/null || echo "No deb"
    fi
    
    # Add README
    cat > "$bundle_name/README.txt" << 'EOF'
    Atlas Bundle - Two Components:
    1. Atlas CLI (installer)
    2. Atlas Web App (Tauri app)
    
    Install both for full functionality.
    EOF
    
    # Create archive
    if [ "${{ matrix.os }}" == "windows" ]; then
      7z a "dist/${bundle_name}.zip" "$bundle_name/*"
    else
      tar -czf "dist/${bundle_name}.tar.gz" "$bundle_name"
    fi
    
    echo "Bundle created: dist/${bundle_name}.*"
    ls -la dist/${bundle_name}.*
```

Then update artifact upload to include the bundle:
```yaml
- name: Upload binary archives
  uses: actions/upload-artifact@v4
  with:
    name: atlas-${{ matrix.os }}-${{ matrix.arch }}
    path: |
      ./dist/atlas-bundle-*.tar.gz
      ./dist/atlas-bundle-*.zip
      # ... existing patterns for individual files as fallback
```

### Why This Works Better

1. **Clear platform context**: Each build job knows its OS/arch
2. **No pattern matching hell**: No `find` commands or guessing
3. **Atomic bundles**: Each platform's bundle is created where components are built
4. **Release job stays simple**: Just publishes pre-made bundles

## Remaining Issues

### 1. **jq Availability**
- GitHub runners have jq on Linux/macOS but not Windows
- **Fix**: Add conditional installation or use PowerShell on Windows

### 2. **Windows Shell**
- Must add `shell: bash` to all steps on Windows
- Or use PowerShell equivalents

### 3. **Build Caching**
- Tauri might cache builds and ignore version changes
- **Fix**: Clear target directory or use `--force` flag

## The Real Timeline

- **Hour 1**: Implement bundling in build jobs
- **Hours 2-4**: Debug Windows path issues and shell problems  
- **Hours 5-8**: Fix artifact upload/download coordination
- **Day 2**: Discover edge cases, fix signing issues
- **Day 3**: Actually works across all platforms

This approach is still a band-aid, but at least it's a band-aid that won't fall off immediately.

## Final Verdict

**Will it work?** Yes, after debugging.

**Is it good?** No. You're shipping 200MB of redundant runtimes.

**Should you ship it?** Yes, because users need something now.

**What's the real fix?** Pick ONE technology stack. Either:
- Go all-in on Tauri for everything
- Or use Electron for everything
- Or build native installers that properly orchestrate components

But that's a bigger refactor than you want right now. Ship the bundle, move on.
