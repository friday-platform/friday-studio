#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { isErrnoException, stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";

/**
 * Clean script to remove Atlas data directory contents
 * Preserves .env (API keys) and bin/ (atlas binary)
 */

const PRESERVED_ENTRIES = new Set([".env", "bin"]);
// OAuth credentials written by setup-secrets.sh (e.g. google_client_id, hubspot_client_secret)
const PRESERVED_SUFFIXES = ["_client_id", "_client_secret"];

async function cleanAgents() {
  const atlasHome = getAtlasHome();
  const agentsDir = join(atlasHome, "agents");
  try {
    await rm(agentsDir, { recursive: true, force: true });
    console.log("Agents directory cleared.");
  } catch (error) {
    console.error(`Error clearing agents directory: ${stringifyError(error)}`);
    process.exit(1);
  }
}

async function clean() {
  const atlasHome = getAtlasHome();

  try {
    let didDelete = false;
    const entries = await readdir(atlasHome, { withFileTypes: true });
    for (const entry of entries) {
      if (
        PRESERVED_ENTRIES.has(entry.name) ||
        PRESERVED_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))
      ) {
        continue;
      }
      await rm(join(atlasHome, entry.name), { recursive: true });
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
  const agentsOnly = process.argv.includes("--agents");
  if (agentsOnly) {
    await cleanAgents();
  } else {
    await clean();
  }
}
