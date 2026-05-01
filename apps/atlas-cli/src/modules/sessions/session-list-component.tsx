import { Box, Text } from "ink";
import { StatusBadge } from "../../components/status-badge.tsx";

export interface Session {
  id: string;
  workspaceName?: string;
  signal?: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  agents?: Array<{ name: string; status: string }>;
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
        <Box flexGrow={1}>
          <Text bold color="cyan">
            SESSION ID
          </Text>
        </Box>
        <Box width={18}>
          <Text bold color="cyan">
            WORKSPACE
          </Text>
        </Box>
        <Box width={18}>
          <Text bold color="cyan">
            SIGNAL
          </Text>
        </Box>
        <Box width={11}>
          <Text bold color="cyan">
            STATUS
          </Text>
        </Box>
        <Box width={12}>
          <Text bold color="cyan">
            STARTED
          </Text>
        </Box>
        <Box width={11} justifyContent="flex-end">
          <Text bold color="cyan">
            DURATION
          </Text>
        </Box>
      </Box>
      <Text>
        ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
      </Text>
      {sessions.map((session) => (
        <Box key={session.id}>
          <Box flexGrow={1}>
            <Text>{session.id}</Text>
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
            <Text>{formatTime(session.startedAt || "")}</Text>
          </Box>
          <Box width={11} justifyContent="flex-end">
            <Text>{formatDuration(session.startedAt || "", session.completedAt)}</Text>
          </Box>
        </Box>
      ))}
    </Box>
  );
}
