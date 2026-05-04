import process from "node:process";
import { getAtlasClient, type SessionDetailedInfo } from "@atlas/client";
import { confirmAction } from "../../utils/confirm.tsx";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { spinner } from "../../utils/prompts.tsx";

// Mirror of WorkspaceSessionStatus values from @atlas/core. Inlined so the CLI
// stays a thin HTTP client and doesn't drag in the daemon's core package at
// module load (the only thing we need are the literal status strings).
const COMPLETED_STATUSES = new Set(["completed", "failed"]);

interface CancelArgs {
  id: string;
  force?: boolean;
  yes?: boolean;
  port?: number;
}

export const command = "cancel <id>";
export const desc = "Cancel a running session";
export const aliases = ["kill", "stop"];

export const builder = {
  id: { type: "string" as const, describe: "Session ID to cancel", demandOption: true },
  force: {
    type: "boolean" as const,
    alias: "f",
    describe: "Force cancel without confirmation",
    default: false,
  },
  yes: {
    type: "boolean" as const,
    alias: "y",
    describe: "Skip confirmation prompt",
    default: false,
  },
  port: {
    type: "number" as const,
    alias: "p",
    describe: "Port of the workspace server",
    default: 8080,
  },
};

export const handler = async (argv: CancelArgs): Promise<void> => {
  try {
    const client = getAtlasClient();

    // First, check if the session exists and is running
    let session: SessionDetailedInfo;
    try {
      session = await client.getSession(argv.id);
    } catch (error) {
      const errorResult = client.handleFetchError(error);
      if (errorResult.reason === "api_error") {
        errorOutput(`Session '${argv.id}' not found`);
      } else {
        errorOutput(`Failed to fetch session: ${errorResult.error}`);
      }
      process.exit(1);
    }

    // Check if session is already in a terminal state
    if (COMPLETED_STATUSES.has(String(session.status).toLowerCase())) {
      infoOutput(`Session '${argv.id}' is already ${session.status}`);
      process.exit(0);
    }

    // Confirm cancellation
    const confirmed = await confirmAction(`Cancel session '${argv.id}'?`, {
      force: argv.force,
      yes: argv.yes,
    });

    if (!confirmed) {
      infoOutput("Session cancellation aborted");
      process.exit(0);
    }

    // Show spinner while cancelling
    const s = spinner();
    s.start(`Cancelling session '${argv.id}'...`);

    try {
      const result = await client.cancelSession(argv.id);

      s.stop(`Session cancelled`);
      successOutput(`Session '${argv.id}' has been cancelled`);

      if (result.message) {
        infoOutput(result.message);
      }
    } catch (err) {
      s.stop("Failed to cancel session");
      throw err;
    }

    process.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
