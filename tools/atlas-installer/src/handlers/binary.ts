import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IPCResult } from "../types";
import { createLogger } from "../utils/logger";
import { isMac, isWindows } from "../utils/platform";
import { safeExec } from "../utils/process";

const logger = createLogger("BinaryHandler");

/**
 * Stop running daemon before binary replacement
 */
async function stopExistingDaemon(): Promise<void> {
  try {
    logger.info("Stopping Atlas service and daemon...");

    // Try to stop using the atlas SERVICE command which properly handles scheduler
    // This will stop both the service (launchctl/schtasks) AND the daemon
    const atlasCommand = isWindows() ? "atlas.exe" : "atlas";

    try {
      // First attempt: use atlas CLI if it's in PATH
      await safeExec(`${atlasCommand} service stop`, { timeout: 10000 });
      logger.info("Successfully stopped Atlas service");
    } catch {
      // Not in PATH or not running, try using known binary location
      const binaryPath = path.join(os.homedir(), ".atlas", "bin", atlasCommand);
      if (fs.existsSync(binaryPath)) {
        try {
          await safeExec(`"${binaryPath}" service stop`, { timeout: 10000 });
          logger.info("Successfully stopped Atlas service using direct path");
        } catch {
          logger.info("Service not running or failed to stop gracefully");
        }
      }
    }

    // Platform-specific force cleanup as safety measure
    // This handles any processes that might not have been managed by the service
    if (isWindows()) {
      try {
        await safeExec("taskkill /F /IM atlas.exe");
        logger.info("Force terminated any remaining atlas.exe processes");
      } catch {
        // Process might not be running, continue
      }
    } else {
      try {
        // CRITICAL: Use exact match to avoid killing atlas-installer itself!
        // Only kill the atlas daemon process, not anything with "atlas" in the name
        await safeExec("pkill -x atlas");
        logger.info("Force terminated any remaining atlas processes");
      } catch {
        // Process might not be running, continue
      }
    }

    // Wait for processes to fully terminate
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch (err) {
    logger.error("Error during service/daemon shutdown", err);
    // Continue with installation even if stop fails
  }
}

/**
 * Install Atlas Web Client
 */
async function installWebClient(): Promise<void> {
  try {
    // Determine the source path - check production path first, then fall back to development
    let basePath = path.join(process.resourcesPath || "", "app.asar.unpacked", "atlas-binary");

    // If production path doesn't exist, try development path
    if (!fs.existsSync(basePath)) {
      const devPath = path.join(__dirname, "..", "..", "atlas-binary");
      if (fs.existsSync(devPath)) {
        basePath = devPath;
      }
    }

    if (isMac()) {
      // macOS: Install .app bundle to Applications
      const appSourcePath = path.join(basePath, "Atlas Web Client.app");

      if (!fs.existsSync(appSourcePath)) {
        logger.warn(`Web client app not found at ${appSourcePath}, skipping installation`);
        return;
      }

      logger.info("Installing Atlas Web Client for macOS");

      // Copy app to user's Applications folder
      const userAppsDir = path.join(os.homedir(), "Applications");

      // Create user Applications directory if it doesn't exist
      if (!fs.existsSync(userAppsDir)) {
        fs.mkdirSync(userAppsDir, { recursive: true });
      }

      const destPath = path.join(userAppsDir, "Atlas Web Client.app");

      logger.info(`Copying web client from ${appSourcePath} to ${destPath}`);

      // Remove existing app if present
      if (fs.existsSync(destPath)) {
        await safeExec(`rm -rf "${destPath}"`);
      }

      // Copy new app
      await safeExec(`cp -R "${appSourcePath}" "${destPath}"`);
      logger.info("Atlas Web Client installed successfully");
    } else if (isWindows()) {
      // Windows: Run the NSIS installer for Atlas Web Client
      const installerPath = path.join(basePath, "Atlas Web Client.exe");

      if (!fs.existsSync(installerPath)) {
        logger.warn(`Web client installer not found at ${installerPath}, skipping installation`);
        return;
      }

      logger.info("Installing Atlas Web Client for Windows");

      // Run the NSIS installer silently
      // /S = silent install, /D = installation directory
      const installDir = path.join(
        process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        "Programs",
        "Atlas Web Client",
      );

      logger.info(`Running Atlas Web Client installer silently to ${installDir}`);

      try {
        // Run installer with silent flag
        await safeExec(`"${installerPath}" /S /D="${installDir}"`, { timeout: 60000 });
        logger.info("Atlas Web Client installer completed");
      } catch (err) {
        logger.warn(`Atlas Web Client installer failed, trying without silent mode: ${err}`);
        // If silent install fails, just copy the installer for manual installation
        const fallbackDir = path.join(
          process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
          "Atlas Web Client",
        );
        if (!fs.existsSync(fallbackDir)) {
          fs.mkdirSync(fallbackDir, { recursive: true });
        }
        const fallbackPath = path.join(fallbackDir, "Atlas Web Client Installer.exe");
        fs.copyFileSync(installerPath, fallbackPath);
        logger.info(`Installer copied to ${fallbackPath} for manual installation`);
      }

      // Create Start Menu shortcut pointing to the installed app
      try {
        const startMenuDir = path.join(
          process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
          "Microsoft",
          "Windows",
          "Start Menu",
          "Programs",
        );

        // Point to the installed app location
        const installedAppPath = path.join(installDir, "Atlas Web Client.exe");
        const shortcutPath = path.join(startMenuDir, "Atlas Web Client.lnk");
        const psCommand = `
          $WshShell = New-Object -comObject WScript.Shell
          $Shortcut = $WshShell.CreateShortcut("${shortcutPath}")
          $Shortcut.TargetPath = "${installedAppPath}"
          $Shortcut.WorkingDirectory = "${installDir}"
          $Shortcut.IconLocation = "${installedAppPath}, 0"
          $Shortcut.Save()
        `.replace(/\n/g, "; ");

        await safeExec(`powershell -Command "${psCommand}"`);
        logger.info("Created Start Menu shortcut");
      } catch (err) {
        logger.warn(`Failed to create Start Menu shortcut: ${err}`);
        // Don't fail the installation if shortcut creation fails
      }

      logger.info("Atlas Web Client installed successfully");
    }
  } catch (err) {
    logger.error("Failed to install web client", err);
    // Don't fail the entire installation if web client fails
  }
}

// Platform-specific binary configuration
const BINARIES = { atlas: isWindows() ? "atlas.exe" : "atlas" };

/**
 * Copy bundled Atlas binaries to installation directory
 */
async function copyBundledBinaries(): Promise<IPCResult> {
  try {
    // CRITICAL: Stop daemon BEFORE replacing binaries to prevent killed process
    logger.info("Stopping existing Atlas daemon before binary replacement...");
    await stopExistingDaemon();

    const binDir = path.join(os.homedir(), ".atlas", "bin");
    fs.mkdirSync(binDir, { recursive: true });

    // Determine the source path - check production path first, then fall back to development
    let sourcePath = path.join(process.resourcesPath || "", "app.asar.unpacked", "atlas-binary");

    // If production path doesn't exist, try development path
    if (!fs.existsSync(sourcePath)) {
      const devPath = path.join(__dirname, "..", "..", "atlas-binary");
      if (fs.existsSync(devPath)) {
        sourcePath = devPath;
        logger.info("Using development binary path");
      }
    }

    logger.info(`Looking for binaries in: ${sourcePath}`);

    // Install all binaries
    for (const [, name] of Object.entries(BINARIES)) {
      const src = path.join(sourcePath, name);
      const dest = path.join(binDir, name);

      if (!fs.existsSync(src)) {
        logger.error(`Binary ${name} not found at ${src}`);
        return { success: false, error: `Binary ${name} not found at ${src}` };
      }

      logger.info(`Installing ${name}`);
      fs.copyFileSync(src, dest);

      if (!isWindows()) {
        fs.chmodSync(dest, 0o755);
      }
    }

    // Create symlinks in /usr/local/bin on macOS
    // MUST AWAIT for admin password prompt!
    if (isMac()) {
      try {
        await createSystemSymlinks(binDir);
        logger.info("System symlinks created successfully");
      } catch (err) {
        logger.warn(`Symlink creation failed but installation continues: ${err}`);
      }
    }

    // Install web client
    await installWebClient();

    return { success: true, message: "Binaries installed successfully" };
  } catch (err) {
    logger.error("Binary installation failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Binary installation failed: ${message}` };
  }
}

/**
 * Create symlinks in /usr/local/bin with admin privileges
 */
async function createSystemSymlinks(binDir: string): Promise<void> {
  const symlinksNeeded = [];

  // Check which symlinks need updating
  for (const name of ["atlas"]) {
    const userPath = path.join(binDir, name);
    const systemPath = `/usr/local/bin/${name}`;

    try {
      const current = fs.readlinkSync(systemPath);
      if (path.resolve("/usr/local/bin", current) === path.resolve(userPath)) {
        continue; // Already correct
      }
    } catch {
      // Not a symlink or doesn't exist
    }

    symlinksNeeded.push({ name, userPath, systemPath });
  }

  if (symlinksNeeded.length === 0) {
    logger.info("Symlinks already configured");
    return;
  }

  // Ensure /usr/local/bin exists
  if (!fs.existsSync("/usr/local/bin")) {
    await safeExec(
      `osascript -e 'do shell script "mkdir -p /usr/local/bin" with administrator privileges'`,
    );
  }

  // Create symlinks
  for (const { name, userPath, systemPath } of symlinksNeeded) {
    try {
      const cmd = `rm -f ${systemPath} && ln -sf ${userPath} ${systemPath}`;
      await safeExec(`osascript -e 'do shell script "${cmd}" with administrator privileges'`);
      logger.info(`Created symlink for ${name}`);
    } catch (err) {
      logger.warn(`Could not create symlink for ${name}: ${err}`);
    }
  }
}

/**
 * Main binary installation handler
 */
export async function installAtlasBinaryHandler(
  _event: unknown,
  mode?: "install" | "update",
): Promise<IPCResult> {
  const installMode = mode || "install";
  logger.info(`Starting Atlas binary ${installMode}...`);

  try {
    // Copy bundled binaries instead of downloading
    logger.info("Installing Atlas binaries from bundled resources...");
    const installResult = await copyBundledBinaries();
    if (!installResult.success) {
      logger.error("Binary installation failed:", installResult.error);
      return installResult;
    }

    // Skip verification during installation to prevent UI blocking
    // The binary will be verified when actually used
    logger.info("Skipping immediate verification to prevent UI blocking...");

    const message =
      installMode === "update"
        ? "Atlas has been updated successfully!"
        : "Atlas binary installed successfully!";

    return { success: true, message };
  } catch (err) {
    logger.error(`Binary ${installMode} failed`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Binary ${installMode} failed: ${message}` };
  }
}
