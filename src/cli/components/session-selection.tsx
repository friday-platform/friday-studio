import { Box, Text, useInput } from "ink";
import { Select } from "./select/index.ts";
import { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { checkDaemonRunning } from "../utils/daemon-client.ts";
import { getAtlasClient } from "@atlas/client";

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
          const client = getAtlasClient();
          const sessionList = await client.listWorkspaceSessions(workspaceId);

          const sessions = sessionList.map((session) => ({
            id: session.id,
            name: session.id, // WorkspaceSessionInfo doesn't have a name field
            status: session.status,
            createdAt: session.startedAt, // Use startedAt field from WorkspaceSessionInfo
          }));

          setSessions(sessions);
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
        <Select options={options} onChange={handleSelect} visibleOptionCount={8} />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Press Escape to go back</Text>
      </Box>
    </Box>
  );
};
