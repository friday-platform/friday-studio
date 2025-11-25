#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";

/**
 * Clean script to remove Atlas data directory contents
 * Preserves .env (API keys) and bin/ (atlas binary)
 */

const PRESERVED_ENTRIES = new Set([".env", "bin"]);

async function clean() {
  const atlasHome = getAtlasHome();

  try {
    let didDelete = false;
    for await (const entry of Deno.readDir(atlasHome)) {
      if (PRESERVED_ENTRIES.has(entry.name)) {
        continue;
      }
      await Deno.remove(join(atlasHome, entry.name), { recursive: true });
      didDelete = true;
    }

    if (didDelete) {
      console.log("Clean complete.");
    } else {
      console.log("Nothing to clean.");
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      console.log(`Atlas directory does not exist: ${atlasHome}`);
    } else {
      console.error(
        `Error cleaning Atlas directory: ${error instanceof Error ? error.message : String(error)}`,
      );
      Deno.exit(1);
    }
  }
}

// Run the clean function
if (import.meta.main) {
  await clean();
}
