import process from "node:process";
import { client, type InferResponseType, parseResult } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import { Box, render, Text, useStdout } from "ink";
import React from "react";

interface StatusArgs {
  json?: boolean;
  workspace: string;
}

type WorkspaceResponse = InferResponseType<(typeof client.workspace)[":workspaceId"]["$get"], 200>;

export const command = "status [workspace]";
export const desc = "Show workspace status and configuration";

export const builder = {
  workspace: {
    type: "string" as const,
    describe: "Workspace ID or name (defaults to current directory)",
  },
  json: { type: "boolean" as const, describe: "Output status information as JSON", default: false },
};

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
    // Get detailed workspace information from daemon
    const response = await parseResult(
      client.workspace[":workspaceId"].$get({ param: { workspaceId: argv.workspace } }),
    );

    if (!response.ok) {
      throw new Error(stringifyError(response.error) || "Failed to get workspace details");
    }

    // Get additional workspace details - these endpoints aren't migrated yet so we'll stub them
    const agents: WorkspaceAgent[] = [];
    const signals: WorkspaceSignal[] = [];
    const jobs: WorkspaceJob[] = [];
    const sessions: WorkspaceSession[] = [];

    // Render appropriate view based on output format
    const { unmount } = render(
      argv.json ? (
        <JsonOutput
          workspace={response.data}
          agents={agents}
          signals={signals}
          jobs={jobs}
          sessions={sessions}
        />
      ) : (
        <WorkspaceStatusCommand
          workspace={response.data}
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
    if (errorMessage.includes("Failed to fetch") || errorMessage.includes("NetworkError")) {
      console.error(
        "Error: Unable to connect to Atlas daemon. Make sure it's running with 'atlas daemon start'",
      );
    } else {
      console.error(`Error: ${errorMessage}`);
    }
    process.exit(1);
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
  workspace: WorkspaceResponse;
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
        path: workspace.path,
        status: workspace.status,
        hasActiveRuntime: workspace.status === "running",
        createdAt: workspace.createdAt,
        lastSeen: workspace.lastSeen,
        agents: { count: agents.length, list: agents },
        signals: { count: signals.length, list: signals },
        jobs: { count: jobs.length, list: jobs },
        sessions: { count: sessions.length, active: sessions },
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
  workspace: WorkspaceResponse;
  agents: WorkspaceAgent[];
  signals: WorkspaceSignal[];
  jobs: WorkspaceJob[];
  sessions: WorkspaceSession[];
}) {
  const statusColor =
    workspace.status === "running" ? "green" : workspace.status === "stopped" ? "gray" : "yellow";

  // Extract metadata for error display - it's directly on workspace now
  type WorkspaceWithErrorTracking = typeof workspace & {
    metadata?: { lastError?: string; lastErrorAt?: string; failureCount?: number };
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

        {String(workspace.status) === "inactive" && metadata?.lastError && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold color="yellow">
              Last Error:
            </Text>
            <Box paddingLeft={2} flexDirection="column">
              <Box>
                <Text>Error:</Text>
                <Text color="yellow">{metadata.lastError}</Text>
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

        <Box flexDirection="column" marginTop={1}>
          <Text bold>Runtime Details:</Text>
          <Box paddingLeft={2}>
            <Text>
              Status: <Text color="green">{workspace.status}</Text>
            </Text>
          </Box>
        </Box>

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
