#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import { join } from "@std/path";

/**
 * Clean script to remove the Atlas data directory
 * This removes all Atlas data including logs, cache, and configuration
 */

async function clean() {
  // Determine the Atlas home directory
  const atlasHome = Deno.env.get("ATLAS_HOME") ||
    join(Deno.env.get("HOME") || Deno.env.get("USERPROFILE") || "", ".atlas");

  try {
    // Check if directory exists
    await Deno.stat(atlasHome);

    // Remove the directory
    await Deno.remove(atlasHome, { recursive: true });
    console.log(`✓ Removed Atlas directory: ${atlasHome}`);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log(`Atlas directory does not exist: ${atlasHome}`);
    } else {
      console.error(`Error removing Atlas directory: ${error.message}`);
      Deno.exit(1);
    }
  }
}

// Run the clean function
if (import.meta.main) {
  await clean();
}
