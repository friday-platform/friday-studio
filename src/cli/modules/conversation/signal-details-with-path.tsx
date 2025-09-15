import { getAtlasClient } from "@atlas/client";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { SignalDetails } from "../../components/signal-details.tsx";

interface SignalDetailsWithPathProps {
  workspaceId: string;
  signalId: string;
}

const SignalDetailsWithPath = ({ workspaceId, signalId }: SignalDetailsWithPathProps) => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const fetchWorkspacePath = async () => {
      try {
        const client = getAtlasClient();
        const workspacePath = await client.getWorkspacePath(workspaceId);
        setWorkspacePath(workspacePath);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    fetchWorkspacePath();
  }, [workspaceId]);

  if (loading) {
    return (
      <Box>
        <Text dimColor>Loading workspace information...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box>
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!workspacePath) {
    return (
      <Box>
        <Text color="red">Workspace path not found</Text>
      </Box>
    );
  }

  return (
    <SignalDetails workspaceId={workspaceId} signalId={signalId} workspacePath={workspacePath} />
  );
};
