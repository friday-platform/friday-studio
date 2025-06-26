import { Box, Text, useInput } from "ink";
import { Select } from "@inkjs/ui";
import { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { checkDaemonRunning, getDaemonClient } from "../utils/daemon-client.ts";
import { fetchSessions } from "../modules/sessions/fetcher.ts";

interface SessionSelectionProps {
  workspaceId: string;
  onEscape: () => void;
  onSessionSelect: (sessionId: string) => void;
}

interface SessionEntry {
  id: string;
  name: string;
  status?: string;
  createdAt?: string;
}

export const SessionSelection = ({
  workspaceId,
  onEscape,
  onSessionSelect,
}: SessionSelectionProps) => {
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  useEffect(() => {
    const loadSessions = async () => {
      try {
        if (await checkDaemonRunning()) {
          const client = getDaemonClient();
          const workspace = await client.getWorkspace(workspaceId);
          if (!workspace) {
            throw new Error(`Workspace ${workspaceId} not found`);
          }

          const result = await fetchSessions({
            workspace: workspace.name,
            port: 8080,
          });

          if (result.success) {
            const sessionList = result.filteredSessions.map((session: any) => ({
              id: session.id,
              name: session.name || session.id,
              status: session.status,
              createdAt: session.createdAt,
            }));
            setSessions(sessionList);
          } else {
            throw new Error((result as any).error || "Failed to fetch sessions");
          }
        } else {
          setSessions([]);
          setError("Daemon not running. Use 'atlas daemon start' to enable session management.");
        }
        setError("");
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };
    loadSessions();
  }, [workspaceId]);

  // Handle escape key
  useInput((_input, key) => {
    if (key.escape) {
      onEscape();
      return;
    }
  });

  if (loading) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text dimColor>Loading sessions...</Text>
        </Box>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="red">Error: {error}</Text>
        </Box>
      </Box>
    );
  }

  if (!sessions || sessions.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="yellow">No sessions found</Text>
        </Box>
      </Box>
    );
  }

  // Create options for Select component
  const options = sessions.map((session) => ({
    label: session.status ? `${session.name} (${session.status})` : session.name,
    value: session.id,
  }));

  const handleSelect = (value: string) => {
    onSessionSelect(value);
  };

  return (
    <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
      <Box borderStyle="round" borderColor="gray" paddingX={1}>
        <Select options={options} onChange={handleSelect} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};
