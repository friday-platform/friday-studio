#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import { readdir } from "node:fs/promises";
import process from "node:process";
import { isErrnoException, stringifyError } from "@atlas/utils";
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
    const entries = await readdir(atlasHome, { withFileTypes: true });
    for (const entry of entries) {
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
    if (isErrnoException(error) && error.code === "ENOENT") {
      console.log(`Atlas directory does not exist: ${atlasHome}`);
    } else {
      console.error(`Error cleaning Atlas directory: ${stringifyError(error)}`);
      process.exit(1);
    }
  }
}

// Run the clean function
if (import.meta.main) {
  await clean();
}
