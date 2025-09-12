import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";
import {
  checkDaemonRunning,
  createDaemonNotRunningError,
  getDaemonClient,
} from "../../utils/daemon-client.ts";
import { errorOutput, infoOutput, warningOutput } from "../../utils/output.ts";
import { isCancel, spinner, text } from "../../utils/prompts.tsx";

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
  name: { type: "string" as const, describe: "Agent name to test", demandOption: true },
  message: { type: "string" as const, alias: "m", describe: "Message to send to the agent" },
  workspace: { type: "string" as const, alias: "w", describe: "Workspace ID or name" },
  json: { type: "boolean" as const, describe: "Output test result as JSON", default: false },
};

export const handler = async (argv: TestArgs): Promise<void> => {
  try {
    // Check if daemon is running
    if (!(await checkDaemonRunning())) {
      throw createDaemonNotRunningError();
    }

    const client = getDaemonClient();

    // Determine target workspace
    let workspaceId: string;
    let workspaceName: string;

    if (argv.workspace) {
      // Use specified workspace - try to find by ID or name
      try {
        const workspace = await client.getWorkspace(argv.workspace);
        workspaceId = workspace.id;
        workspaceName = workspace.name;
      } catch {
        // Try to find by name if ID lookup failed
        const allWorkspaces = await client.listWorkspaces();
        const foundWorkspace = allWorkspaces.find((w) => w.name === argv.workspace);
        if (foundWorkspace) {
          workspaceId = foundWorkspace.id;
          workspaceName = foundWorkspace.name;
        } else {
          throw new Error(`Workspace '${argv.workspace}' not found`);
        }
      }
    } else {
      // Use current workspace (detect from current directory)
      try {
        const adapter = new FilesystemConfigAdapter(Deno.cwd());
        const configLoader = new ConfigLoader(adapter, Deno.cwd());
        const config = await configLoader.load();
        const currentWorkspaceName = config.workspace.workspace.name;

        // Find workspace by name in daemon
        const allWorkspaces = await client.listWorkspaces();
        const currentWorkspace = allWorkspaces.find((w) => w.name === currentWorkspaceName);

        if (currentWorkspace) {
          workspaceId = currentWorkspace.id;
          workspaceName = currentWorkspace.name;
        } else {
          throw new Error(
            `Current workspace '${currentWorkspaceName}' not found in daemon. Use --workspace to specify target.`,
          );
        }
      } catch {
        throw new Error(
          "No workspace.yml found in current directory. Use --workspace to specify target workspace.",
        );
      }
    }

    // Check if agent exists
    const agents = await client.listAgents(workspaceId);
    const agentExists = agents.some((agent) => agent.id === argv.name);

    if (!agentExists) {
      errorOutput(
        `Agent '${argv.name}' not found in workspace '${workspaceName}' (${workspaceId})`,
      );
      Deno.exit(1);
    }

    // Get message either from flag or prompt
    let message = argv.message;
    if (!message) {
      message = await text({
        message: `Enter message to send to ${argv.name}:`,
        placeholder: "Hello, agent!",
        validate: (value) => {
          if (!value || value.trim().length === 0) {
            return "Message cannot be empty";
          }
        },
      });

      if (isCancel(message)) {
        infoOutput("Agent test cancelled");
        Deno.exit(0);
      }
    }

    // Show spinner while testing
    const s = spinner();
    s.start(`Testing agent '${argv.name}'...`);

    // TODO: Implement actual agent testing when runtime is available
    // For now, show a placeholder response
    await new Promise((resolve) => setTimeout(resolve, 1500)); // Simulate work

    s.stop(`Agent test completed`);

    const result = {
      agent: argv.name,
      workspace: workspaceName,
      workspaceId: workspaceId,
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
