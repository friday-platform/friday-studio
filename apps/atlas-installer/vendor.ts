#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run

/**
 * Vendor dependencies for the installer frontend.
 * This replaces the pnpm-based vendoring approach.
 *
 * Downloads packages directly from npm registry and extracts them.
 */

import { mkdtempSync } from "node:fs";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

const TAURI_API_VERSION = "2.8.0";
const TYPES_NODE_VERSION = "24.7.0";
const VENDOR_DIR = "./dist-tauri/vendor/@tauri-apps";
const TYPES_DIR = "./node_modules/@types";
const NPM_REGISTRY = "https://registry.npmjs.org";

/**
 * Convert Windows path to Unix-style path that tar can understand
 * Example: C:\Users\foo -> /c/Users/foo
 */
function toUnixPath(path: string): string {
  if (process.platform === "win32") {
    // Convert backslashes to forward slashes
    let unixPath = path.replace(/\\/g, "/");
    // Convert drive letter (C: -> /c)
    if (unixPath.match(/^[A-Za-z]:/)) {
      unixPath = `/${unixPath[0].toLowerCase()}${unixPath.slice(2)}`;
    }
    return unixPath;
  }
  return path;
}

async function downloadAndExtractPackage(
  packageName: string,
  version: string,
  targetDir: string,
): Promise<void> {
  console.log(`Downloading ${packageName}@${version}...`);

  // Get package metadata from npm registry
  const packageUrl = `${NPM_REGISTRY}/${packageName}/${version}`;
  console.log(`Fetching package metadata from: ${packageUrl}`);

  const metadataResponse = await fetch(packageUrl);
  if (!metadataResponse.ok) {
    console.error(`Failed to fetch package metadata: ${metadataResponse.statusText}`);
    process.exit(1);
  }

  const metadata = await metadataResponse.json();
  const tarballUrl = metadata.dist.tarball;

  console.log(`Downloading tarball from: ${tarballUrl}`);

  // Download the tarball
  const tarballResponse = await fetch(tarballUrl);
  if (!tarballResponse.ok) {
    console.error(`Failed to download tarball: ${tarballResponse.statusText}`);
    process.exit(1);
  }

  // Create a temporary directory for extraction
  const tmpDir = mkdtempSync(join(tmpdir(), `${packageName.replace(/[@/]/g, "-")}-`));
  const tarballPath = join(tmpDir, "package.tgz");

  try {
    // Save tarball to temp file
    const tarballBytes = await tarballResponse.bytes();
    await Deno.writeFile(tarballPath, tarballBytes);

    console.log(`Extracting tarball to: ${tmpDir}`);

    // Extract using tar command
    // Convert paths to Unix-style for tar on Windows
    const unixTarballPath = toUnixPath(tarballPath);
    const unixTmpDir = toUnixPath(tmpDir);

    const extractCmd = new Deno.Command("tar", {
      args: ["-xzf", unixTarballPath, "-C", unixTmpDir],
      stdout: "piped",
      stderr: "piped",
    });

    const { code, stderr } = await extractCmd.output();
    if (code !== 0) {
      console.error("Failed to extract tarball:");
      console.error(new TextDecoder().decode(stderr));
      process.exit(1);
    }

    // Find the extracted package directory
    // Most npm packages extract to a 'package' subdirectory
    let extractedPackageDir = join(tmpDir, "package");
    try {
      await stat(extractedPackageDir);
    } catch {
      // If no 'package' directory, list contents and find the first directory
      const dirEntries = await readdir(tmpDir, { withFileTypes: true });
      const entries = dirEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);

      if (entries.length === 1) {
        extractedPackageDir = join(tmpDir, entries[0]);
      } else if (entries.length === 0) {
        console.error("No directories found in extracted tarball");
        process.exit(1);
      } else {
        console.error(`Multiple directories found in tarball: ${entries.join(", ")}`);
        process.exit(1);
      }
    }

    // Create target directory
    await mkdir(targetDir, { recursive: true });

    // Remove existing directory if it exists
    try {
      await rm(targetDir, { recursive: true });
    } catch {
      // Ignore if doesn't exist
    }

    // Copy the extracted package to target directory
    console.log(`Copying to ${targetDir}...`);

    const copyCmd = new Deno.Command("cp", {
      args: ["-r", extractedPackageDir, targetDir],
      stdout: "piped",
      stderr: "piped",
    });

    const copyResult = await copyCmd.output();
    if (copyResult.code !== 0) {
      console.error("Failed to copy package:");
      console.error(new TextDecoder().decode(copyResult.stderr));
      process.exit(1);
    }

    console.log(`✓ Successfully vendored ${packageName}@${version}`);
  } finally {
    // Clean up temp directory
    try {
      await rm(tmpDir, { recursive: true });
    } catch (err) {
      console.warn(`Failed to clean up temp directory: ${err}`);
    }
  }
}

async function vendorDependencies() {
  // Vendor @tauri-apps/api for frontend
  await downloadAndExtractPackage("@tauri-apps/api", TAURI_API_VERSION, join(VENDOR_DIR, "api"));

  // Verify the vendored files
  try {
    await stat(join(VENDOR_DIR, "api", "core.js"));
    console.log("✓ Verified @tauri-apps/api/core.js exists");
  } catch {
    console.error("Warning: core.js not found in vendored directory");
  }

  // Vendor @types/node for TypeScript compilation
  await downloadAndExtractPackage("@types/node", TYPES_NODE_VERSION, join(TYPES_DIR, "node"));

  // Verify @types/node
  try {
    await stat(join(TYPES_DIR, "node", "index.d.ts"));
    console.log("✓ Verified @types/node/index.d.ts exists");
  } catch {
    console.error("Warning: @types/node index.d.ts not found");
  }
}

if (import.meta.main) {
  await vendorDependencies();
}
