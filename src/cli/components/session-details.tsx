import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { checkDaemonRunning } from "../utils/daemon-client.ts";
import { getAtlasClient } from "@atlas/client";
import type { SessionDetailedInfo } from "@atlas/client";

interface SessionDetailsProps {
  sessionId: string;
}

// Helper function to format duration
const formatDuration = (startTime: string, endTime?: string): string => {
  const start = new Date(startTime);
  const end = endTime ? new Date(endTime) : new Date();
  const diffMs = end.getTime() - start.getTime();

  const minutes = Math.floor(diffMs / 60000);
  const seconds = Math.floor((diffMs % 60000) / 1000);

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
};

// Helper function to format timestamp
const formatTimestamp = (timestamp: string): string => {
  return new Date(timestamp).toLocaleString();
};

// Component to render artifacts
const ArtifactSection = ({ artifacts }: { artifacts: Array<{ type: string; data: unknown }> }) => {
  if (!artifacts || artifacts.length === 0) {
    return (
      <Box marginBottom={1}>
        <Text dimColor>No artifacts generated</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Artifacts ({artifacts.length}):</Text>
      </Box>
      {artifacts.map((artifact, index) => (
        <Box key={index} marginLeft={2} marginBottom={1}>
          <Box>
            <Text color="yellow">• {artifact.type}</Text>
          </Box>
          {artifact.data && (
            <Box marginLeft={2}>
              <Text dimColor>
                {typeof artifact.data === "string"
                  ? artifact.data
                  : JSON.stringify(artifact.data, null, 2)}
              </Text>
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
};

// Component to render results
const ResultsSection = ({ results }: { results?: unknown }) => {
  if (!results) {
    return (
      <Box marginBottom={1}>
        <Text dimColor>No results available</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box marginBottom={1}>
        <Text bold color="green">Results:</Text>
      </Box>
      <Box marginLeft={2}>
        <Text>
          {typeof results === "string" ? results : JSON.stringify(results, null, 2)}
        </Text>
      </Box>
    </Box>
  );
};

// Component to render progress bar
const ProgressBar = ({ progress }: { progress: number }) => {
  const width = 30;
  const filled = Math.round((progress / 100) * width);
  const empty = width - filled;

  const bar = "█".repeat(filled) + "░".repeat(empty);

  return (
    <Box>
      <Text color="green">[{bar}] {progress}%</Text>
    </Box>
  );
};

export const SessionDetails = ({ sessionId }: SessionDetailsProps) => {
  const [sessionData, setSessionData] = useState<SessionDetailedInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const loadSessionDetails = async () => {
      try {
        if (await checkDaemonRunning()) {
          const client = getAtlasClient();
          const sessionDetails = await client.getSession(sessionId);
          setSessionData(sessionDetails);
        } else {
          setError("Daemon not running. Use 'atlas daemon start' to enable session management.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    loadSessionDetails();
  }, [sessionId]);

  if (loading) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Text dimColor>Loading session details...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!sessionData) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Text color="yellow">No session data found</Text>
      </Box>
    );
  }

  // Get status color
  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case "running":
      case "active":
        return "green";
      case "completed":
      case "finished":
        return "blue";
      case "failed":
      case "error":
        return "red";
      case "cancelled":
      case "canceled":
        return "yellow";
      default:
        return "gray";
    }
  };

  return (
    <Box flexDirection="column" marginBottom={2}>
      {/* Session Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">Session: {sessionData.id}</Text>
      </Box>

      {/* Basic Information */}
      <Box flexDirection="column" marginBottom={2}>
        <Box marginBottom={1}>
          <Text dimColor>Workspace:</Text>
          <Text>{sessionData.workspaceId}</Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Status:</Text>
          <Text color={getStatusColor(sessionData.status)}>{sessionData.status}</Text>
        </Box>

        <Box marginBottom={1}>
          <Text dimColor>Signal:</Text>
          <Text color="yellow">{sessionData.signal}</Text>
        </Box>

        {sessionData.summary && (
          <Box marginBottom={1}>
            <Text dimColor>Summary:</Text>
            <Text>{sessionData.summary}</Text>
          </Box>
        )}
      </Box>

      {/* Progress */}
      <Box flexDirection="column" marginBottom={2}>
        <Box marginBottom={1}>
          <Text bold>Progress:</Text>
        </Box>
        <Box marginLeft={2}>
          <ProgressBar progress={sessionData.progress} />
        </Box>
      </Box>

      {/* Timing Information */}
      <Box flexDirection="column" marginBottom={2}>
        <Box marginBottom={1}>
          <Text bold>Timing:</Text>
        </Box>

        <Box marginLeft={2} marginBottom={1}>
          <Text dimColor>Started:</Text>
          <Text>{formatTimestamp(sessionData.startTime)}</Text>
        </Box>

        {sessionData.endTime && (
          <Box marginLeft={2} marginBottom={1}>
            <Text dimColor>Ended:</Text>
            <Text>{formatTimestamp(sessionData.endTime)}</Text>
          </Box>
        )}

        <Box marginLeft={2}>
          <Text dimColor>Duration:</Text>
          <Text>{formatDuration(sessionData.startTime, sessionData.endTime)}</Text>
        </Box>
      </Box>

      {/* Artifacts */}
      <Box flexDirection="column" marginBottom={2}>
        <Text bold>Artifacts:</Text>
        <ArtifactSection artifacts={sessionData.artifacts} />
      </Box>

      {/* Results */}
      <Box flexDirection="column" marginBottom={2}>
        <Text bold>Results:</Text>
        <ResultsSection results={sessionData.results} />
      </Box>
    </Box>
  );
};
