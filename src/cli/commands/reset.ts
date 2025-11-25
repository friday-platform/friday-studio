import { client, parseResult } from "@atlas/client/v2";
import { sleep } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";
import { ServiceManager } from "../../services/service-manager.ts";
import { confirmAction } from "../utils/confirm.tsx";
import { errorOutput, infoOutput, successOutput, warningOutput } from "../utils/output.ts";

interface ResetArgs {
  force?: boolean;
}

export const command = "reset";
export const desc = false; // Hidden from --help

export const builder = {
  force: {
    type: "boolean" as const,
    alias: "f",
    describe: "Force reset without confirmation",
    default: false,
  },
};

const PRESERVED_ENTRIES = new Set([".env", "bin"]);

async function stopAtlasIfRunning(): Promise<"service" | "daemon" | null> {
  const serviceManager = ServiceManager.getInstance();

  if (await serviceManager.isInstalled()) {
    const status = await serviceManager.getStatus();
    if (status.running) {
      infoOutput("Stopping Atlas service...");
      try {
        await serviceManager.stop(true);
      } catch {
        /* ignore - may already be stopping */
      }
      await sleep(2000);
      return "service";
    }
  }

  const isRunning = await parseResult(client.health.index.$get());
  if (!isRunning.ok) {
    return null;
  }

  infoOutput("Stopping Atlas daemon...");
  try {
    await client.daemon.shutdown.$post();
  } catch {
    /* ignore - may already be stopping */
  }
  await sleep(2000);
  return "daemon";
}

export const handler = async (argv: ResetArgs): Promise<void> => {
  const atlasHome = getAtlasHome();

  const confirmed = await confirmAction(
    `This will delete all Atlas data in ${atlasHome} (preserving .env and bin/). Continue?`,
    { force: argv.force, defaultValue: false },
  );

  if (!confirmed) {
    infoOutput("Reset cancelled.");
    Deno.exit(0);
  }

  const stoppedMode = await stopAtlasIfRunning();

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
      successOutput("Reset complete.");
    } else {
      infoOutput("Nothing to reset.");
    }

    if (stoppedMode) {
      warningOutput(`Run 'atlas ${stoppedMode} start' to restart the ${stoppedMode}.`);
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      infoOutput(`Atlas directory does not exist: ${atlasHome}`);
    } else {
      errorOutput(error instanceof Error ? error.message : String(error));
      Deno.exit(1);
    }
  }

  Deno.exit(0);
};
