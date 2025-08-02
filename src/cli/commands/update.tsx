import { logger } from "@atlas/logger";
import { getAtlasClient } from "@atlas/client";
import { ensureDir, exists } from "@std/fs";
import { join } from "@std/path";
import { getAtlasVersion } from "../../utils/version.ts";
import { checkForUpdate } from "../../utils/version-checker.ts";
import { errorOutput, infoOutput, successOutput, warningOutput } from "../utils/output.ts";
import { YargsInstance } from "../utils/yargs.ts";

interface UpdateOptions {
  check?: boolean;
  quiet?: boolean;
  force?: boolean;
  channel?: string;
}

interface UpdateResult {
  success: boolean;
  fromVersion: string;
  toVersion: string;
  error?: string;
}

export const command = "update";
export const desc = "Update Atlas to the latest version";

export const builder = (yargs: YargsInstance) => {
  return yargs
    .option("check", {
      alias: "c",
      describe: "Check for updates only",
      type: "boolean",
      default: false,
    })
    .option("quiet", {
      alias: "q",
      describe: "Non-interactive update (use defaults)",
      type: "boolean",
      default: false,
    })
    .option("force", {
      alias: "f",
      describe: "Force update even with active sessions",
      type: "boolean",
      default: false,
    })
    .option("channel", {
      describe: "Switch to a different channel (stable, edge, nightly)",
      type: "string",
      choices: ["stable", "edge", "nightly"],
    })
    .example("$0 update", "Update to the latest version")
    .example("$0 update --check", "Check for updates only")
    .example("$0 update --quiet", "Update without prompts")
    .example("$0 update --channel edge", "Switch to edge channel");
};

export const handler = async (options: UpdateOptions) => {
  const startTime = Date.now();
  const currentVersion = getAtlasVersion();

  try {
    // Determine channel
    const channel = options.channel || getCurrentChannel(currentVersion);

    // Check for updates
    if (!options.quiet) {
      infoOutput("Checking for updates...");
    }
    const updateInfo = await checkForUpdate(channel);

    if (!updateInfo.updateAvailable && !options.force) {
      successOutput("Atlas is up to date");
      infoOutput(`Current version: ${currentVersion}`);
      return;
    }

    // If check only, display and exit
    if (options.check) {
      warningOutput("Update available!");
      infoOutput(`Current version: ${currentVersion}`);
      infoOutput(`Latest version:  ${updateInfo.latestVersion}`);
      console.log("\nRun 'atlas update' to install");
      return;
    }

    // Display update information
    if (updateInfo.updateAvailable) {
      warningOutput("New version available!");
      infoOutput(`Current: ${currentVersion}`);
      infoOutput(`Latest:  ${updateInfo.latestVersion}`);
    } else if (options.force) {
      warningOutput("Force reinstalling current version");
      infoOutput(`Current version: ${currentVersion}`);
    }

    // Check for active sessions and daemon status
    const daemonStatus = await checkDaemonStatus();

    if (daemonStatus.running && daemonStatus.activeSessions > 0 && !options.force) {
      warningOutput(`Atlas daemon has ${daemonStatus.activeSessions} active session(s)`);
    }

    // Confirm update (unless quiet mode)
    if (!options.quiet) {
      const response = prompt("Continue with update [Y/n]?");
      const confirmed = response === null || response === "" || response.toLowerCase() === "y";

      if (!confirmed) {
        infoOutput("Update cancelled");
        return;
      }
    }

    // Ensure we have a download URL
    if (!updateInfo.downloadUrl) {
      errorOutput("Unable to get download URL for update");
      return;
    }

    // SAFETY CHECK: Ensure we're downloading the correct package type
    const isMacOS = Deno.build.os === "darwin";
    const isLinux = Deno.build.os === "linux";
    const isWindows = Deno.build.os === "windows";

    if ((isMacOS || isLinux) && !updateInfo.downloadUrl.endsWith(".tar.gz")) {
      errorOutput(
        `Invalid package type for ${isMacOS ? "macOS" : "Linux"}: ${updateInfo.downloadUrl}`,
      );
      errorOutput("Update process requires .tar.gz binary packages, not installer packages");
      return;
    }

    if (isWindows && !updateInfo.downloadUrl.endsWith(".zip")) {
      errorOutput(`Invalid package type for Windows: ${updateInfo.downloadUrl}`);
      errorOutput("Update process requires .zip binary packages, not .exe installers");
      return;
    }

    // Perform update
    const result = await performUpdate({
      currentVersion,
      targetVersion: updateInfo.latestVersion || currentVersion, // Use current version if forcing reinstall
      channel,
      quiet: options.quiet || false,
      force: options.force || false,
      downloadUrl: updateInfo.downloadUrl,
    });

    // Log update event
    const duration = Date.now() - startTime;
    logUpdateEvent({
      from_version: currentVersion,
      to_version: result.toVersion,
      timestamp: new Date(),
      success: result.success,
      error: result.error,
      duration_ms: duration,
    });

    if (result.success) {
      successOutput(`Atlas updated to ${result.toVersion}`);

      // If channel was switched, save preference
      if (options.channel && options.channel !== getCurrentChannel(currentVersion)) {
        await saveChannelPreference(options.channel);
        infoOutput(`Switched to ${options.channel} channel`);
      }
    } else {
      errorOutput(`Update failed: ${result.error}`);
      Deno.exit(1);
    }
  } catch (error) {
    errorOutput(`Update failed: ${error.message}`);
    Deno.exit(1);
  }
};

