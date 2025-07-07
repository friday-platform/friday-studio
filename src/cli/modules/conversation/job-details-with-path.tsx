import { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { getAtlasClient } from "@atlas/client";
import { JobDetails } from "../../components/job-details.tsx";

interface JobDetailsWithPathProps {
  workspaceId: string;
  jobName: string;
}

export const JobDetailsWithPath = ({
  workspaceId,
  jobName,
}: JobDetailsWithPathProps) => {
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
    <JobDetails
      workspaceId={workspaceId}
      jobName={jobName}
      workspacePath={workspacePath}
    />
  );
};
