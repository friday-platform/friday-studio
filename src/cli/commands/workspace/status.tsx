import { Box, render, Text, useStdout } from "ink";
import React from "react";
import { createAtlasClient, type paths } from "@atlas/oapi-client";
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

// Extract response types from OpenAPI
type WorkspaceDetailsResponse =
  paths["/api/workspaces/{workspaceId}"]["get"]["responses"]["200"]["content"]["application/json"];

// Placeholder types for endpoints not yet migrated
interface WorkspaceAgent {
  id: string;
  name: string;
  type: string;
}

interface WorkspaceSignal {
  id: string;
  name: string;
  type: string;
}

interface WorkspaceJob {
  id: string;
  name: string;
  signals: string[];
}

interface WorkspaceSession {
  id: string;
  workspaceId: string;
  status: string;
  startedAt: string;
}

export const handler = async (argv: StatusArgs): Promise<void> => {
  try {
    const client = createAtlasClient();

    // Determine target workspace
    let workspaceId: string;

    if (argv.workspace) {
      // Use specified workspace - try to find by ID or name
      const getWorkspaceResult = await client.GET(
        "/api/workspaces/{workspaceId}",
        {
          params: {
            path: { workspaceId: argv.workspace },
          },
        },
      );

      if (getWorkspaceResult.data) {
        workspaceId = getWorkspaceResult.data.id;
      } else {
        // Try to find by name if ID lookup failed
        const listResult = await client.GET("/api/workspaces");

        if (listResult.error) {
          throw new Error(
            listResult.error.error || "Failed to list workspaces",
          );
        }

        const foundWorkspace = listResult.data?.find(
          (w) => w.name === argv.workspace,
        );
        if (foundWorkspace) {
          workspaceId = foundWorkspace.id;
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
        const listResult = await client.GET("/api/workspaces");

        if (listResult.error) {
          throw new Error(
            listResult.error.error || "Failed to list workspaces",
          );
        }

        const currentWorkspace = listResult.data?.find(
          (w) => w.name === currentWorkspaceName,
        );

        if (currentWorkspace) {
          workspaceId = currentWorkspace.id;
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

    // Get detailed workspace information from daemon
    const workspaceResult = await client.GET("/api/workspaces/{workspaceId}", {
      params: {
        path: { workspaceId },
      },
    });

    if (workspaceResult.error) {
      throw new Error(
        workspaceResult.error.error || "Failed to get workspace details",
      );
    }

    const workspace = workspaceResult.data;

    // Get additional workspace details - these endpoints aren't migrated yet so we'll stub them
    const agents: WorkspaceAgent[] = [];
    const signals: WorkspaceSignal[] = [];
    const jobs: WorkspaceJob[] = [];
    const sessions: WorkspaceSession[] = [];

    // TODO: Update these when their endpoints are migrated to OpenAPI
    // const [agents, signals, jobs, sessions] = await Promise.all([
    //   client.GET("/api/workspaces/{workspaceId}/agents", { params: { path: { workspaceId } } }),
    //   client.GET("/api/workspaces/{workspaceId}/signals", { params: { path: { workspaceId } } }),
    //   client.GET("/api/workspaces/{workspaceId}/jobs", { params: { path: { workspaceId } } }),
    //   client.GET("/api/workspaces/{workspaceId}/sessions", { params: { path: { workspaceId } } }),
    // ]);

    // Render appropriate view based on output format
    const { unmount } = render(
      argv.json
        ? (
          <JsonOutput
            workspace={workspace}
            agents={agents}
            signals={signals}
            jobs={jobs}
            sessions={sessions}
          />
        )
        : (
          <WorkspaceStatusCommand
            workspace={workspace}
            agents={agents}
            signals={signals}
            jobs={jobs}
            sessions={sessions}
          />
        ),
    );

    // Give a moment for render then exit
    setTimeout(() => {
      unmount();
    }, 100);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check for connection errors
    if (
      errorMessage.includes("Failed to fetch") ||
      errorMessage.includes("NetworkError")
    ) {
      console.error(
        "Error: Unable to connect to Atlas daemon. Make sure it's running with 'atlas daemon start'",
      );
    } else {
      console.error(`Error: ${errorMessage}`);
    }
    Deno.exit(1);
  }
};

// JSON output component using useStdout
function JsonOutput({
  workspace,
  agents,
  signals,
  jobs,
  sessions,
}: {
  workspace: WorkspaceDetailsResponse;
  agents: WorkspaceAgent[];
  signals: WorkspaceSignal[];
  jobs: WorkspaceJob[];
  sessions: WorkspaceSession[];
}) {
  const { write } = useStdout();

  React.useEffect(() => {
    const output = JSON.stringify(
      {
        id: workspace.id,
        name: workspace.name,
        description: workspace.description,
        path: workspace.path,
        status: workspace.status,
        hasActiveRuntime: workspace.runtime?.status === "running",
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
    );
    write(output);
  }, [workspace, agents, signals, jobs, sessions, write]);

  return null;
}

// Component that displays workspace status
function WorkspaceStatusCommand({
  workspace,
  agents,
  signals,
  jobs,
  sessions,
}: {
  workspace: WorkspaceDetailsResponse;
  agents: WorkspaceAgent[];
  signals: WorkspaceSignal[];
  jobs: WorkspaceJob[];
  sessions: WorkspaceSession[];
}) {
  const statusColor = workspace.status === "running"
    ? "green"
    : workspace.status === "stopped"
    ? "yellow"
    : workspace.status === "failed"
    ? "red"
    : "red";

  // Extract metadata for error display - it's directly on workspace now
  type WorkspaceWithErrorTracking = typeof workspace & {
    metadata?: {
      lastError?: string;
      lastErrorAt?: string;
      failureCount?: number;
    };
  };
  const metadata = (workspace as WorkspaceWithErrorTracking).metadata;

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
          <Text color={statusColor}>{workspace.status}</Text>
        </Box>

        <Box>
          <Text bold>Runtime Active:</Text>
          <Text color={workspace.status === "running" ? "green" : "red"}>
            {workspace.status === "running" ? "Yes" : "No"}
          </Text>
        </Box>

        {workspace.status === "failed" && metadata?.lastError && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="red">Failure Details:</Text>
            <Box paddingLeft={2} flexDirection="column">
              <Box>
                <Text>Error:</Text>
                <Text color="red">{metadata.lastError}</Text>
              </Box>
              {metadata.lastErrorAt && (
                <Box>
                  <Text>Failed at:</Text>
                  <Text dimColor>{new Date(metadata.lastErrorAt).toLocaleString()}</Text>
                </Box>
              )}
              {metadata.failureCount && (
                <Box>
                  <Text>Failure count:</Text>
                  <Text color="yellow">{metadata.failureCount}</Text>
                </Box>
              )}
            </Box>
          </Box>
        )}

        {workspace.runtime && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Runtime Details:</Text>
            <Box paddingLeft={2}>
              <Text>
                Status: <Text color="green">{workspace.runtime.status}</Text>
              </Text>
            </Box>
            <Box paddingLeft={2}>
              <Text>
                Started: {new Date(workspace.runtime.startedAt).toLocaleString()}
              </Text>
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
            <Text>
              Created: {new Date(workspace.createdAt).toLocaleString()}
            </Text>
          </Box>
          <Box paddingLeft={2}>
            <Text>
              Last Seen: {new Date(workspace.lastSeen).toLocaleString()}
            </Text>
          </Box>
        </Box>
      </Box>
    </Box>
  );
}
