import { getAtlasClient, type SessionDetailedInfo } from "@atlas/client";
import { WorkspaceSessionStatus } from "@atlas/core";
import { confirmAction } from "../../utils/confirm.tsx";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { spinner } from "../../utils/prompts.tsx";

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
    const port = argv.port || 8080;
    const client = getAtlasClient({ url: `http://localhost:${port}` });

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
      Deno.exit(1);
    }

    // Check if session is already completed
    if (
      session.status === WorkspaceSessionStatus.COMPLETED ||
      session.status === WorkspaceSessionStatus.FAILED
    ) {
      infoOutput(`Session '${argv.id}' is already ${session.status}`);
      Deno.exit(0);
    }

    // Confirm cancellation
    const confirmed = await confirmAction(`Cancel session '${argv.id}'?`, {
      force: argv.force,
      yes: argv.yes,
    });

    if (!confirmed) {
      infoOutput("Session cancellation aborted");
      Deno.exit(0);
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

    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
