import * as p from "@clack/prompts";
import { exists } from "@std/fs";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";
import { ConfigLoader, type NewWorkspaceConfig } from "../../../core/config-loader.ts";
import { errorOutput, infoOutput, warningOutput } from "../../utils/output.ts";

interface TestArgs {
  name: string;
  message?: string;
  workspace?: string;
  json?: boolean;
}

export const command = "test <name>";
export const desc = "Test an agent with a message";
export const aliases = ["try", "run"];

export const builder = {
  name: {
    type: "string" as const,
    describe: "Agent name to test",
    demandOption: true,
  },
  message: {
    type: "string" as const,
    alias: "m",
    describe: "Message to send to the agent",
  },
  workspace: {
    type: "string" as const,
    alias: "w",
    describe: "Workspace ID or name",
  },
  json: {
    type: "boolean" as const,
    describe: "Output test result as JSON",
    default: false,
  },
};

export const handler = async (argv: TestArgs): Promise<void> => {
  try {
    const workspace = await resolveWorkspace(argv.workspace);
    const config = await loadWorkspaceConfig(workspace.path);

    const agentConfig = config.agents?.[argv.name];
    if (!agentConfig) {
      errorOutput(
        `Agent '${argv.name}' not found in workspace '${workspace.name}' (${workspace.id})`,
      );
      Deno.exit(1);
    }

    // Get message either from flag or prompt
    let message = argv.message;
    if (!message) {
      message = await p.text({
        message: `Enter message to send to ${argv.name}:`,
        placeholder: "Hello, agent!",
        validate: (value) => {
          if (!value || value.trim().length === 0) {
            return "Message cannot be empty";
          }
        },
      }) as string;

      if (p.isCancel(message)) {
        infoOutput("Agent test cancelled");
        Deno.exit(0);
      }
    }

    // Show spinner while testing
    const s = p.spinner();
    s.start(`Testing agent '${argv.name}'...`);

    // TODO: Implement actual agent testing when runtime is available
    // For now, show a placeholder response
    await new Promise((resolve) => setTimeout(resolve, 1500)); // Simulate work

    s.stop(`Agent test completed`);

    const result = {
      agent: argv.name,
      workspace: workspace.name,
      workspaceId: workspace.id,
      message: message,
      status: "not_implemented",
      response:
        "Agent testing is not yet implemented. Use 'atlas signal trigger' to test agents in a workflow.",
      timestamp: new Date().toISOString(),
    };

    if (argv.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      warningOutput("Agent testing not yet implemented");
      infoOutput("Use 'atlas signal trigger' to test agents in a workflow");
      infoOutput(`\nTo test '${argv.name}', you can:`);
      infoOutput(`1. Configure a signal that uses this agent`);
      infoOutput(`2. Run: atlas signal trigger <signal-name> --data '{"message": "${message}"}'`);
    }

    Deno.exit(0);
  } catch (error) {
    errorOutput(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
};

// Helper function to resolve workspace from ID or current directory
async function resolveWorkspace(workspaceId?: string): Promise<{
  path: string;
  id: string;
  name: string;
}> {
  const registry = getWorkspaceRegistry();
  await registry.initialize();

  if (workspaceId) {
    // Find by ID or name in registry
    const workspace = await registry.findById(workspaceId) ||
      await registry.findByName(workspaceId);

    if (!workspace) {
      throw new Error(
        `Workspace '${workspaceId}' not found. ` +
          `Run 'atlas workspace list' to see available workspaces.`,
      );
    }

    return {
      path: workspace.path,
      id: workspace.id,
      name: workspace.name,
    };
  } else {
    // Try current directory
    const currentWorkspace = await registry.getCurrentWorkspace();

    if (currentWorkspace) {
      return {
        path: currentWorkspace.path,
        id: currentWorkspace.id,
        name: currentWorkspace.name,
      };
    }

    // Fallback to checking for workspace.yml in current directory
    if (await exists("workspace.yml")) {
      // Register this workspace if not already registered
      const workspace = await registry.findOrRegister(Deno.cwd());
      return {
        path: workspace.path,
        id: workspace.id,
        name: workspace.name,
      };
    }

    throw new Error(
      "No workspace specified and not in a workspace directory. " +
        "Use --workspace flag or run from a workspace directory.",
    );
  }
}

// Helper function to load workspace configuration
async function loadWorkspaceConfig(workspacePath: string): Promise<NewWorkspaceConfig> {
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const configLoader = new ConfigLoader();
    const mergedConfig = await configLoader.load();
    return mergedConfig.workspace;
  } finally {
    Deno.chdir(originalCwd);
  }
}
