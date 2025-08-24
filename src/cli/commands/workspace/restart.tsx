import { getWorkspaceManager } from "@atlas/workspace";
import { errorOutput } from "../../utils/output.ts";

export const command = "restart [workspace]";
export const desc = "Restart a workspace server";

export const builder = {
  workspace: {
    type: "string" as const,
    describe: "Workspace ID or name (defaults to current directory)",
  },
  port: { type: "number" as const, alias: "p", describe: "Port to run the server on" },
  detached: {
    type: "boolean" as const,
    alias: "d",
    describe: "Run server in background after restart",
    default: false,
  },
  lazy: {
    type: "boolean" as const,
    describe: "Start in lazy mode (agents loaded on demand)",
    default: false,
  },
  logLevel: {
    type: "string" as const,
    describe: "Logging level (debug, info, warn, error)",
    choices: ["debug", "info", "warn", "error"],
  },
};

export const handler = async (): Promise<void> => {
  try {
    const registry = await getWorkspaceManager();
    await registry.initialize();

    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