function getCurrentChannel(version: string): string {
  // Parse channel from version string
  if (version.includes("edge")) return "edge";
  if (version.includes("nightly")) return "nightly";
  return "stable";
}

async function checkDaemonStatus(): Promise<{ running: boolean; activeSessions: number }> {
  try {
    const client = await getAtlasClient();
    const isHealthy = await client.isHealthy();

    if (isHealthy) {
      const status = await client.getDaemonStatus();
      return {
        running: true,
        activeSessions: status.workspaceSessions || 0,
      };
    }
  } catch {
    // Daemon not running
  }

  return { running: false, activeSessions: 0 };
}

async function performUpdate(params: {
  currentVersion: string;
  targetVersion: string;
  channel: string;
  quiet: boolean;
  force: boolean;
  downloadUrl: string;
}): Promise<UpdateResult> {
  const { currentVersion, targetVersion, quiet, force, downloadUrl } = params;

  // Create update directory
  const updateDir = join(Deno.env.get("HOME") || "", ".atlas", "updates");

  try {
    // Check platform
    const platform = getPlatformInfo();

    // Check write permissions
    const permissionCheck = await checkBinaryWritePermission();

    if (!permissionCheck.canWrite) {
      throw new Error(
        `Cannot write to binary location: ${permissionCheck.binaryPath}\n` +
          `The file may be owned by another user or in a protected directory.\n` +
          `Current owner: ${permissionCheck.owner || "unknown"}`,
      );
    }

    // Handle Windows file locking
    if (platform.platform === "windows") {
      const isAtlasRunning = await checkIfAtlasIsRunning();
      if (isAtlasRunning) {
        throw new Error(
          "Atlas appears to be running on Windows.\n" +
            "Please close all Atlas processes before updating:\n" +
            "  1. Run 'atlas daemon stop' to stop the daemon\n" +
            "  2. Close any Atlas terminal windows\n" +
            "  3. Run 'atlas update' again",
        );
      }
    }

    // Ensure update directory exists
    await ensureDir(updateDir);

    // Download new binary
    const fileExtension = platform.platform === "windows" ? ".zip" : ".tar.gz";
    const downloadPath = join(
      updateDir,
      `atlas-${targetVersion}-${platform.platform}-${platform.arch}${fileExtension}`,
    );

    if (!quiet) {
      infoOutput("Downloading update...");
    }

    await downloadBinary({
      url: downloadUrl,
      destination: downloadPath,
      onProgress: quiet ? undefined : (bytes, total) => {
        const percent = Math.round((bytes / total) * 100);
        const mb = (bytes / 1024 / 1024).toFixed(1);
        const totalMb = (total / 1024 / 1024).toFixed(1);

        // Create progress bar
        const barLength = 40;
        const filledLength = Math.round((barLength * percent) / 100);
        const bar = "█".repeat(filledLength) + "░".repeat(barLength - filledLength);

        // Clear line and redraw progress bar
        Deno.stdout.writeSync(
          new TextEncoder().encode(`\r  ${bar} ${percent}% (${mb}/${totalMb} MB)`),
        );
      },
    });

    if (!quiet) {
      // Add newline after progress bar
      console.log();
      successOutput("Download complete");
    }

    // Verify checksum
    if (!quiet) {
      infoOutput("Verifying checksum...");
    }

    const checksumValid = await downloadAndVerifyChecksum(downloadUrl, downloadPath);
    if (!checksumValid) {
      throw new Error("Checksum verification failed");
    }

    if (!quiet) {
      successOutput("Checksum verified");
    }

    // Extract binary
    const extractedBinaryPath = await extractBinary(downloadPath, platform.platform);

    // Test new binary
    if (!quiet) {
      infoOutput("Testing new binary...");
    }

    const testResult = await testNewBinary(extractedBinaryPath);
    if (!testResult.success) {
      throw new Error(`New binary test failed: ${testResult.error}`);
    }

    if (!quiet) {
      successOutput("Binary test passed");
    }

    // Check for all running atlas processes (service-managed and manually started)
    const daemonStatus = await checkDaemonStatus();
    const anyAtlasRunning = await checkAnyAtlasProcesses();

    // Stop all atlas processes
    if (anyAtlasRunning || daemonStatus.running) {
      if (!quiet) {
        infoOutput("Stopping all Atlas processes...");
      }

      if (daemonStatus.activeSessions > 0 && !force) {
        // Wait for sessions to complete (with timeout)
        const timeout = 5 * 60 * 1000; // 5 minutes
        const startWait = Date.now();

        while (Date.now() - startWait < timeout) {
          const current = await checkDaemonStatus();
          if (!current.running || current.activeSessions === 0) break;

          if (!quiet) {
            infoOutput(`Waiting for ${current.activeSessions} session(s) to complete...`);
          }

          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
      }

      // Stop service-managed daemon first
      if (daemonStatus.running) {
        const stopCmd = new Deno.Command("atlas", {
          args: ["service", "stop"],
        });
        await stopCmd.output();
      }

      // Kill any remaining atlas processes (manually started daemons)
      await killAllAtlasProcesses(platform.platform, quiet);

      // Wait a moment for processes to fully terminate
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    // CRITICAL: The binary has already been tested in the temp directory
    // The testNewBinary function already verified it works
    // Now we just need to replace the old binary

    // Now we can safely replace the binary
    if (!quiet) {
      infoOutput("Installing update...");
    }

    // If we're running from the binary that's being updated, we need to handle this specially
    const currentBinaryPath = await getCurrentBinaryPath();
    const isUpdatingSelf = currentBinaryPath === permissionCheck.binaryPath;

    await replaceBinary(extractedBinaryPath, permissionCheck);

    if (!quiet) {
      successOutput("Update installed");
    }

    // Remove quarantine attribute on macOS to prevent SIGKILL
    if (Deno.build.os === "darwin") {
      try {
        const xattrCmd = new Deno.Command("xattr", {
          args: ["-d", "com.apple.quarantine", permissionCheck.binaryPath],
        });
        await xattrCmd.output();
      } catch {
        // xattr might fail if the attribute doesn't exist, which is fine
      }
    }

    // Post-installation verification - skip when self-updating on macOS
    // When the binary updates itself, macOS applies security attributes that cause
    // the first run to fail, but subsequent runs work fine
    if (!isUpdatingSelf || Deno.build.os !== "darwin") {
      if (!quiet) {
        infoOutput("Verifying installation...");
      }

      const postInstallTest = await testInstalledBinary(permissionCheck.binaryPath);
      if (!postInstallTest.success) {
        warningOutput("Post-installation verification had issues");
        warningOutput(`The binary may require manual verification: ${postInstallTest.error}`);
      } else if (!quiet) {
        successOutput("Installation verified");
      }
    }

    // Always start the service after update
    if (!quiet) {
      infoOutput("Starting Atlas service...");
    }

    // Try to start the service - use direct launchctl on macOS for better reliability
    let serviceStarted = false;

    try {
      if (platform.platform === "macos") {
        // On macOS, use launchctl directly for more reliable start after binary update
        const startCmd = new Deno.Command("launchctl", {
          args: ["start", "com.tempestdx.atlas"],
        });
        const startResult = await startCmd.output();

        // launchctl start returns 0 even if service is already running
        serviceStarted = true;

        // Give it a moment to start
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        // For other platforms, use the regular service start
        const startCmd = new Deno.Command("atlas", {
          args: ["service", "start"],
        });
        const startResult = await startCmd.output();
        serviceStarted = startResult.success;
      }
    } catch (error) {
      // If direct start fails, fall back to atlas service start
      try {
        const startCmd = new Deno.Command("atlas", {
          args: ["service", "start"],
        });
        const startResult = await startCmd.output();
        serviceStarted = startResult.success;
      } catch {
        serviceStarted = false;
      }
    }

    if (!serviceStarted) {
      warningOutput("Failed to start Atlas service automatically");
      infoOutput("Please run 'atlas service start' manually");
    } else {
      if (!quiet) {
        successOutput("Atlas service start command issued");

        // Check service status multiple times with shorter intervals
        let serviceRunning = false;
        const maxChecks = 10; // Check up to 10 times
        const checkInterval = 500; // 500ms between checks (total 5 seconds max)

        for (let i = 0; i < maxChecks; i++) {
          await new Promise((resolve) => setTimeout(resolve, checkInterval));

          try {
            const statusCmd = new Deno.Command("atlas", {
              args: ["service", "status"],
            });
            const statusResult = await statusCmd.output();

            if (statusResult.success) {
              const statusOutput = new TextDecoder().decode(statusResult.stdout);
              if (statusOutput.includes("Service is running")) {
                successOutput("Atlas service is now running");
                serviceRunning = true;
                break;
              }
            }
          } catch {
            // Ignore status check errors and continue checking
          }
        }

        if (!serviceRunning) {
          infoOutput("Service is still starting. Check status with 'atlas service status'");
        }
      }
    }

    return {
      success: true,
      fromVersion: currentVersion,
      toVersion: targetVersion,
    };
  } catch (error) {
    return {
      success: false,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      error: error.message,
    };
  } finally {
    // Always cleanup update directory, even on error
    try {
      await Deno.remove(updateDir, { recursive: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

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

async function getCurrentBinaryPath(): Promise<string | null> {
  try {
    // Check if we're running from a compiled binary
    const execPath = Deno.execPath();
    if (execPath.includes("deno")) {
      // Running from source with Deno
      return null;
    }
    return execPath;
  } catch {
    return null;
  }
}

async function checkBinaryWritePermission(): Promise<{
  canWrite: boolean;
  binaryPath: string;
  owner?: string;
}> {
  // Find current binary location using platform-specific command
  const findCmd = Deno.build.os === "windows" ? "where" : "which";
  const result = await new Deno.Command(findCmd, {
    args: ["atlas"],
  }).output();

  if (!result.success) {
    throw new Error("Atlas binary not found in PATH");
  }

  const output = new TextDecoder().decode(result.stdout).trim();
  // On Windows, 'where' might return multiple paths, take the first one
  const binaryPath = output.split(/\r?\n/)[0];

  // Try to write to a test file next to the binary
  const testPath = `${binaryPath}.update-test`;
  try {
    await Deno.writeTextFile(testPath, "test");
    await Deno.remove(testPath);
    return { canWrite: true, binaryPath };
  } catch {
    // Can't write to directory, check if we can overwrite the file itself
    try {
      // Check file ownership
      const statCmd = Deno.build.os === "darwin"
        ? ["stat", "-f", "%Su", binaryPath]
        : Deno.build.os === "windows"
        ? null
        : ["stat", "-c", "%U", binaryPath];

      let owner: string | undefined;
      if (statCmd) {
        const ownerResult = await new Deno.Command(statCmd[0], {
          args: statCmd.slice(1),
        }).output();
        owner = new TextDecoder().decode(ownerResult.stdout).trim();
      }

      const currentUser = Deno.env.get("USER") || Deno.env.get("USERNAME");

      if (owner === currentUser) {
        // We own the file, we should be able to replace it
        return { canWrite: true, binaryPath, owner };
      }

      return { canWrite: false, binaryPath, owner };
    } catch {
      return { canWrite: false, binaryPath };
    }
  }
}

async function checkIfAtlasIsRunning(): Promise<boolean> {
  if (Deno.build.os !== "windows") return false;

  try {
    // Get current process PID
    const currentPid = Deno.pid;

    // Get all atlas.exe processes
    const result = await new Deno.Command("tasklist", {
      args: ["/FI", "IMAGENAME eq atlas.exe", "/FO", "CSV"],
    }).output();

    const output = new TextDecoder().decode(result.stdout);
    const lines = output.split("\n");

    // Parse CSV output to check PIDs
    let otherAtlasProcesses = false;
    for (const line of lines) {
      if (line.includes("atlas.exe") && !line.includes("Image Name")) {
        // Parse CSV line: "Image Name","PID","Session Name","Session#","Mem Usage"
        const parts = line.split(",");
        if (parts.length >= 2) {
          const pid = parts[1].replace(/"/g, "").trim();
          if (pid && pid !== currentPid.toString()) {
            otherAtlasProcesses = true;
            break;
          }
        }
      }
    }

    return otherAtlasProcesses;
  } catch {
    return false;
  }
}

async function downloadBinary(options: {
  url: string;
  destination: string;
  onProgress?: (bytes: number, total: number) => void;
}): Promise<void> {
  const response = await fetch(options.url, {
    redirect: "follow",
  });

  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  // Check if we got HTML instead of binary (login page, error page, etc)
  const contentType = response.headers.get("content-type");
  if (contentType?.includes("text/html")) {
    throw new Error(
      "Binary download failed: Server returned HTML instead of binary file.\n" +
        "This usually means authentication is required or the file is not publicly accessible.\n" +
        "Please contact the Atlas team to resolve this server configuration issue.",
    );
  }

  const contentLength = Number(response.headers.get("content-length")) || 0;

  const reader = response.body?.getReader();
  if (!reader) throw new Error("No response body");

  const writer = await Deno.open(options.destination, {
    write: true,
    create: true,
  });

  let receivedBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    await writer.write(value);
    receivedBytes += value.length;

    if (options.onProgress) {
      options.onProgress(receivedBytes, contentLength);
    }
  }

  writer.close();
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
    warningOutput(`Checksum file not available (${checksumResponse.status})`);
    warningOutput("Proceeding without checksum verification - use at your own risk");
    return true; // Skip verification if checksum not available
  }

  const checksumContent = await checksumResponse.text();

  // Check if we got HTML instead of a checksum (404 page, login redirect, etc)
  if (checksumContent.trim().startsWith("<") || checksumContent.includes("doctype")) {
    warningOutput("Checksum file returned HTML content (likely not found)");
    warningOutput("Proceeding without checksum verification - use at your own risk");
    return true;
  }

  await Deno.writeTextFile(checksumPath, checksumContent);

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
    errorOutput("Checksum mismatch!");
    infoOutput(`Expected: ${expectedHash}`);
    infoOutput(`Actual:   ${actualHash}`);
    return false;
  }

  // Cleanup checksum file
  await Deno.remove(checksumPath);

  return true;
}

async function extractBinary(archivePath: string, platform: string): Promise<string> {
  const tempDir = await Deno.makeTempDir();

  if (platform === "windows") {
    // Extract from zip using PowerShell on Windows
    const psCmd = new Deno.Command("powershell", {
      args: [
        "-NoProfile",
        "-Command",
        `Expand-Archive -Path '${archivePath}' -DestinationPath '${tempDir}' -Force`,
      ],
    });
    const result = await psCmd.output();
    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to extract zip file: ${stderr}`);
    }
    const binaryPath = join(tempDir, "atlas.exe");

    // Verify the binary exists
    if (!await exists(binaryPath)) {
      throw new Error(
        `Binary not found at expected location: ${binaryPath}. The package may be an installer instead of a binary-only package.`,
      );
    }

    return binaryPath;
  } else {
    // Extract from tar.gz (macOS and Linux)
    const tarCmd = new Deno.Command("tar", {
      args: ["-xzf", archivePath, "-C", tempDir],
    });
    const result = await tarCmd.output();
    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      throw new Error(`Failed to extract tar.gz file: ${stderr}`);
    }
    const binaryPath = join(tempDir, "atlas");

    // Verify the binary exists
    if (!await exists(binaryPath)) {
      // Check if this is an installer package by mistake
      const installerPath = join(tempDir, "Atlas Installer.app");
      if (await exists(installerPath)) {
        throw new Error(
          `Downloaded installer package instead of binary-only package. ` +
            `The update system requires the CLI binary package (.tar.gz), not the installer package (.zip). ` +
            `This is a server configuration issue.`,
        );
      }
      throw new Error(
        `Binary not found at expected location: ${binaryPath}. The package structure may be incorrect.`,
      );
    }

    return binaryPath;
  }
}

async function testNewBinary(binaryPath: string): Promise<{ success: boolean; error?: string }> {
  try {
    // Make binary executable
    if (Deno.build.os !== "windows") {
      await Deno.chmod(binaryPath, 0o755);
    }

    // Test binary execution
    const cmd = new Deno.Command(binaryPath, {
      args: ["--version"],
    });

    const result = await cmd.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);
      return { success: false, error: stderr || "Binary test failed" };
    }

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function testInstalledBinary(
  binaryPath: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    // Test binary execution from its installed location
    const cmd = new Deno.Command(binaryPath, {
      args: ["--version"],
      stdout: "piped",
      stderr: "piped",
    });

    const result = await cmd.output();

    if (!result.success) {
      const stderr = new TextDecoder().decode(result.stderr);

      // Check for specific macOS code signing error
      if (result.code === -9 || result.signal === "SIGKILL") {
        return {
          success: false,
          error:
            "Binary killed by macOS (SIGKILL). This usually indicates code signing or security policy issues.",
        };
      }

      return {
        success: false,
        error: stderr || `Binary test failed with exit code ${result.code}`,
      };
    }

    // Also verify the output looks reasonable
    const stdout = new TextDecoder().decode(result.stdout);
    if (!stdout.includes("Atlas")) {
      return { success: false, error: "Binary output does not look like Atlas CLI" };
    }

    return { success: true };
  } catch (error) {
    // Handle cases where the binary is killed before it can even start
    if (error.message.includes("killed") || error.message.includes("SIGKILL")) {
      return {
        success: false,
        error: "Binary killed by system. This indicates code signing or security policy issues.",
      };
    }
    return { success: false, error: error.message };
  }
}

async function replaceBinary(
  newBinaryPath: string,
  permissionCheck: { canWrite: boolean; binaryPath: string; owner?: string },
): Promise<void> {
  const { binaryPath } = permissionCheck;

  if (Deno.build.os === "darwin") {
    // On macOS, use 'ditto' to preserve code signatures and all metadata
    // This prevents issues with com.apple.provenance and code signature validation
    const dittoCmd = new Deno.Command("ditto", {
      args: [newBinaryPath, binaryPath],
    });
    const result = await dittoCmd.output();

    if (!result.success) {
      // Fall back to mv if ditto fails
      // First remove the old binary
      await Deno.remove(binaryPath);
      // Then move the new one in place
      await Deno.rename(newBinaryPath, binaryPath);
    }
  } else {
    // For other platforms, use standard copy
    await Deno.copyFile(newBinaryPath, binaryPath);
  }

  // Ensure binary is executable
  if (Deno.build.os !== "windows") {
    await Deno.chmod(binaryPath, 0o755);
  }
}

function logUpdateEvent(event: {
  from_version: string;
  to_version: string;
  timestamp: Date;
  success: boolean;
  error?: string;
  duration_ms: number;
}): void {
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

async function saveChannelPreference(channel: string): Promise<void> {
  const configPath = join(Deno.env.get("HOME") || "", ".atlas", "config.json");

  let config: Record<string, unknown> = {};

  // Read existing config if it exists
  try {
    const content = await Deno.readTextFile(configPath);
    config = JSON.parse(content);
  } catch {
    // Config doesn't exist yet
  }

  // Update channel preference
  config.updateChannel = channel;

  // Write config
  await ensureDir(join(Deno.env.get("HOME") || "", ".atlas"));
  await Deno.writeTextFile(configPath, JSON.stringify(config, null, 2));
}

async function checkAnyAtlasProcesses(): Promise<boolean> {
  // Check if any atlas daemon processes are running (beyond what checkDaemonStatus found)
  // This catches manually started instances that might be on custom ports or not responding

  if (Deno.build.os !== "windows") {
    try {
      // First try pgrep for atlas daemon processes
      const result = await new Deno.Command("pgrep", {
        args: ["-f", "atlas.*daemon.*start"],
      }).output();

      if (result.success && result.stdout.length > 0) {
        return true;
      }
    } catch {
      // pgrep not available, fall back to ps
      try {
        const result = await new Deno.Command("ps", {
          args: ["aux"],
        }).output();
        const output = new TextDecoder().decode(result.stdout);
        return output.includes("atlas") && output.includes("daemon") && output.includes("start");
      } catch {
        // Unable to check processes
      }
    }
  } else {
    // Windows: check for atlas.exe processes (excluding current process)
    try {
      const currentPid = Deno.pid;
      const result = await new Deno.Command("tasklist", {
        args: ["/FI", "IMAGENAME eq atlas.exe", "/FO", "CSV"],
      }).output();
      const output = new TextDecoder().decode(result.stdout);
      const lines = output.split("\n");

      // Check if there are any OTHER atlas.exe processes
      for (const line of lines) {
        if (line.includes("atlas.exe") && !line.includes("Image Name")) {
          const parts = line.split(",");
          if (parts.length >= 2) {
            const pid = parts[1].replace(/"/g, "").trim();
            if (pid && pid !== currentPid.toString()) {
              return true; // Found another atlas.exe process
            }
          }
        }
      }
      return false;
    } catch {
      // Unable to check processes
      return false;
    }
  }

  return false;
}

async function killAllAtlasProcesses(platform: string, quiet: boolean): Promise<void> {
  if (platform === "windows") {
    // On Windows, use taskkill
    try {
      const result = await new Deno.Command("taskkill", {
        args: ["/F", "/IM", "atlas.exe"],
      }).output();
      if (!result.success && !quiet) {
        const stderr = new TextDecoder().decode(result.stderr);
        if (!stderr.includes("not found")) {
          warningOutput(`Failed to kill atlas processes: ${stderr}`);
        }
      }
    } catch {
      // taskkill not available or failed
    }
  } else {
    // On Unix-like systems, use pkill or kill
    try {
      // First try pkill
      const pkillResult = await new Deno.Command("pkill", {
        args: ["-f", "atlas.*daemon.*start"],
      }).output();

      // Also try to kill any deno processes running atlas
      await new Deno.Command("pkill", {
        args: ["-f", "deno.*atlas.*daemon.*start"],
      }).output();

      if (!pkillResult.success && !quiet) {
        // pkill exit code 1 means no processes found, which is OK
        const exitCode = pkillResult.code;
        if (exitCode !== 1) {
          warningOutput(`pkill returned exit code ${exitCode}`);
        }
      }
    } catch {
      // pkill not available, try using ps and kill
      try {
        const psResult = await new Deno.Command("ps", {
          args: ["aux"],
        }).output();

        const output = new TextDecoder().decode(psResult.stdout);
        const lines = output.split("\n");

        for (const line of lines) {
          if (line.includes("atlas") && line.includes("daemon") && line.includes("start")) {
            const parts = line.trim().split(/\s+/);
            const pid = parts[1];
            if (pid && /^\d+$/.test(pid)) {
              try {
                await new Deno.Command("kill", {
                  args: ["-9", pid],
                }).output();
              } catch {
                // Failed to kill this process, continue with others
              }
            }
          }
        }
      } catch {
        if (!quiet) {
          warningOutput("Unable to kill atlas processes automatically");
        }
      }
    }
  }
}
