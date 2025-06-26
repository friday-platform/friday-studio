import { useEffect, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { WorkspaceConfig } from "@atlas/types";
import { useActiveFocus, useTabNavigation } from "../tabs.tsx";
import { StatusBadge } from "../StatusBadge.tsx";
import { SidebarWrapper } from "../SidebarWrapper.tsx";

interface SessionsTabProps {
  config: WorkspaceConfig;
}

interface SessionData {
  id: string;
  workspaceName: string;
  signal: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  agents?: Array<{
    name: string;
    status: string;
    output?: string;
    error?: string;
  }>;
}

interface SessionDetails {
  id: string;
  workspaceName: string;
  signal: string;
  status: string;
  startedAt: string;
  completedAt?: string;
  agents?: Array<{
    name: string;
    status: string;
    output?: string;
    error?: string;
  }>;
}

export const SessionsTab = ({ config }: SessionsTabProps) => {
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [selectedSessionDetails, setSelectedSessionDetails] = useState<SessionDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [scrollOffset, setScrollOffset] = useState(0);

  // Use active focus to switch between sidebar and main area
  const { activeArea } = useActiveFocus({
    areas: ["sidebar", "main"],
    initialArea: 0,
  });

  const isSidebarActive = activeArea === 0;
  const isMainActive = activeArea === 1;

  // Use tab navigation for sessions with arrow key support when sidebar is active
  const { activeTab: selectedSessionIndex } = useTabNavigation({
    tabCount: sessions.length,
    initialTab: 0,
    useArrowKeys: true,
    isActive: isSidebarActive,
  });

  const selectedSession = sessions.length > 0 ? sessions[selectedSessionIndex] : null;

  // Fetch sessions list
  useEffect(() => {
    const fetchSessions = async () => {
      try {
        setLoading(true);
        const port = 8080; // Default port
        const response = await fetch(`http://localhost:${port}/sessions`);

        if (!response.ok) {
          if (
            response.status === 404 ||
            response.statusText.includes("Connection refused")
          ) {
            setSessions([]);
            setError("");
            return;
          }
          throw new Error(`Failed to fetch sessions: ${response.statusText}`);
        }

        const result = await response.json();
        const sessionsData = result.sessions || [];
        setSessions(sessionsData);
        setError("");
      } catch (err) {
        if (
          err instanceof Error &&
          err.message.includes("Connection refused")
        ) {
          setSessions([]);
          setError("");
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
  }, []);

  // Fetch selected session details
  useEffect(() => {
    const fetchSessionDetails = async () => {
      if (!selectedSession) {
        setSelectedSessionDetails(null);
        return;
      }

      try {
        const port = 8080;
        const response = await fetch(
          `http://localhost:${port}/sessions/${selectedSession.id}`,
        );

        if (!response.ok) {
          throw new Error(
            `Failed to fetch session details: ${response.statusText}`,
          );
        }

        const sessionDetails = await response.json();
        setSelectedSessionDetails(sessionDetails);
      } catch (err) {
        console.error("Error fetching session details:", err);
        // Fallback to basic session data
        setSelectedSessionDetails(selectedSession);
      }
    };

    fetchSessionDetails();
  }, [selectedSession]);

  // Handle keyboard navigation for scrolling when main area is active
  useInput((inputChar, key) => {
    if (isMainActive) {
      const scrollAmount = key.shift ? 10 : 1;

      if (key.upArrow || inputChar === "k") {
        setScrollOffset((prev) => Math.min(0, prev + scrollAmount));
      } else if (key.downArrow || inputChar === "j") {
        setScrollOffset((prev) => prev - scrollAmount);
      }

      // Handle vim keys with shift modifier for fast scrolling
      if (inputChar === "K") {
        setScrollOffset((prev) => Math.min(0, prev + 10));
      } else if (inputChar === "J") {
        setScrollOffset((prev) => prev - 10);
      }
    }
  });

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
        <Text dimColor>Error: {error}</Text>
      </Box>
    );
  }

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" padding={2}>
        <Text dimColor>No active sessions</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="row" height="100%" width="100%">
      {/* Sidebar */}
      <SidebarWrapper isActive={isSidebarActive}>
        {sessions.map((session, index) => (
          <Box key={session.id} marginBottom={1}>
            <Box flexDirection="column">
              <Box>
                <Text
                  bold={index === selectedSessionIndex}
                  dimColor={index !== selectedSessionIndex}
                >
                  {index === selectedSessionIndex ? "❯ " : "  "}
                  {session.id.substring(0, 12)}...
                </Text>
              </Box>
              <Box marginLeft={2}>
                <Text dimColor>{session.signal || "manual"}</Text>
              </Box>
              <Box marginLeft={2}>
                <StatusBadge status={session.status} />
              </Box>
            </Box>
          </Box>
        ))}
      </SidebarWrapper>

      {/* Main Area */}
      <Box
        flexDirection="column"
        flexGrow={1}
        paddingX={isMainActive ? 2 : 3}
        paddingY={isMainActive ? 1 : 2}
        overflow="hidden"
        borderStyle={isMainActive ? "round" : undefined}
        borderColor="gray"
        borderDimColor
      >
        {selectedSessionDetails
          ? (
            <Box
              flexDirection="column"
              marginTop={scrollOffset}
              flexGrow={1}
              flexShrink={0}
            >
              {/* Session Header */}
              <Box marginBottom={2}>
                <Text bold>Session Details</Text>
              </Box>

              <Box flexDirection="column" marginBottom={2}>
                <Box marginBottom={1}>
                  <Text dimColor>ID:</Text>
                  <Text>{selectedSessionDetails.id}</Text>
                </Box>
                <Box marginBottom={1}>
                  <Text dimColor>Workspace:</Text>
                  <Text>{selectedSessionDetails.workspaceName || "Unknown"}</Text>
                </Box>
                <Box marginBottom={1}>
                  <Text dimColor>Signal:</Text>
                  <Text>{selectedSessionDetails.signal || "manual"}</Text>
                </Box>
                <Box marginBottom={1}>
                  <Text dimColor>Status:</Text>
                  <StatusBadge status={selectedSessionDetails.status} />
                </Box>
                <Box marginBottom={1}>
                  <Text dimColor>Started At:</Text>
                  <Text>{formatTime(selectedSessionDetails.startedAt)}</Text>
                </Box>
                {selectedSessionDetails.completedAt && (
                  <Box marginBottom={1}>
                    <Text dimColor>Completed At:</Text>
                    <Text>{formatTime(selectedSessionDetails.completedAt)}</Text>
                  </Box>
                )}
                <Box marginBottom={1}>
                  <Text dimColor>Duration:</Text>
                  <Text>
                    {formatDuration(
                      selectedSessionDetails.startedAt,
                      selectedSessionDetails.completedAt,
                    )}
                  </Text>
                </Box>
              </Box>

              {/* Agents Section */}
              {selectedSessionDetails.agents &&
                selectedSessionDetails.agents.length > 0 && (
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text bold>Agents Executed:</Text>
                  </Box>
                  {selectedSessionDetails.agents.map((agent, index) => (
                    <Box key={index} flexDirection="column" marginBottom={2}>
                      <Box marginBottom={1}>
                        <Text dimColor>• {agent.name}</Text>
                        <Text dimColor>({agent.status})</Text>
                      </Box>
                      {agent.output && (
                        <Box
                          flexDirection="column"
                          marginLeft={2}
                          marginBottom={1}
                        >
                          <Text dimColor>Output:</Text>
                          <Box marginLeft={2}>
                            <Text>{agent.output}</Text>
                          </Box>
                        </Box>
                      )}
                      {agent.error && (
                        <Box
                          flexDirection="column"
                          marginLeft={2}
                          marginBottom={1}
                        >
                          <Text dimColor>Error:</Text>
                          <Box marginLeft={2}>
                            <Text dimColor>{agent.error}</Text>
                          </Box>
                        </Box>
                      )}
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          )
          : (
            <Box
              flexDirection="column"
              alignItems="center"
              justifyContent="center"
              height="100%"
            >
              <Text dimColor>Select a session to view details</Text>
            </Box>
          )}
      </Box>
    </Box>
  );
};

// Helper functions
function formatTime(timestamp: string): string {
  if (!timestamp) return "N/A";
  const date = new Date(timestamp);
  return date.toLocaleString();
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
