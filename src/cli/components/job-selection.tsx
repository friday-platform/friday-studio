import { getAtlasClient } from "@atlas/client";
import { parseResult, client as v2Client } from "@atlas/client/v2";
import { stringifyError } from "@atlas/utils";
import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { useResponsiveDimensions } from "../utils/useResponsiveDimensions.ts";
import { Select } from "./select/index.ts";

interface JobSelectionProps {
  workspaceId: string;
  onEscape: () => void;
  onJobSelect: (jobName: string) => void;
}

interface JobEntry {
  name: string;
  description?: string;
}

export const JobSelection = ({ workspaceId, onEscape, onJobSelect }: JobSelectionProps) => {
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const dimensions = useResponsiveDimensions({ minHeight: 24, padding: 1 });

  useEffect(() => {
    const loadJobs = async () => {
      try {
        const health = await parseResult(v2Client.health.index.$get());
        if (health.ok) {
          const client = getAtlasClient();

          // Use Atlas client API to get jobs directly
          const jobList = await client.listJobs(workspaceId);

          setJobs(jobList);
        } else {
          setJobs([]);
          setError("Daemon not running. Use 'atlas daemon start' to enable job management.");
        }
        setError("");
      } catch (error) {
        setError(stringifyError(error));
      } finally {
        setLoading(false);
      }
    };
    loadJobs();
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
          <Text dimColor>Loading jobs...</Text>
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

  if (!jobs || jobs.length === 0) {
    return (
      <Box flexDirection="column" marginTop={1} width={dimensions.paddedWidth}>
        <Box borderStyle="round" borderColor="gray" paddingX={1}>
          <Text color="yellow">No jobs found</Text>
        </Box>
      </Box>
    );
  }

  // Create options for Select component
  const options = jobs.map((job) => ({
    key: `job-${job.name}`,
    label: job.description ? `${job.name} - ${job.description}` : job.name,
    value: job.name,
  }));

  const handleSelect = (value: string) => {
    onJobSelect(value);
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
