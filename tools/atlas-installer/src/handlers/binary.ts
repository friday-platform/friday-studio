import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { safeExec } from "../utils/process";
import type { BinaryInstallResult } from "../types";
import { createLogger } from "../utils/logger";
import { isWindows, isMac } from "../utils/platform";

const logger = createLogger("BinaryHandler");

/**
 * Install Atlas Web Client on macOS
 */
async function installWebClient(): Promise<void> {
  try {
    const appSourcePath = path.join(
      process.resourcesPath || path.join(__dirname, "..", ".."),
      "app.asar.unpacked",
      "atlas-binary",
      "Atlas Web Client.app",
    );

    if (!fs.existsSync(appSourcePath)) {
      logger.warn(`Web client app not found at ${appSourcePath}, skipping installation`);
      return;
    }

    logger.info("Installing Atlas Web Client");

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
  } catch (err) {
    logger.error("Failed to install web client", err);
    // Don't fail the entire installation if web client fails
  }
}

// Platform-specific binary configuration
const BINARIES = {
  atlas: isWindows() ? "atlas.exe" : "atlas",
  diagnostics: isWindows() ? "atlas-diagnostics.exe" : "atlas-diagnostics",
};

/**
 * Copy bundled Atlas binaries to installation directory
 */
async function copyBundledBinaries(): Promise<BinaryInstallResult> {
  try {
    const binDir = path.join(os.homedir(), ".atlas", "bin");
    fs.mkdirSync(binDir, { recursive: true });

    const sourcePath = path.join(
      process.resourcesPath || path.join(__dirname, "..", ".."),
      "app.asar.unpacked",
      "atlas-binary",
    );

    let mainBinaryPath = "";

    // Install all binaries
    for (const [key, name] of Object.entries(BINARIES)) {
      const src = path.join(sourcePath, name);
      const dest = path.join(binDir, name);

      if (!fs.existsSync(src)) {
        throw new Error(`Binary ${name} not found at ${src}`);
      }

      logger.info(`Installing ${name}`);
      fs.copyFileSync(src, dest);

      if (!isWindows()) {
        fs.chmodSync(dest, 0o755);
      }

      if (key === "atlas") {
        mainBinaryPath = dest;
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

    // Install web client on macOS
    if (isMac()) {
      await installWebClient();
    }

    return { success: true, path: mainBinaryPath, message: "Binaries installed successfully" };
  } catch (err) {
    logger.error("Binary installation failed", err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Binary installation failed: ${message}`, path: undefined };
  }
}

/**
 * Create symlinks in /usr/local/bin with admin privileges
 */
async function createSystemSymlinks(binDir: string): Promise<void> {
  const symlinksNeeded = [];

  // Check which symlinks need updating
  for (const name of ["atlas", "atlas-diagnostics"]) {
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
  mode: "install" | "update",
): Promise<BinaryInstallResult> {
  logger.info(`Starting Atlas binary ${mode}...`);

  try {
    // Copy bundled binaries instead of downloading
    logger.info("Installing Atlas binaries from bundled resources...");
    const installResult = await copyBundledBinaries();
    if (!installResult.success || !installResult.path) {
      throw new Error(installResult.error || "Installation failed");
    }

    // Skip verification during installation to prevent UI blocking
    // The binary will be verified when actually used
    logger.info("Skipping immediate verification to prevent UI blocking...");

    const message =
      mode === "update"
        ? "Atlas has been updated successfully!"
        : "Atlas binary installed successfully!";

    return { success: true, path: installResult.path, message };
  } catch (err) {
    logger.error(`Binary ${mode} failed`, err);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: `Binary ${mode} failed: ${message}`, path: undefined };
  }
}
