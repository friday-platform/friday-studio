import * as p from "@clack/prompts";
import { exists } from "@std/fs";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { ConfigLoader } from "../../../core/config-loader.ts";
import { errorOutput, infoOutput, successOutput } from "../../utils/output.ts";

interface TriggerArgs {
  name: string;
  data?: string;
  port?: number;
  workspace?: string;
  json?: boolean;
}

export const command = "trigger <name>";
export const desc = "Trigger a signal manually";
export const aliases = ["fire", "send"];

export const builder = {
  name: {
    type: "string" as const,
    describe: "Signal name to trigger",
    demandOption: true,
  },
  data: {
    type: "string" as const,
    alias: "d",
    describe: "JSON payload data for the signal",
  },
  port: {
    type: "number" as const,
    alias: "p",
    describe: "Port of the workspace server",
    default: 8080,
  },
  workspace: {
    type: "string" as const,
    alias: "w",
    describe: "Workspace ID or name",
  },
  json: {
    type: "boolean" as const,
    describe: "Output trigger result as JSON",
    default: false,
  },
};

export const handler = async (argv: TriggerArgs): Promise<void> => {
  try {
    // Verify signal exists in workspace config
    const { workspace, config } = await resolveWorkspaceAndConfig(argv.workspace);

    const signals = config.signals as Record<string, unknown>;
    if (!signals || !signals[argv.name]) {
      errorOutput(
        `Signal '${argv.name}' not found in workspace '${workspace.name}'. ` +
          `Use 'atlas signal list' to see available signals.`,
      );
      Deno.exit(1);
    }

    // Get data either from flag or prompt
    let dataStr = argv.data;
    let payload: Record<string, unknown> = {};

    if (!dataStr) {
      // Interactive mode - prompt for data
      const wantsData = await p.confirm({
        message: "Do you want to provide data for this signal?",
        initialValue: false,
      });

      if (p.isCancel(wantsData)) {
        infoOutput("Signal trigger cancelled");
        Deno.exit(0);
      }

      if (wantsData) {
        dataStr = await p.text({
          message: "Enter JSON data:",
          placeholder: '{"message": "Hello"}',
          validate: (value) => {
            if (!value || value.trim().length === 0) {
              return "Data cannot be empty";
            }
            try {
              JSON.parse(value);
            } catch {
              return "Invalid JSON format";
            }
          },
        }) as string;

        if (p.isCancel(dataStr)) {
          infoOutput("Signal trigger cancelled");
          Deno.exit(0);
        }
      }
    }

    // Parse JSON data if provided
    if (dataStr) {
      try {
        payload = JSON.parse(dataStr);
      } catch (err) {
        errorOutput(
          `Invalid JSON data: ${err instanceof Error ? err.message : String(err)}`,
        );
        Deno.exit(1);
      }
    }

    // Show spinner while triggering
    const s = p.spinner();
    s.start(`Triggering signal '${argv.name}'...`);

    const port = argv.port || 8080;

    try {
      // Fire and forget - don't wait for full response
      const response = await fetch(
        `http://localhost:${port}/signals/${argv.name}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Failed to trigger signal: ${response.status} ${response.statusText}. ${errorText}`,
        );
      }

      const result = await response.json();

      s.stop(`Signal triggered successfully`);

      const triggerResult = {
        signal: argv.name,
        workspace: workspace.name,
        workspaceId: workspace.id,
        status: "accepted",
        sessionId: result.sessionId,
        message: "Signal triggered successfully (processing asynchronously)",
        timestamp: new Date().toISOString(),
      };

      if (argv.json) {
        console.log(JSON.stringify(triggerResult, null, 2));
      } else {
        successOutput("Signal triggered successfully");
        infoOutput(`Signal: ${argv.name}`);
        if (result.sessionId) {
          infoOutput(`Session ID: ${result.sessionId}`);
          infoOutput(`\nMonitor the session with: atlas logs ${result.sessionId}`);
        } else {
          infoOutput("\nUse 'atlas ps' to see active sessions");
        }
      }

      Deno.exit(0);
    } catch (err) {
      s.stop("Failed to trigger signal");

      if (err instanceof Error && err.message.includes("Connection refused")) {
        throw new Error(
          `Cannot connect to workspace server on port ${port}. Is it running? Use 'atlas workspace serve' to start it.`,
        );
      }
      throw err;
    }
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};

// Helper function to resolve workspace and load config
async function resolveWorkspaceAndConfig(workspaceId?: string): Promise<{
  workspace: { path: string; id: string; name: string };
  config: Record<string, unknown>;
}> {
  const registry = getWorkspaceRegistry();
  await registry.initialize();

  let workspacePath = Deno.cwd();
  let workspace;

  if (workspaceId) {
    // Find workspace by ID or name in the registry
    const targetWorkspace = (await registry.findById(workspaceId)) ||
      (await registry.findByName(workspaceId));

    if (!targetWorkspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found in registry. Use 'atlas workspace list' to see registered workspaces.`,
      );
    }

    workspacePath = targetWorkspace.path;
    workspace = {
      path: targetWorkspace.path,
      id: targetWorkspace.id,
      name: targetWorkspace.name,
    };
  } else {
    // Check current directory for workspace.yml
    if (!await exists("workspace.yml")) {
      throw new Error(
        "No workspace specified and not in a workspace directory. " +
          "Use --workspace flag or run from a workspace directory.",
      );
    }

    // Try to find in registry or register
    const currentWorkspace = await registry.getCurrentWorkspace() ||
      await registry.findOrRegister(Deno.cwd());

    workspace = {
      path: currentWorkspace.path,
      id: currentWorkspace.id,
      name: currentWorkspace.name,
    };
  }

  // Load configuration from the determined workspace path
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();
    return { workspace, config: mergedConfig.workspace };
  } finally {
    Deno.chdir(originalCwd);
  }
}
