import { Box, Text } from "ink";
import { StatusBadge } from "../../components/StatusBadge.tsx";

export interface Session {
  id: string;
  workspaceName?: string;
  signal?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  agents?: Array<{ name: string; status: string }>;
}

// Helper functions
export function formatTime(timestamp: string): string {
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

export function formatDuration(start: string, end?: string): string {
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

export function calculateDuration(start: string, end?: string): number {
  if (!start) return 0;
  const startTime = new Date(start).getTime();
  const endTime = end ? new Date(end).getTime() : Date.now();
  return endTime - startTime;
}

export function formatSessionForJson(session: Session) {
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
export function SessionListComponent({
  sessions,
  workspaceName,
}: {
  sessions: Session[];
  workspaceName?: string;
}) {
  if (sessions.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          {workspaceName ? `Sessions in workspace: ${workspaceName}` : "Sessions"}
        </Text>
        <Text color="gray">No active sessions</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold color="cyan">
          {workspaceName
            ? `Sessions in workspace: ${workspaceName} (${sessions.length})`
            : `Sessions (${sessions.length})`}
        </Text>
      </Box>

      <Box>
        <Text bold color="cyan">
          SESSION ID
        </Text>
        <Text bold color="cyan">
          WORKSPACE
        </Text>
        <Text bold color="cyan">
          SIGNAL
        </Text>
        <Text bold color="cyan">
          STATUS
        </Text>
        <Text bold color="cyan">
          STARTED
        </Text>
        <Text bold color="cyan">
          DURATION
        </Text>
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
            <Text>
              {formatDuration(session.startedAt, session.completedAt)}
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
