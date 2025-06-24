import { render } from "ink";
// deno-lint-ignore no-unused-vars
import React from "react";
import { Box, Text } from "ink";
import { StatusBadge } from "../../../cli/components/StatusBadge.tsx";

interface GetArgs {
  id: string;
  json?: boolean;
  port?: number;
}

interface SessionDetail {
  id: string;
  workspaceName?: string;
  signal?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  agents?: Array<{ name: string; status: string }>;
  context?: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export const command = "get <id>";
export const desc = "Get details for a specific session";
export const aliases = ["show", "describe"];

export const builder = {
  id: {
    type: "string" as const,
    describe: "Session ID to retrieve",
    demandOption: true,
  },
  json: {
    type: "boolean" as const,
    describe: "Output session details as JSON",
    default: false,
  },
  port: {
    type: "number" as const,
    alias: "p",
    describe: "Port of the workspace server",
    default: 8080,
  },
};

export const handler = async (argv: GetArgs): Promise<void> => {
  try {
    const port = argv.port || 8080;
    const response = await fetch(`http://localhost:${port}/sessions/${argv.id}`);

    if (!response.ok) {
      if (response.status === 404) {
        throw new Error(`Session '${argv.id}' not found`);
      }
      throw new Error(`Failed to fetch session: ${response.statusText}`);
    }

    const session = await response.json() as SessionDetail;

    if (argv.json) {
      // JSON output for scripting
      console.log(JSON.stringify(session, null, 2));
    } else {
      // Render with Ink
      render(<SessionDetailCommand session={session} />);
      // Exit immediately after rendering
      Deno.exit(0);
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    Deno.exit(1);
  }
};

// Component that renders the session details
function SessionDetailCommand({ session }: { session: SessionDetail }) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">Session Details</Text>
      <Text>━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━</Text>
      <Text>
        ID: <Text color="white">{session.id}</Text>
      </Text>
      <Text>
        Status: <StatusBadge status={session.status} />
      </Text>
      <Text>
        Workspace: <Text color="white">{session.workspaceName || "Unknown"}</Text>
      </Text>
      <Text>
        Signal: <Text color="white">{session.signal || "manual"}</Text>
      </Text>
      <Text>
        Started:{" "}
        <Text color="white">
          {new Date(session.startedAt).toLocaleString()}
        </Text>
      </Text>
      {session.completedAt && (
        <Text>
          Completed:{" "}
          <Text color="white">
            {new Date(session.completedAt).toLocaleString()}
          </Text>
        </Text>
      )}
      <Text>
        Duration:{" "}
        <Text color="white">
          {formatDuration(session.startedAt, session.completedAt)}
        </Text>
      </Text>

      {session.agents && session.agents.length > 0 && (
        <>
          <Text></Text>
          <Text bold>Agents Executed:</Text>
          {session.agents.map((agent, i) => (
            <Box key={i} marginLeft={1}>
              <Text>
                • {agent.name} <Text color="gray">({agent.status})</Text>
              </Text>
            </Box>
          ))}
        </>
      )}

      {session.error && (
        <>
          <Text></Text>
          <Text bold color="red">Error:</Text>
          <Box marginLeft={1}>
            <Text color="red">{session.error}</Text>
          </Box>
        </>
      )}

      {session.context && Object.keys(session.context).length > 0 && (
        <>
          <Text></Text>
          <Text bold>Context:</Text>
          <Box marginLeft={1}>
            <Text color="gray">{JSON.stringify(session.context, null, 2)}</Text>
          </Box>
        </>
      )}
    </Box>
  );
}

function formatDuration(start: string, end?: string): string {
  if (!start) return "N/A";
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  const durationMs = endTime - startTime;

  const seconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
