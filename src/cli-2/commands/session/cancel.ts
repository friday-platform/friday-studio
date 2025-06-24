import * as p from "@clack/prompts";
import { confirmAction } from "../../utils/confirm.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";

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
  id: {
    type: "string" as const,
    describe: "Session ID to cancel",
    demandOption: true,
  },
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

    // First, check if the session exists and is running
    const checkResponse = await fetch(`http://localhost:${port}/sessions/${argv.id}`);

    if (!checkResponse.ok) {
      if (checkResponse.status === 404) {
        errorOutput(`Session '${argv.id}' not found`);
      } else {
        errorOutput(`Failed to fetch session: ${checkResponse.statusText}`);
      }
      Deno.exit(1);
    }

    const session = await checkResponse.json();

    // Check if session is already completed
    if (
      session.status === "completed" || session.status === "failed" ||
      session.status === "cancelled"
    ) {
      infoOutput(`Session '${argv.id}' is already ${session.status}`);
      Deno.exit(0);
    }

    // Confirm cancellation
    const confirmed = await confirmAction(
      `Cancel session '${argv.id}'?`,
      { force: argv.force, yes: argv.yes },
    );

    if (!confirmed) {
      infoOutput("Session cancellation aborted");
      Deno.exit(0);
    }

    // Show spinner while cancelling
    const s = p.spinner();
    s.start(`Cancelling session '${argv.id}'...`);

    try {
      const response = await fetch(
        `http://localhost:${port}/sessions/${argv.id}/cancel`,
        {
          method: "POST",
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to cancel session: ${response.statusText}`);
      }

      const result = await response.json();

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
