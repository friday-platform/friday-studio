import { load } from "@std/dotenv";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";
import { ServerMode } from "../../../../packages/mcp-server/src/types.ts";

interface McpServeArgs {
  port?: number;
  logLevel?: string;
  daemonUrl?: string;
  mode?: ServerMode;
}

export const command = "serve";
export const desc = "Start Atlas MCP (Model Context Protocol) server";

export const examples = [
  ["$0 mcp serve", "Start MCP server in internal mode (default)"],
  ["$0 mcp serve --mode public", "Start MCP server in public mode"],
  ["$0 mcp serve --mode internal", "Start MCP server in internal mode"],
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
    .option("mode", {
      type: "string",
      alias: "m",
      describe: "Server mode: internal (all tools) or public (public tools only)",
      choices: ["internal", "public"],
      default: "internal",
    })
    .option("logLevel", {
      type: "string",
      describe: "Logging level (debug, info, warn, error)",
      choices: ["debug", "info", "warn", "error"],
      default: "info",
    })
    .example("$0 mcp serve", "Start MCP server in internal mode (default)")
    .example("$0 mcp serve --mode public", "Start MCP server in public mode")
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

    // Get server mode from argument, default to internal
    const mode = (argv.mode as ServerMode) || ServerMode.INTERNAL;

    infoOutput(`Starting Atlas MCP server...`);
    infoOutput(`Server mode: ${mode}`);
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
      mode, // Server mode (internal or public)
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
      successOutput(`Atlas MCP server is running (${mode} mode)`);
      successOutput(`Connected to daemon at: ${daemonUrl}`);

      const availableTools = mcpServer.getAvailableTools();
      infoOutput(`Available tools (${availableTools.length} total):`);

      // Group tools by category for better display
      const publicTools = availableTools.filter((tool) =>
        ["workspace_list", "workspace_create", "workspace_delete", "workspace_describe"].includes(
          tool,
        )
      );
      const workspaceTools = availableTools.filter((tool) =>
        tool.startsWith("workspace_") && !publicTools.includes(tool)
      );
      const libraryTools = availableTools.filter((tool) => tool.startsWith("library_"));

      if (publicTools.length > 0) {
        infoOutput("Platform capabilities:");
        publicTools.forEach((tool) => infoOutput(`  - ${tool}`));
      }

      if (workspaceTools.length > 0) {
        infoOutput("Workspace capabilities:");
        workspaceTools.forEach((tool) => infoOutput(`  - ${tool}`));
      }

      if (libraryTools.length > 0) {
        infoOutput("Library capabilities:");
        libraryTools.forEach((tool) => infoOutput(`  - ${tool}`));
      }

      if (mode === ServerMode.PUBLIC) {
        infoOutput("Note: Running in PUBLIC mode - only platform tools available");
      } else {
        infoOutput("Note: Running in INTERNAL mode - all tools available");
      }

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
