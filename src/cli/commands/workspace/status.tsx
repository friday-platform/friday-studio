import { Box, render, Text } from "ink";
import {
  checkDaemonRunning,
  createDaemonNotRunningError,
  getDaemonClient,
} from "../../utils/daemon-client.ts";
import { ConfigLoader } from "@atlas/config";
import { FilesystemConfigAdapter } from "@atlas/storage";

interface StatusArgs {
  json?: boolean;
  workspace?: string;
}

export const command = "status [workspace]";
export const desc = "Show workspace status and configuration";

export const builder = {
  workspace: {
    type: "string" as const,
    describe: "Workspace ID or name (defaults to current directory)",
  },
  json: {
    type: "boolean" as const,
    describe: "Output status information as JSON",
    default: false,
  },
};

export const handler = async (argv: StatusArgs): Promise<void> => {
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

    // Get detailed workspace information from daemon
    const workspace = await client.getWorkspace(workspaceId);

    // Get additional workspace details
    const [agents, signals, jobs, sessions] = await Promise.all([
      client.listAgents(workspaceId).catch(() => []),
      client.listSignals(workspaceId).catch(() => []),
      client.listJobs(workspaceId).catch(() => []),
      client.listWorkspaceSessions(workspaceId).catch(() => []),
    ]);

    if (argv.json) {
      // JSON output
      console.log(
        JSON.stringify(
          {
            id: workspace.id,
            name: workspace.name,
            description: workspace.description,
            path: workspace.path,
            status: workspace.status,
            hasActiveRuntime: workspace.hasActiveRuntime,
            runtime: workspace.runtime,
            createdAt: workspace.createdAt,
            lastSeen: workspace.lastSeen,
            agents: {
              count: agents.length,
              list: agents,
            },
            signals: {
              count: signals.length,
              list: signals,
            },
            jobs: {
              count: jobs.length,
              list: jobs,
            },
            sessions: {
              count: sessions.length,
              active: sessions,
            },
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
    } else {
      // Render with Ink
      render(
        <WorkspaceStatusCommand
          workspace={workspace}
          agents={agents}
          signals={signals}
          jobs={jobs}
          sessions={sessions}
        />,
      );
    }
  } catch (error) {
    console.error(
      `Error: ${error instanceof Error ? error.message : String(error)}`,
    );
    Deno.exit(1);
  }
};

// Component that displays workspace status
function WorkspaceStatusCommand({
  workspace,
  agents,
  signals,
  jobs,
  sessions,
}: {
  workspace: any;
  agents: any[];
  signals: any[];
  jobs: any[];
  sessions: any[];
}) {
  const statusColor = workspace.status === "running" || workspace.hasActiveRuntime
    ? "green"
    : workspace.status === "stopped"
    ? "yellow"
    : "red";

  return (
    <Box flexDirection="column" paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          Workspace Status
        </Text>
      </Box>

      <Box flexDirection="column" gap={1}>
        <Box>
          <Text bold>Name:</Text>
          <Text>{workspace.name}</Text>
        </Box>

        <Box>
          <Text bold>ID:</Text>
          <Text dimColor>{workspace.id}</Text>
        </Box>

        {workspace.description && (
          <Box>
            <Text bold>Description:</Text>
            <Text>{workspace.description}</Text>
          </Box>
        )}

        <Box>
          <Text bold>Path:</Text>
          <Text>{workspace.path}</Text>
        </Box>

        <Box>
          <Text bold>Status:</Text>
          <Text color={statusColor}>
            {workspace.status}
          </Text>
        </Box>

        <Box>
          <Text bold>Runtime Active:</Text>
          <Text color={workspace.hasActiveRuntime ? "green" : "red"}>
            {workspace.hasActiveRuntime ? "Yes" : "No"}
          </Text>
        </Box>

        {workspace.runtime && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Runtime Details:</Text>
            <Box paddingLeft={2}>
              <Text>
                Status: <Text color="green">{workspace.runtime.status}</Text>
              </Text>
            </Box>
            <Box paddingLeft={2}>
              <Text>Started: {new Date(workspace.runtime.startedAt).toLocaleString()}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text>Sessions: {workspace.runtime.sessions}</Text>
            </Box>
            <Box paddingLeft={2}>
              <Text>Workers: {workspace.runtime.workers}</Text>
            </Box>
          </Box>
        )}

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Configuration:</Text>
          <Box paddingLeft={2}>
            <Text>Agents: {agents.length}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>Signals: {signals.length}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>Jobs: {jobs.length}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>Active Sessions: {sessions.length}</Text>
          </Box>
        </Box>

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Timestamps:</Text>
          <Box paddingLeft={2}>
            <Text>Created: {new Date(workspace.createdAt).toLocaleString()}</Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>Last Seen: {new Date(workspace.lastSeen).toLocaleString()}</Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
