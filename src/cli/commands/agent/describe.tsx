import { exists } from "@std/fs";
import { Box, render, Text } from "ink";
import {
  ConfigLoader,
  type NewWorkspaceConfig,
  type WorkspaceAgentConfig,
} from "../../../core/config-loader.ts";
import { getWorkspaceRegistry } from "../../../core/workspace-registry.ts";

interface DescribeArgs {
  name: string;
  json?: boolean;
  workspace?: string;
}

interface AgentDetail extends WorkspaceAgentConfig {
  name: string;
  workspace?: string;
  workspaceId?: string;
}

export const command = "describe <name>";
export const desc = "Show detailed information about an agent";
export const aliases = ["show", "get"];

export const builder = {
  name: {
    type: "string" as const,
    describe: "Agent name to describe",
    demandOption: true,
  },
  json: {
    type: "boolean" as const,
    describe: "Output agent details as JSON",
    default: false,
  },
  workspace: {
    type: "string" as const,
    alias: "w",
    describe: "Workspace ID or name",
  },
};

export const handler = async (argv: DescribeArgs): Promise<void> => {
  try {
    const workspace = await resolveWorkspace(argv.workspace);
    const config = await loadWorkspaceConfig(workspace.path);

    const agentConfig = config.agents?.[argv.name];

    if (!agentConfig) {
      throw new Error(
        `Agent '${argv.name}' not found in workspace '${workspace.name}' (${workspace.id})`,
      );
    }

    const agent: AgentDetail = {
      name: argv.name,
      workspace: workspace.name,
      workspaceId: workspace.id,
      ...agentConfig,
      model: agentConfig.model || "claude-3-5-sonnet-20241022",
    };

    if (argv.json) {
      // JSON output for scripting
      console.log(JSON.stringify(agent, null, 2));
    } else {
      // Render with Ink
      render(<AgentDetailCommand agent={agent} />);
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
): Promise<NewWorkspaceConfig> {
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

// Component that renders the agent details
function AgentDetailCommand({ agent }: { agent: AgentDetail }) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        Agent Details
      </Text>
      <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      <Text>
        Name: <Text color="white">{agent.name}</Text>
      </Text>
      <Text>
        Type: <Text color="white">{agent.type}</Text>
      </Text>
      <Text>
        Model: <Text color="white">{agent.model}</Text>
      </Text>
      {agent.purpose && (
        <Text>
          Purpose: <Text color="white">{agent.purpose}</Text>
        </Text>
      )}
      {agent.workspace && (
        <Text>
          Workspace: <Text color="white">{agent.workspace}</Text>
        </Text>
      )}
      {agent.workspaceId && (
        <Text>
          Workspace ID: <Text color="gray">{agent.workspaceId}</Text>
        </Text>
      )}

      {agent.tools && agent.tools.length > 0 && (
        <>
          <Text></Text>
          <Text bold>Tools:</Text>
          {agent.tools.map((tool, i) => (
            <Box key={i} marginLeft={1}>
              <Text>• {tool}</Text>
            </Box>
          ))}
        </>
      )}

      {agent.prompts && Object.keys(agent.prompts).length > 0 && (
        <>
          <Text></Text>
          <Text bold>Prompts:</Text>
          {Object.entries(agent.prompts).map(([key, value]) => (
            <Box key={key} flexDirection="column" marginLeft={1}>
              <Text color="yellow">{key}:</Text>
              <Box marginLeft={1}>
                <Text color="gray">
                  {String(value).length > 100
                    ? String(value).substring(0, 100) + "..."
                    : String(value)}
                </Text>
              </Box>
            </Box>
          ))}
        </>
      )}
    </Box>
  );
}
