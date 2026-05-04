#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";
import { isErrnoException, stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { connectToNats, resolveNatsUrl } from "jetstream";

/**
 * Clean script to remove Atlas data directory contents
 * Preserves .env (API keys) and bin/ (atlas binary)
 */

const PRESERVED_ENTRIES = new Set([".env", "bin"]);
// OAuth credentials written by setup-secrets.sh (e.g. google_client_id, hubspot_client_secret)
const PRESERVED_SUFFIXES = ["_client_id", "_client_secret"];

const DAEMON_HEALTH_URL = "http://localhost:8080/health";
const LOCALHOST_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

async function isDaemonRunning(): Promise<boolean> {
  try {
    const res = await fetch(DAEMON_HEALTH_URL, { signal: AbortSignal.timeout(500) });
    return res.ok;
  } catch {
    return false;
  }
}

function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return LOCALHOST_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

function isSystemStream(name: string): boolean {
  return name.startsWith("$JS") || name.startsWith("$SYS");
}

/**
 * Resolve the JetStream on-disk store directory for the embedded broker.
 * Mirrors the resolution in `apps/atlasd/src/nats-manager.ts`: env override
 * → `<getFridayHome()>/jetstream`.
 */
function resolveEmbeddedStoreDir(): string {
  return process.env.FRIDAY_JETSTREAM_STORE_DIR ?? join(getFridayHome(), "jetstream");
}

async function clearExternalBroker(force: boolean): Promise<void> {
  const url = resolveNatsUrl();
  if (!isLocalhostUrl(url) && !force) {
    console.error(
      `Refusing to wipe streams on non-local broker ${url}. ` +
        `Re-run with --force if you really mean it.`,
    );
    process.exit(1);
  }

  let nc: Awaited<ReturnType<typeof connectToNats>>;
  try {
    nc = await connectToNats({ url, name: "clean-script", timeoutMs: 2_000 });
  } catch (error) {
    console.error(
      `Could not connect to NATS at ${url} to purge JetStream state: ${stringifyError(error)}`,
    );
    process.exit(1);
  }

  try {
    const jsm = await nc.jetstreamManager();
    let deleted = 0;
    for await (const info of jsm.streams.list()) {
      const name = info.config.name;
      if (isSystemStream(name)) continue;
      await jsm.streams.delete(name);
      deleted++;
    }
    console.log(`Broker state cleared: deleted ${deleted} stream(s) on ${url}.`);
  } finally {
    try {
      await nc.drain();
    } catch {
      // ignore drain errors during cleanup
    }
  }
}

async function clearEmbeddedBroker(): Promise<void> {
  const storeDir = resolveEmbeddedStoreDir();
  // Defensive guard against a misconfigured FRIDAY_JETSTREAM_STORE_DIR
  // pointing somewhere catastrophic. The real daemon paths always
  // contain "jetstream" or "nats" in the final segments.
  if (!/nats|jetstream/i.test(storeDir)) {
    console.error(`Refusing to delete JetStream store dir that doesn't look like one: ${storeDir}`);
    process.exit(1);
  }
  try {
    await rm(storeDir, { recursive: true, force: true });
    console.log(`JetStream store dir cleared: ${storeDir}`);
  } catch (error) {
    console.error(`Error clearing JetStream store dir: ${stringifyError(error)}`);
    process.exit(1);
  }
}

async function clearBrokerState(force: boolean): Promise<void> {
  if (process.env.FRIDAY_NATS_URL) {
    await clearExternalBroker(force);
  } else {
    await clearEmbeddedBroker();
  }
}

async function cleanAgents() {
  const atlasHome = getFridayHome();
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
  const atlasHome = getFridayHome();

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
  const force = process.argv.includes("--force");

  if (agentsOnly) {
    await cleanAgents();
  } else {
    if (await isDaemonRunning()) {
      console.error(
        "Daemon is running — stop it first with `deno task atlas daemon stop` " +
          "(or kill the launcher) before running clean.",
      );
      process.exit(1);
    }
    await clearBrokerState(force);
    await clean();
  }
}
