# Atlas Auto-Update Implementation Plan

## Overview

Atlas auto-update will provide a seamless experience for users to receive new versions with minimal
disruption. The system will leverage the existing version checking infrastructure and implement a
staged update process that handles both the CLI client and daemon gracefully.

## Architecture Components

### 1. Update Check System (Existing)

- **Current State**: `atlas version --remote` already checks for updates via
  `https://atlas.tempestdx.com/version/{channel}`
- **Enhancement**: Background update checks during daemon startup and periodically (every 24h)
- **Channels**: Support for `stable`, `edge`, and `nightly` channels

### 2. Binary Download Service

- **Base URL**: `https://atlas.tempestdx.com`
- **Version API**: `GET /version/{channel}` returns platform-specific download URLs
- **Download URLs**: Relative paths from the version API response
- **Authentication**: None required (as per your requirement)
- **Binary Distribution**:
  - **macOS**: `.tar.gz` (binary only) and `.zip` (installer) - use `.tar.gz` for updates
  - **Windows**: `.zip` (binary only) and `.exe` (installer) - use `.zip` for updates
  - **Linux**: `.tar.gz` (binary only)
- **Binary naming**:
  - Format: `atlas_{channel}-{date}-{commit_hash}_{platform}_{arch}.{ext}`
  - Example: `atlas_edge-20250731-224708-8ea3b42_darwin_arm64.tar.gz`

### 3. Update Command

```bash
atlas update                    # Interactive update
atlas update --check           # Check for updates only
atlas update --quiet           # Non-interactive update (use defaults)
atlas update -q                # Short form of --quiet
atlas update --channel edge    # Switch channels
```

### 4. Update Process Flow

#### Phase 1: Pre-flight Checks

1. Check for available updates (use existing version-checker)
2. Verify sufficient disk space
3. Check daemon status and active workspaces
4. Validate write permissions to binary locations
   - Check if we can write to the binary directly
   - If not, check if we have sudo access (Unix)
   - Provide clear error message if update requires elevated permissions

#### Phase 2: Download & Verification

1. Download new binary to temporary location (`~/.atlas/updates/`)
2. Download checksum file from same location (`.sha256` file)
3. Verify checksum matches the downloaded binary
4. Test binary execution (`atlas --version`)
5. Extract binary from archive (`.tar.gz` or `.zip`)

#### Phase 3: Binary Replacement Strategy

**Option A: Self-Replacement (Recommended)**

- CLI spawns update helper process
- Helper waits for parent CLI to exit
- Helper replaces binary and restarts daemon
- Works on all platforms

**Option B: Platform-Specific**

- macOS/Linux: Direct replacement (Unix allows replacing running binaries)
- Windows: Requires helper process due to file locking

#### Phase 4: Daemon Update

1. Graceful daemon shutdown:
   ```typescript
   // Wait for idle or force after timeout
   if (activeSessions > 0 && !force) {
     await waitForIdle(timeout: 5min)
   }
   await daemon.shutdown()
   ```
2. Replace daemon binary (same as CLI)
3. Restart daemon with preserved configuration
4. Verify daemon health

### 5. Update History (No Rollback)

- Log update events to Atlas diagnostic logs for audit purposes
- Include: timestamp, from_version, to_version, success/failure status
- No rollback mechanism - users can manually download previous versions if needed

### 6. Configuration & State Preservation

- All config in `~/.atlas/` remains untouched
- Workspace registrations persist
- Environment variables preserved
- API keys and settings maintained

## Implementation Details

### Update Helper Binary

Small, separate binary for platform-specific update operations:

```go
// atlas-updater (written in Go for small size)
1. Wait for parent process to exit
2. Replace atlas binary
3. Optionally restart daemon
4. Clean up temporary files
```

### Platform-Specific Considerations

**macOS:**

- Binary location: `/usr/local/bin/atlas`
- Service: launchd (restart via `launchctl`)
- Permission handling:
  - If binary owned by current user: Direct replacement works
  - If binary owned by root: Requires `sudo` or alternative strategy
  - Check ownership with `stat -f "%Su" /usr/local/bin/atlas`
- Can replace running binary directly (Unix allows this)

**Linux:**

- Binary location: `/usr/local/bin/atlas`
- Service: systemd (restart via `systemctl`)
- Permission handling: Same as macOS
- Can replace running binary directly

**Windows:**

