import { render } from "ink";
// deno-lint-ignore no-unused-vars
import React from "react";
import { Box, Text } from "ink";
import { StatusBadge } from "../../../cli/components/StatusBadge.tsx";

interface ListArgs {
  json?: boolean;
  workspace?: string;
  port?: number;
}

interface Session {
  id: string;
  workspaceName?: string;
  signal?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  agents?: Array<{ name: string; status: string }>;
}

export const command = "list";
export const desc = "List active sessions";
export const aliases = ["ls"];

export const builder = {
  json: {
    type: "boolean" as const,
    describe: "Output session list as JSON",
    default: false,
  },
  workspace: {
    type: "string" as const,
    describe: "Filter sessions by workspace name",
  },
  port: {
    type: "number" as const,
    alias: "p",
    describe: "Port of the workspace server",
    default: 8080,
  },
};

export const handler = async (argv: ListArgs): Promise<void> => {
  try {
    const port = argv.port || 8080;
    const response = await fetch(`http://localhost:${port}/sessions`);

    if (!response.ok) {
      throw new Error(`Failed to fetch sessions: ${response.statusText}`);
    }

    const result = await response.json();
    const sessions = (result.sessions || []) as Session[];

    // Filter by workspace if specified
    const filteredSessions = argv.workspace
      ? sessions.filter((s) => s.workspaceName === argv.workspace)
      : sessions;

    if (argv.json) {
      // JSON output for scripting
      console.log(JSON.stringify(
        {
          sessions: filteredSessions.map(formatSessionForJson),
          count: filteredSessions.length,
        },
        null,
        2,
      ));
    } else {
      // Render with Ink
      render(<SessionListCommand sessions={filteredSessions} />);
      // Exit immediately after rendering
      Deno.exit(0);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Connection refused")) {
      // No server running
      if (argv.json) {
        console.log(JSON.stringify({ sessions: [], count: 0 }, null, 2));
      } else {
        console.error(
          "Error: No workspace server running. Start a workspace with 'atlas workspace serve'",
        );
      }
    } else {
      console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
    Deno.exit(1);
  }
};

function formatSessionForJson(session: Session) {
  return {
    id: session.id,
    workspace: session.workspaceName || "Unknown",
    signal: session.signal || "manual",
    status: session.status,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
    duration: calculateDuration(session.startedAt, session.completedAt),
    agents: session.agents,
  };
}

// Component that renders the session list
function SessionListCommand({ sessions }: { sessions: Session[] }) {
  if (sessions.length === 0) {
    return <Text color="gray">No active sessions</Text>;
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold color="cyan">SESSION ID</Text>
        <Text bold color="cyan">WORKSPACE</Text>
        <Text bold color="cyan">SIGNAL</Text>
        <Text bold color="cyan">STATUS</Text>
        <Text bold color="cyan">STARTED</Text>
        <Text bold color="cyan">DURATION</Text>
      </Box>
      <Text>
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      </Text>
      {sessions.map((session) => (
        <Box key={session.id}>
          <Box width={18}>
            <Text>{session.id.substring(0, 12) + "..."}</Text>
          </Box>
          <Box width={18}>
            <Text>{session.workspaceName || "Unknown"}</Text>
          </Box>
          <Box width={18}>
            <Text>{session.signal || "manual"}</Text>
          </Box>
          <Box width={11}>
            <StatusBadge status={session.status} />
          </Box>
          <Box width={12}>
            <Text>{formatTime(session.startedAt)}</Text>
          </Box>
          <Box width={11} justifyContent="flex-end">
            <Text>{formatDuration(session.startedAt, session.completedAt)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}

// Helper functions
function formatTime(timestamp: string): string {
  if (!timestamp) return "N/A";
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);

  if (diffMins < 1) return "just now";
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return date.toLocaleDateString();
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

function calculateDuration(start: string, end?: string): number {
  if (!start) return 0;
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  return endTime - startTime;
}
