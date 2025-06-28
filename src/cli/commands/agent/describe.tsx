import { Box, render, Text } from "ink";
import {
  checkDaemonRunning,
  createDaemonNotRunningError,
  getDaemonClient,
} from "../../utils/daemon-client.ts";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

interface DescribeArgs {
  name: string;
  json?: boolean;
  workspace?: string;
}

interface AgentDetail {
  name: string;
  workspace?: string;
  workspaceId?: string;
  type: string;
  model?: string;
  purpose?: string;
  prompts?: Record<string, string>;
  tools?: any;
  [key: string]: any;
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
      } catch (error) {
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
        const adapter = new FilesystemConfigAdapter();
        const configLoader = new ConfigLoader(adapter);
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
      } catch (error) {
        throw new Error(
          "No workspace.yml found in current directory. Use --workspace to specify target workspace.",
        );
      }
    }

    // Get agent details from daemon
    const agentConfig = await client.describeAgent(workspaceId, argv.name);

    const agent: AgentDetail = {
      name: argv.name,
      workspace: workspaceName,
      workspaceId: workspaceId,
      ...agentConfig,
      model: agentConfig.model || "claude-3-5-sonnet-20241022",
    };

    if (argv.json) {
      // JSON output for scripting
      console.log(JSON.stringify(agent, null, 2));
    } else {
      // Render with Ink
      render(<AgentDetailCommand agent={agent} />);
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};

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

      {agent.tools && (
        <>
          <Text></Text>
          <Text bold>Tools:</Text>
          {Array.isArray(agent.tools)
            ? agent.tools.map((tool, i) => (
              <Box key={i} marginLeft={1}>
                <Text>• {tool}</Text>
              </Box>
            ))
            : (
              <>
                {agent.tools.mcp && agent.tools.mcp.length > 0 && (
                  <>
                    <Box marginLeft={1}>
                      <Text color="cyan">MCP Servers:</Text>
                    </Box>
                    {agent.tools.mcp.map((tool, i) => (
                      <Box key={`mcp-${i}`} marginLeft={2}>
                        <Text>• {tool}</Text>
                      </Box>
                    ))}
                  </>
                )}
                {agent.tools.workspace && agent.tools.workspace.length > 0 && (
                  <>
                    <Box marginLeft={1}>
                      <Text color="cyan">Workspace Tools:</Text>
                    </Box>
                    {agent.tools.workspace.map((tool, i) => (
                      <Box key={`workspace-${i}`} marginLeft={2}>
                        <Text>• {tool}</Text>
                      </Box>
                    ))}
                  </>
                )}
              </>
            )}
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
