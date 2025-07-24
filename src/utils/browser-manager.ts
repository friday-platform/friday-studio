import { ensureDir, exists } from "@std/fs";
import { join } from "@std/path";
import { AtlasLogger } from "./logger.ts";

// Playwright browser download URLs and metadata
const BROWSER_NAME = "chromium";
const BROWSER_REVISION = "1181"; // Revision used by Playwright 1.54.1

function getBrowserDownloadUrl(): string {
  const platform = Deno.build.os;
  const baseUrl = "https://playwright.azureedge.net/builds/chromium";

  switch (platform) {
    case "darwin":
      return `${baseUrl}/${BROWSER_REVISION}/chromium-mac.zip`;
    case "linux":
      return `${baseUrl}/${BROWSER_REVISION}/chromium-linux.zip`;
    case "windows":
      return `${baseUrl}/${BROWSER_REVISION}/chromium-win64.zip`;
    default:
      throw new Error(`Unsupported platform: ${platform}`);
  }
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download: ${response.status} ${response.statusText}`);
  }

  const buffer = await response.arrayBuffer();
  await Deno.writeFile(destPath, new Uint8Array(buffer));
}

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  // Use native unzip command available on all platforms
  const platform = Deno.build.os;
  let command: string[];

  if (platform === "windows") {
    // Use PowerShell's Expand-Archive on Windows
    command = [
      "powershell",
      "-Command",
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${destDir}" -Force`,
    ];
  } else {
    // Use unzip on macOS and Linux
    command = ["unzip", "-q", "-o", zipPath, "-d", destDir];
  }

  const process = new Deno.Command(command[0], {
    args: command.slice(1),
  });

  const { success, stderr } = await process.output();
  if (!success) {
    throw new Error(`Failed to extract zip: ${new TextDecoder().decode(stderr)}`);
  }
}

export async function checkAndDownloadBrowsers() {
  const atlasHome = join(Deno.env.get("HOME")!, ".atlas");
  const browsersPath = join(atlasHome, "browsers");
  const browserDir = join(browsersPath, `${BROWSER_NAME}-${BROWSER_REVISION}`);
  const logger = AtlasLogger.getInstance();

  // Check if browser already exists
  if (await exists(browserDir)) {
    return;
  }

  logger.info("Playwright browser not found. Downloading Chromium...");

  try {
    // Ensure the browsers directory exists
    await ensureDir(browsersPath);

    // Download the browser
    const downloadUrl = getBrowserDownloadUrl();
    const zipPath = join(browsersPath, `${BROWSER_NAME}-${BROWSER_REVISION}.zip`);

    logger.info(`Downloading from ${downloadUrl}...`);
    await downloadFile(downloadUrl, zipPath);

    // Extract the browser
    logger.info("Extracting browser...");
    await extractZip(zipPath, browserDir);

    // Clean up the zip file
    await Deno.remove(zipPath);

    // Make the binaries executable on Unix-like systems
    if (Deno.build.os !== "windows") {
      const platform = Deno.build.os;
      const basePath = join(browserDir, platform === "darwin" ? "chrome-mac" : "chrome-linux");

      // Make headless_shell executable
      const headlessPath = join(basePath, "headless_shell");
      if (await exists(headlessPath)) {
        await Deno.chmod(headlessPath, 0o755);
      }

      // Also make the main Chromium executable if on macOS
      if (platform === "darwin") {
        const chromiumPath = join(basePath, "Chromium.app", "Contents", "MacOS", "Chromium");
        if (await exists(chromiumPath)) {
          await Deno.chmod(chromiumPath, 0o755);
        }
      } else {
        // Make chrome executable on Linux
        const chromePath = join(basePath, "chrome");
        if (await exists(chromePath)) {
          await Deno.chmod(chromePath, 0o755);
        }
      }
    }

    logger.info("Playwright browser downloaded successfully.");
  } catch (error) {
    logger.error("Failed to download Playwright browser", { error: error.message });
    // Don't throw - Atlas should still work without browser support
  }
}