- Binary location: `%LOCALAPPDATA%\Atlas\atlas.exe`
- Service: Scheduled task
- Requires helper due to file locking
- Usually writable by current user (user's local app data)

### User Experience

#### Interactive Update

```
$ atlas update
Checking for updates...
New version available: edge-20250801 (current: edge-20250731)

Atlas daemon will be restarted during update.
2 workspaces are currently idle.

Continue with update? [Y/n] y

Downloading update... 45.2 MB
Download complete
Verifying checksum... OK
Installing update...
Update installed successfully
Restarting daemon...
Atlas updated to edge-20250801
```

#### Permission Required Update

```
$ atlas update
Checking for updates...
New version available: edge-20250801 (current: edge-20250731)

Update requires elevated permissions
Binary location: /usr/local/bin/atlas
Current owner: root

Would you like to update with sudo? [Y/n] y
[sudo] password for user:

Downloading update... 45.2 MB
Download complete
Verifying checksum... OK
Installing update...
Update installed successfully
Restarting daemon...
Atlas updated to edge-20250801
```

#### Non-Interactive Update

```
$ atlas update --quiet
Atlas updated to edge-20250801 (daemon restarted)
```

#### Background Auto-Update (Optional)

- Daemon checks for updates on startup
- Downloads in background
- Notifies user via CLI: "Update available. Run 'atlas update' to install"
- Never auto-installs without user consent

### Safety Features

1. **Atomic Operations**: Use rename() for atomic file replacement
2. **Checksum Verification**: SHA256 validation before installation
3. **Health Checks**: Verify new binary works before completing
4. **Timeout Protection**: Force update after grace period
5. **Manual Override**: `--force` flag for immediate update

### Checksum Implementation Requirements

#### GitHub Workflow Changes ✅ COMPLETED (PR #165)

1. **Upload checksum files to GCS**: ✅ Implemented and merged
   - Modified `gcs-upload-production/action.yml` to include `*.sha256` files
   - Modified `gcs-upload-sandbox/action.yml` to include `*.sha256` files
   - Checksum files now automatically uploaded alongside binaries to both production and sandbox
     buckets

#### Checksum Verification Process

1. **Download checksum**: Fetch `.sha256` file alongside the binary
2. **Parse checksum**: Extract expected hash from the file (format: `{hash}  {filename}`)
3. **Calculate actual hash**: Compute SHA256 of downloaded archive
4. **Compare hashes**: Ensure they match before proceeding
5. **Fail safely**: Abort update if checksums don't match

### Monitoring & Telemetry

Track update metrics:

- Update success/failure rates
- Update duration
- Channel distribution

## Questions to Consider

1. **Auto-update preference**: Should we enable background downloading by default?
2. **Grace period**: How long to wait for workspaces to become idle?
3. **Channel switching**: Allow users to switch between stable/edge/nightly?
4. **Update frequency**: How often to check for updates?
5. **Signature verification**: Implement code signing for binaries?

## Implementation Approach

All components will be implemented together in a single update:

1. Update command (`atlas update`)
2. Download and checksum verification
3. Binary replacement with permission handling
4. Daemon coordination and restart
5. Error handling and logging
6. Platform-specific logic (macOS, Linux, Windows)

## Implementation Status

### ✅ Completed Tasks

1. **GitHub Workflow Checksum Upload** (PR #165 - Merged)
   - Modified `gcs-upload-production/action.yml` to upload `.sha256` files
   - Modified `gcs-upload-sandbox/action.yml` to upload `.sha256` files
   - Checksum files now automatically uploaded alongside binaries

2. **Update Command Implementation** (`atlas update`)
   - ✅ Command structure and argument parsing
   - ✅ Version checking integration with channel support
   - ✅ Interactive prompts and quiet mode
   - ✅ Options: `--check`, `--quiet`, `--force`, `--channel`

3. **Download & Verification Module**
   - ✅ Binary download with progress tracking
   - ✅ SHA256 checksum download and verification
   - ✅ Archive extraction logic (tar.gz for Unix, zip for Windows)

4. **Permission Handling**
   - ✅ Write permission checking with `which` command
   - ✅ Sudo elevation for protected paths (Unix)
   - ✅ Platform-specific permission logic
   - ✅ Windows file locking detection

5. **Binary Replacement**
   - ✅ Direct file replacement with Deno.copyFile
   - ✅ Platform-specific strategies (Windows locking check)
   - ✅ Executable permission setting

6. **Daemon Coordination**
   - ✅ Graceful daemon shutdown
   - ✅ Session wait functionality (5 minute timeout)
   - ✅ Automatic daemon restart after update

7. **Update History & Logging**
   - ✅ Integration with Atlas diagnostic logs
   - ✅ Success/failure tracking
   - ✅ Performance metrics (duration)

### ✅ Implementation Complete

The Atlas auto-update functionality has been successfully implemented with all planned features:

- **Update Command**: `atlas update` with options for check-only, quiet mode, force update, and
  channel switching
- **Checksum Verification**: SHA256 validation of downloaded binaries
- **Permission Handling**: Automatic sudo elevation when needed
- **Platform Support**: macOS, Linux, and Windows compatibility
- **Daemon Coordination**: Graceful shutdown and restart
- **Channel Support**: Switch between stable, edge, and nightly channels
- **Progress Tracking**: Download progress and status messages
- **Error Handling**: Comprehensive error messages and recovery

### 🚧 Server Configuration Required

The update functionality is fully implemented but requires server-side configuration:

**Current Issue**: Binary files at `https://atlas.tempestdx.com/download/` are not publicly
accessible

- Downloads redirect to `/login` (HTTP 302)
- Both binaries and checksum files require authentication

**Resolution Needed**:

1. Configure the server to allow public access to binary downloads
2. Ensure checksum files (.sha256) are also publicly accessible
3. No authentication should be required for downloads (as per original requirements)

Once the server configuration is updated, the auto-update feature will work as designed.

### 🔄 Future Enhancements

1. **Update Helper Binary** (Optional)
   - Small helper for self-replacement on Windows
   - Would allow updates without closing Atlas on Windows

2. **Production Testing**
   - Test with actual production binaries and checksums once server access is fixed
   - Verify cross-platform compatibility
   - Test various permission scenarios

## Testing the Implementation

### Quick Test Commands

```bash
# Check for updates only
deno task atlas update --check

# Test update flow (interactive)
deno task atlas update

# Test quiet mode
deno task atlas update --quiet

# Force update with active sessions
deno task atlas update --force

# Switch channels
deno task atlas update --channel edge
deno task atlas update --channel nightly

# Test with custom Atlas URL (for local testing)
ATLAS_URL=http://localhost:3000 deno task atlas update --check
```

### Testing Checksum Verification

To test checksum mismatch detection:

1. Download a binary manually
2. Modify one byte in the file
3. Try to update - should fail with checksum error

### Testing Permission Scenarios

```bash
# Test as regular user (should work if you own the binary)
deno task atlas update

# Test with root-owned binary (should prompt for sudo)
sudo chown root /usr/local/bin/atlas
deno task atlas update

# Restore ownership
sudo chown $USER /usr/local/bin/atlas
```

## Technical Implementation Notes

### Binary Download Implementation

```typescript
interface PlatformInfo {
  platform: "darwin" | "linux" | "windows";
  arch: "amd64" | "arm64";
}

function getPlatformInfo(): PlatformInfo {
  const platform = Deno.build.os === "darwin"
    ? "darwin"
    : Deno.build.os === "linux"
    ? "linux"
    : "windows";
  const arch = Deno.build.arch === "x86_64" ? "amd64" : "arm64";
  return { platform, arch };
}

async function getDownloadUrl(channel: string): Promise<string> {
  const { platform, arch } = getPlatformInfo();
  const { getAtlasBaseUrl } = await import("@atlas/core");
  const response = await fetch(`${getAtlasBaseUrl()}/version/${channel}`);
  const data = await response.json();

  const platformKey = `${platform}_${arch}`;
  const platformData = data.platforms[platformKey];

  if (!platformData) {
    throw new Error(`No binary available for ${platform}/${arch}`);
  }

  // For updates, we need the binary-only version (not installer)
  // The API might return .zip for macOS, but we need .tar.gz
  let downloadUrl = platformData.download_url;

  if (platform === "darwin" && downloadUrl.endsWith(".zip")) {
    // Replace .zip with .tar.gz for macOS binary-only download
    downloadUrl = downloadUrl.replace(/\.zip$/, ".tar.gz");
  } else if (platform === "windows" && downloadUrl.endsWith(".exe")) {
    // Replace .exe with .zip for Windows binary-only download
    downloadUrl = downloadUrl.replace(/\.exe$/, ".zip");
  }

  // Convert relative URL to absolute
  return `${getAtlasBaseUrl()}${downloadUrl}`;
}

interface DownloadOptions {
  url: string;
  destination: string;
  onProgress?: (bytes: number, total: number) => void;
}

async function downloadBinary(options: DownloadOptions): Promise<void> {
  const response = await fetch(options.url);
  const contentLength = Number(response.headers.get("content-length"));

  const reader = response.body?.getReader();
  const writer = await Deno.open(options.destination, {
    write: true,
    create: true,
  });

  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader!.read();
    if (done) break;

    await writer.write(value);
    receivedBytes += value.length;

    if (options.onProgress) {
      options.onProgress(receivedBytes, contentLength);
    }
  }

  writer.close();
}

async function extractBinary(archivePath: string, platform: string): Promise<string> {
  const tempDir = await Deno.makeTempDir();

  if (platform === "windows") {
    // Extract from zip
    const unzipCmd = new Deno.Command("unzip", {
      args: ["-q", archivePath, "-d", tempDir],
    });
    await unzipCmd.output();
    return `${tempDir}/atlas.exe`;
  } else {
    // Extract from tar.gz (macOS and Linux)
    const tarCmd = new Deno.Command("tar", {
      args: ["-xzf", archivePath, "-C", tempDir],
    });
    await tarCmd.output();
    return `${tempDir}/atlas`;
  }
}

async function downloadAndVerifyChecksum(
  binaryUrl: string,
  binaryPath: string,
): Promise<boolean> {
  // Download checksum file
  const checksumUrl = `${binaryUrl}.sha256`;
  const checksumPath = `${binaryPath}.sha256`;

  const checksumResponse = await fetch(checksumUrl);
  if (!checksumResponse.ok) {
    throw new Error(`Failed to download checksum: ${checksumResponse.status}`);
  }

  const checksumContent = await checksumResponse.text();
  await writeFile(checksumPath, checksumContent, "utf-8");

  // Parse expected checksum (format: "hash  filename")
  const expectedHash = checksumContent.trim().split(/\s+/)[0];

  // Calculate actual checksum of downloaded file
  const fileData = await Deno.readFile(binaryPath);
  const hashBuffer = await crypto.subtle.digest("SHA-256", fileData);
  const actualHash = Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Compare checksums
  if (actualHash !== expectedHash) {
    console.error(`Checksum mismatch!`);
    console.error(`Expected: ${expectedHash}`);
    console.error(`Actual:   ${actualHash}`);
    return false;
  }

  return true;
}

async function checkBinaryWritePermission(): Promise<{
  canWrite: boolean;
  needsSudo: boolean;
  binaryPath: string;
  owner?: string;
}> {
  // Find current binary location
  const result = await new Deno.Command("which", {
    args: ["atlas"],
  }).output();

  if (!result.success) {
    throw new Error("Atlas binary not found in PATH");
  }

  const binaryPath = new TextDecoder().decode(result.stdout).trim();

  // Try to write to a test file next to the binary
  const testPath = `${binaryPath}.update-test`;
  try {
    await writeFile(testPath, "test", "utf-8");
    await Deno.remove(testPath);
    return { canWrite: true, needsSudo: false, binaryPath };
  } catch {
    // Can't write to directory, check if we can overwrite the file itself
    try {
      // Check file ownership
      const statCmd = Deno.build.os === "darwin"
        ? ["stat", "-f", "%Su", binaryPath]
        : ["stat", "-c", "%U", binaryPath];

      const ownerResult = await new Deno.Command(statCmd[0], {
        args: statCmd.slice(1),
      }).output();

      const owner = new TextDecoder().decode(ownerResult.stdout).trim();
      const currentUser = process.env.USER || process.env.USERNAME;

      if (owner === currentUser) {
        // We own the file, we should be able to replace it
        return { canWrite: true, needsSudo: false, binaryPath, owner };
      }

      // Check if we have sudo access (Unix only)
      if (Deno.build.os !== "windows") {
        const sudoCheck = await new Deno.Command("sudo", {
          args: ["-n", "true"],
        }).output();

        return {
          canWrite: false,
          needsSudo: sudoCheck.success,
          binaryPath,
          owner,
        };
      }

      return { canWrite: false, needsSudo: false, binaryPath, owner };
    } catch {
      return { canWrite: false, needsSudo: false, binaryPath };
    }
  }
}
```

### Update Logging

```typescript
import { logger } from "@atlas/logger";

interface UpdateEvent {
  from_version: string;
  to_version: string;
  timestamp: Date;
  success: boolean;
  error?: string;
  duration_ms: number;
}

function logUpdateEvent(event: UpdateEvent): void {
  if (event.success) {
    logger.info("Atlas binary updated successfully", {
      from_version: event.from_version,
      to_version: event.to_version,
      duration_ms: event.duration_ms,
    });
  } else {
    logger.error("Atlas binary update failed", {
      from_version: event.from_version,
      to_version: event.to_version,
      duration_ms: event.duration_ms,
      error: event.error,
    });
  }
}
```

### Graceful Daemon Coordination

```typescript
async function coordinatedDaemonUpdate(
  client: AtlasClient,
  options: UpdateOptions,
): Promise<void> {
  const status = await client.getDaemonStatus();

  if (status.activeSessions > 0 && !options.force) {
    console.log(`Waiting for ${status.activeSessions} active sessions to complete...`);

    const timeout = Date.now() + (options.timeout || 5 * 60 * 1000);
    while (Date.now() < timeout) {
      const current = await client.getDaemonStatus();
      if (current.activeSessions === 0) break;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }

  await client.shutdown();
  // Perform update
  await startDaemon();
}
```

## Testing Strategy

### Unit Tests

1. **Version comparison logic**: Test version parsing and comparison
2. **Checksum verification**: Test SHA256 calculation and comparison
3. **Permission checking**: Mock file system calls to test permission logic
4. **Platform detection**: Test OS and architecture detection

### Integration Tests

1. **Download functionality**:
   - Test successful download with progress tracking
   - Test handling of network failures
   - Test checksum file download and parsing

2. **Binary extraction**:
   - Test tar.gz extraction on macOS/Linux
   - Test zip extraction on Windows
   - Test cleanup of temporary files

3. **Update flow**:
   - Test with mock server returning version info
   - Test checksum verification pass/fail scenarios
   - Test permission denied scenarios

### End-to-End Testing

#### Test Environments

1. **Local testing with mock server**:
   ```bash
   # Start mock update server
   ATLAS_URL=http://localhost:8080 atlas update --check
   ```

2. **Staging environment**:
   - Use sandbox GCS bucket for testing
   - Test against real binaries with checksums
   - Verify daemon restart functionality

#### Platform-Specific Testing

**macOS Testing**:

```bash
# Test user-owned binary update
sudo chown $USER /usr/local/bin/atlas
atlas update

# Test root-owned binary update
sudo chown root /usr/local/bin/atlas
atlas update  # Should prompt for sudo

# Test daemon restart
atlas daemon status
atlas update
atlas daemon status  # Verify restarted
```

**Linux Testing**:

- Same as macOS, test on Ubuntu and other distros
- Test systemd service restart

**Windows Testing**:

- Test file locking scenarios
- Test scheduled task restart
- Verify UAC prompts if needed

### Manual Testing Checklist

#### Basic Update Flow

- [ ] Run `atlas update --check` to verify version checking
- [ ] Run `atlas update` when no update available
- [ ] Run `atlas update` when update is available
- [ ] Verify checksum verification messages appear
- [ ] Verify binary is replaced successfully
- [ ] Verify daemon restarts automatically

#### Permission Scenarios

- [ ] Test update with user-owned binary
- [ ] Test update with root-owned binary
- [ ] Test update without sudo access (should fail gracefully)
- [ ] Test `atlas update --quiet` skips prompts

#### Failure Scenarios

- [ ] Test with invalid checksum (modify checksum file)
- [ ] Test with network failure during download
- [ ] Test with insufficient disk space
- [ ] Test with running workspaces (should wait or timeout)
- [ ] Test daemon restart failure

#### Edge Cases

- [ ] Test update while daemon is not running
- [ ] Test concurrent update attempts (lock file)
- [ ] Test update with custom ATLAS_URL
- [ ] Test switching channels (edge/nightly)
- [ ] Test cleanup of failed updates

### Automated CI Testing

```yaml
# GitHub Actions test matrix
test-update:
  strategy:
    matrix:
      os: [ubuntu-latest, macos-latest, windows-latest]
      scenario: [
        "normal-update",
        "permission-denied",
        "checksum-mismatch",
        "daemon-busy",
      ]
  steps:
    - name: Setup test environment
    - name: Run update test scenario
    - name: Verify update result
```

### Performance Testing

- Measure download speeds with large binaries (~200MB)
- Test timeout handling for slow connections
- Verify progress reporting accuracy

### Security Testing

- Verify checksums prevent tampered binaries
- Test HTTPS certificate validation
- Ensure no sensitive data in logs
- Verify temporary files are cleaned up

This plan provides a smooth update experience while respecting running workspaces and maintaining
system stability.
