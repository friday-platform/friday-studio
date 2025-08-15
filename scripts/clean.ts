#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import { join } from "@std/path";

/**
 * Clean script to remove the Atlas data directory
 * This removes all Atlas data including logs, cache, and configuration
 * but preserves the .env file if it exists
 */

async function clean() {
  // Determine the Atlas home directory
  const atlasHome = Deno.env.get("ATLAS_HOME") ||
    join(Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "", ".atlas");

  try {
    // Check if directory exists
    await Deno.stat(atlasHome);

    // Path to the .env file we want to preserve
    const envFilePath = join(atlasHome, ".env");
    let envFileContent: string | null = null;

    // Try to backup the .env file if it exists
    try {
      envFileContent = await Deno.readTextFile(envFilePath);
      console.log(`Backed up .env file`);
    } catch {
      // .env file doesn't exist, which is fine
    }

    // Remove the directory
    await Deno.remove(atlasHome, { recursive: true });
    console.log(`Removed Atlas directory: ${atlasHome}`);

    // Restore the .env file if we backed it up
    if (envFileContent !== null) {
      // Recreate the .atlas directory
      await Deno.mkdir(atlasHome, { recursive: true });
      // Restore the .env file
      await Deno.writeTextFile(envFilePath, envFileContent);
      console.log(`Restored .env file`);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log(`Atlas directory does not exist: ${atlasHome}`);
    } else {
      console.error(
        `Error removing Atlas directory: ${error instanceof Error ? error.message : String(error)}`,
      );
      Deno.exit(1);
    }
  }
}

// Run the clean function
if (import.meta.main) {
  await clean();
}
