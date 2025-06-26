import { load } from "@std/dotenv";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";
import { YargsInstance } from "../../utils/yargs.ts";

interface McpServeArgs {
  port?: number;
  logLevel?: string;
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
    .option("logLevel", {
      type: "string",
      describe: "Logging level (debug, info, warn, error)",
      choices: ["debug", "info", "warn", "error"],
      default: "info",
    })
    .example("$0 mcp serve", "Start MCP server with default settings")
    .example("$0 mcp serve --port 8081", "Start MCP server on specific port");
}

export const handler = async (_argv: McpServeArgs): Promise<void> => {
  try {
    // Load environment variables
    await load({ export: true });

    infoOutput("Starting Atlas MCP server...");

    // Import platform MCP server and dependencies
    const { PlatformMCPServer } = await import("../../../core/mcp/platform-mcp-server.ts");
    const { WorkspaceRuntimeRegistry } = await import(
      "../../../core/workspace-runtime-registry.ts"
    );
    const { ConfigLoader } = await import("../../../core/config-loader.ts");
    const { FileSystemConfigurationAdapter } = await import("@atlas/storage");

    // Load Atlas configuration
    const adapter = new FileSystemConfigurationAdapter();
    const configLoader = new ConfigLoader(adapter);
    const mergedConfig = await configLoader.load();
    const atlasConfig = mergedConfig.atlas;

    // Get workspace runtime registry (tracks active workspace runtimes)
    const runtimeRegistry = WorkspaceRuntimeRegistry.getInstance();

    infoOutput(`Found ${runtimeRegistry.getActiveCount()} active workspace(s)`);

    // Create MCP server with platform-level capabilities
    const mcpServer = new PlatformMCPServer({
      runtimeRegistry,
      atlasConfig,
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
      infoOutput("Available tools:");
      infoOutput("  - workspace_list (shows active runtime status)");
      infoOutput("  - workspace_create (creates and starts runtime)");
      infoOutput("  - workspace_delete (shuts down runtime)");
      infoOutput("  - workspace_describe (live runtime details)");
      infoOutput("  - workspace_trigger_job (trigger job via runtime)");
      infoOutput("  - workspace_process_signal (process signal via runtime)");
      infoOutput("Press Ctrl+C to stop the server.");

      // Keep the process alive
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      errorOutput(
        `Failed to start MCP server: ${error instanceof Error ? error.message : String(error)}`,
      );
      Deno.exit(1);
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};
