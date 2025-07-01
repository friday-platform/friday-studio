import { load } from "@std/dotenv";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface McpServeArgs {
  port?: number;
  logLevel?: string;
  daemonUrl?: string;
}

export const command = "serve";
export const desc = "Start Atlas MCP (Model Context Protocol) server";

export const examples = [
  ["$0 mcp serve", "Start MCP server with default settings"],
  ["$0 mcp serve --port 8081", "Start MCP server on specific port"],
];

export function builder(y: YargsInstance) {
  return y
    .option("port", {
      type: "number",
      alias: "p",
      describe: "Port for HTTP endpoint (optional, MCP uses stdio)",
    })
    .option("daemon-url", {
      type: "string",
      describe: "Atlas daemon URL to connect to",
      default: "http://localhost:8080",
    })
    .option("logLevel", {
      type: "string",
      describe: "Logging level (debug, info, warn, error)",
      choices: ["debug", "info", "warn", "error"],
      default: "info",
    })
    .example("$0 mcp serve", "Start MCP server with default settings")
    .example("$0 mcp serve --daemon-url http://localhost:8080", "Connect to specific daemon");
}

export const handler = async (argv: McpServeArgs): Promise<void> => {
  try {
    // Load environment variables
    await load({ export: true });

    // Get daemon URL from argument, environment variable, or default
    const daemonUrl = argv.daemonUrl ||
      Deno.env.get("ATLAS_DAEMON_URL") ||
      "http://localhost:8080";

    infoOutput(`Starting Atlas MCP server...`);
    infoOutput(`Connecting to daemon at: ${daemonUrl}`);

    // Import platform MCP server
    const { PlatformMCPServer } = await import("@atlas/mcp-server");

    // Create console logger
    const logger = {
      info: (message: string, context?: Record<string, unknown>) => {
        const contextStr = context ? ` ${JSON.stringify(context)}` : "";
        console.log(`[INFO] ${message}${contextStr}`);
      },
      warn: (message: string, context?: Record<string, unknown>) => {
        const contextStr = context ? ` ${JSON.stringify(context)}` : "";
        console.warn(`[WARN] ${message}${contextStr}`);
      },
      error: (message: string, context?: Record<string, unknown>) => {
        const contextStr = context ? ` ${JSON.stringify(context)}` : "";
        console.error(`[ERROR] ${message}${contextStr}`);
      },
      debug: (message: string, context?: Record<string, unknown>) => {
        const contextStr = context ? ` ${JSON.stringify(context)}` : "";
        console.debug(`[DEBUG] ${message}${contextStr}`);
      },
    };

    // Create MCP server with platform-level capabilities (no config needed - daemon handles that)
    const mcpServer = new PlatformMCPServer({
      daemonUrl, // All operations go through daemon API
      logger,
    });

    // Handle graceful shutdown
    const shutdown = async () => {
      infoOutput("\\nShutting down MCP server...");
      await mcpServer.stop();
      successOutput("MCP server stopped successfully.");
      Deno.exit(0);
    };

    Deno.addSignalListener("SIGINT", shutdown);
    Deno.addSignalListener("SIGTERM", shutdown);

    // Start the MCP server (stdio transport)
    try {
      await mcpServer.start();
      successOutput("Atlas MCP server is running (stdio transport)");
      successOutput(`Connected to daemon at: ${daemonUrl}`);
      infoOutput("Available tools:");
      infoOutput("Platform capabilities:");
      infoOutput("  - workspace_list (list workspaces via daemon API)");
      infoOutput("  - workspace_create (create workspace via daemon API)");
      infoOutput("  - workspace_delete (delete workspace via daemon API)");
      infoOutput("  - workspace_describe (describe workspace via daemon API)");
      infoOutput("Workspace capabilities (via daemon API):");
      infoOutput("  - workspace_jobs_list (list jobs in workspace)");
      infoOutput("  - workspace_jobs_describe (describe specific job)");
      infoOutput("  - workspace_sessions_list (list sessions in workspace)");
      infoOutput("  - workspace_sessions_describe (describe specific session)");
      infoOutput("  - workspace_sessions_cancel (cancel running session)");
      infoOutput("  - workspace_signals_list (list signals in workspace)");
      infoOutput("  - workspace_signals_trigger (trigger signal in workspace)");
      infoOutput("  - workspace_agents_list (list agents in workspace)");
      infoOutput("  - workspace_agents_describe (describe specific agent)");
      infoOutput("Press Ctrl+C to stop the server.");

      // Keep the process alive
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      errorOutput(
        `Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`,
      );
      if (error instanceof Error && error.message.includes("daemon not accessible")) {
        errorOutput("Make sure to start the Atlas daemon first:");
        errorOutput("  atlas daemon start");
      }
      Deno.exit(1);
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
