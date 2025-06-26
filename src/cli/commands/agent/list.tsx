import { exists } from "@std/fs";
import { Box, render, Text } from "ink";
import { ConfigLoader } from "../../../core/config-loader.ts";
import type { WorkspaceConfig } from "@atlas/types";
import { FileSystemConfigurationAdapter } from "@atlas/storage";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";

interface ListArgs {
  json?: boolean;
  workspace?: string;
}

interface Agent {
  name: string;
  type: string;
  model: string;
  status: string;
  purpose: string;
}

export const command = "list";
export const desc = "List workspace agents";
export const aliases = ["ls"];

export const builder = {
  json: {
    type: "boolean" as const,
    describe: "Output agent list as JSON",
    default: false,
  },
  workspace: {
    type: "string" as const,
    alias: "w",
    describe: "Workspace ID or name",
  },
};

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    const workspace = await resolveWorkspace(argv.workspace);
    const config = await loadWorkspaceConfig(workspace.path);

    const agents: Agent[] = Object.entries(config.agents || {}).map(
      ([id, agent]) => ({
        name: id,
        type: agent.type || "local",
        model: agent.model || "claude-3-5-sonnet-20241022",
        status: "ready",
        purpose: agent.purpose || "No description",
      }),
    );

    if (argv.json) {
      // JSON output for scripting
      console.log(
        JSON.stringify(
          {
            workspace: {
              id: workspace.id,
              name: workspace.name,
              path: workspace.path,
            },
            agents: agents,
            count: agents.length,
          },
          null,
          2,
        ),
      );
    } else {
      // Render with Ink
      render(
        <AgentListCommand agents={agents} workspaceName={workspace.name} />,
      );
      // Exit immediately after rendering
      Deno.exit(0);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
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
    const workspace = (await registry.findById(workspaceId)) ||
      (await registry.findByName(workspaceId));

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
async function loadWorkspaceConfig(
  workspacePath: string,
): Promise<WorkspaceConfig> {
  const originalCwd = Deno.cwd();
  try {
    Deno.chdir(workspacePath);
    const adapter = new FileSystemConfigurationAdapter();
    const configLoader = new ConfigLoader(adapter);
    const mergedConfig = await configLoader.load();
    return mergedConfig.workspace;
  } finally {
    Deno.chdir(originalCwd);
  }
}

// Component that renders the agent list
function AgentListCommand({
  agents,
  workspaceName,
}: {
  agents: Agent[];
  workspaceName: string;
}) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Agents in workspace: {workspaceName}
      </Text>
      <Text color="gray">
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      </Text>
      {agents.length === 0 ? <Text color="gray">No agents configured</Text> : (
        <>
          <Box>
            <Box width={25}>
              <Text bold color="cyan">
                AGENT
              </Text>
            </Box>
            <Box width={10}>
              <Text bold color="cyan">
                TYPE
              </Text>
            </Box>
            <Box width={30}>
              <Text bold color="cyan">
                MODEL
              </Text>
            </Box>
            <Box width={10}>
              <Text bold color="cyan">
                STATUS
              </Text>
            </Box>
            <Box width={45}>
              <Text bold color="cyan">
                PURPOSE
              </Text>
            </Box>
          </Box>
          <Text>
            ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          </Text>
          {agents.map((agent) => (
            <Box key={agent.name}>
              <Box width={25}>
                <Text>{agent.name}</Text>
              </Box>
              <Box width={10}>
                <Text>{agent.type}</Text>
              </Box>
              <Box width={30}>
                <Text>{agent.model}</Text>
              </Box>
              <Box width={10}>
                <Text color="green">{agent.status}</Text>
              </Box>
              <Box width={45}>
                <Text>{agent.purpose}</Text>
              </Box>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
