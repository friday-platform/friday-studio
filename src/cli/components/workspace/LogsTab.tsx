import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { NewWorkspaceConfig } from "../../../core/config-loader.ts";
import { LogViewer } from "../LogViewer.tsx";
import { useActiveFocus, useTabNavigation } from "../tabs.tsx";

interface Session {
  id: string;
  workspaceName: string;
  signal?: string;
  status: string;
  startedAt: string;
  completedAt?: string;
}

interface LogsTabProps {
  config: NewWorkspaceConfig;
}

function formatSessionDisplay(session: Session): string {
  const signal = session.signal || "manual";
  const status = session.status;
  const shortId = session.id.substring(0, 8);
  return `${shortId} | ${signal} | ${status}`;
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

export const LogsTab = ({ config }: LogsTabProps) => {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  // Use active focus to switch between session list and logs viewer
  const { activeArea } = useActiveFocus({
    areas: ["sessions", "logs"],
    initialArea: 0,
  });

  const isSessionsActive = activeArea === 0;
  const isLogsActive = activeArea === 1;

  // Use tab navigation for session selection when sessions area is active
  const { activeTab: selectedSessionIndex } = useTabNavigation({
    tabCount: sessions.length,
    initialTab: 0,
    useArrowKeys: true,
    isActive: isSessionsActive,
  });

  const selectedSession = sessions.length > 0 ? sessions[selectedSessionIndex] : null;

  // Fetch sessions for this workspace
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        setLoading(true);
        const response = await fetch("http://localhost:8080/sessions");

        if (!response.ok) {
          throw new Error(`Failed to fetch sessions: ${response.statusText}`);
        }

        const result = await response.json();
        const allSessions = result.sessions || [];

        // Filter sessions for this workspace
        const workspaceSessions = allSessions.filter((session: Session) =>
          session.workspaceName === config.workspace.name
        );

        setSessions(workspaceSessions);
      } catch (err) {
        if (err instanceof Error && err.message.includes("Connection refused")) {
          setSessions([]);
        } else {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        setLoading(false);
      }
    };

    fetchSessions();

    // Refresh sessions every 5 seconds
    const interval = setInterval(fetchSessions, 5000);
    return () => clearInterval(interval);
  }, [config.workspace.name]);

  if (loading) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text>Loading sessions...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text color="gray">No sessions found for workspace: {config.workspace.name}</Text>
        <Text dimColor>Start a session by triggering a signal or running atlas commands</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" height="100%" width="100%">
      {/* Session List Sidebar */}
      <Box
        marginLeft={1}
        borderStyle={isSessionsActive ? "round" : undefined}
        borderColor={isSessionsActive ? "gray" : undefined}
        borderDimColor
        width="30%"
      >
        <Box flexDirection="column" paddingX={1} paddingY={1} flexShrink={0}>
          <Box marginBottom={1}>
            <Text bold>Sessions ({sessions.length})</Text>
          </Box>

          <Box flexDirection="column">
            {sessions.map((session, index) => (
              <Box key={session.id}>
                <Text
                  bold={index === selectedSessionIndex}
                  dimColor={index !== selectedSessionIndex}
                >
                  {index === selectedSessionIndex ? "❯ " : "  "}
                  {formatSessionDisplay(session)}
                </Text>
              </Box>
            ))}
          </Box>

          {selectedSession && (
            <Box marginTop={1} flexDirection="column">
              <Text dimColor>Duration:</Text>
              <Text>{formatDuration(selectedSession.startedAt, selectedSession.completedAt)}</Text>
            </Box>
          )}
        </Box>
      </Box>

      {/* Logs Viewer */}
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={2}
        paddingY={1}
        overflow="hidden"
        borderStyle={isLogsActive ? "round" : undefined}
        borderColor={isLogsActive ? "gray" : undefined}
        borderDimColor
      >
        {selectedSession
          ? (
            <Box flexDirection="column" height="100%">
              <Box marginBottom={1}>
                <Text bold>Session Logs: {selectedSession.id.substring(0, 12)}...</Text>
                <Text dimColor>
                  | {selectedSession.signal || "manual"} | {selectedSession.status}
                </Text>
              </Box>

              <LogViewer
                sessionId={selectedSession.id}
                follow={true}
                tail={100}
              />
            </Box>
          )
          : (
            <Box
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              height="100%"
            >
              <Text color="gray">Select a session to view logs</Text>
            </Box>
          )}
      </Box>
    </Box>
  );
};
