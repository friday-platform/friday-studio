import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { checkDaemonRunning, getDaemonClient } from "../utils/daemon-client.ts";

interface AgentDetailsProps {
  workspaceId: string;
  agentId: string;
}

interface AgentData {
  type: string;
  provider?: string;
  model?: string;
  purpose?: string;
  max_steps?: number;
  mcp_servers?: string[];
  tools?: string[];
  prompts?: Record<string, string>;
  path?: string;
  url?: string;
  timeout_ms?: number;
}

export const AgentDetails = ({ workspaceId, agentId }: AgentDetailsProps) => {
  const [agentData, setAgentData] = useState<AgentData | null>(null);
  const [jobs, setJobs] = useState<any[]>([]);
  const [signals, setSignals] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const loadAgentDetails = async () => {
      try {
        // Defensive checks
        if (!workspaceId || !agentId) {
          setError(`Missing required parameters: workspaceId=${workspaceId}, agentId=${agentId}`);
          return;
        }

        if (await checkDaemonRunning()) {
          const client = getDaemonClient();

          // Use daemon API to get agent details and related data
          const [agentDetails, jobsList, signalsList] = await Promise.all([
            client.describeAgent(workspaceId, agentId),
            client.listJobs(workspaceId).catch(() => []),
            client.listSignals(workspaceId).catch(() => []),
          ]);

          setAgentData(agentDetails as AgentData);
          setJobs(jobsList);
          setSignals(signalsList);
        } else {
          setError("Daemon not running. Use 'atlas daemon start' to enable agent management.");
        }
      } catch (err) {
        console.error("AgentDetails error:", err);
        console.error("WorkspaceId:", workspaceId);
        console.error("AgentId:", agentId);
        const errorMessage = err instanceof Error ? err.message : String(err);
        setError(`Failed to describe agent: ${errorMessage}`);
      } finally {
        setLoading(false);
      }
    };

    loadAgentDetails();
  }, [workspaceId, agentId]);

  // Helper function to find jobs that use this agent
  const getJobsUsingAgent = (agentId: string) => {
    if (!jobs || jobs.length === 0) return [];

    // For now, return a simplified version since we don't have the full job execution details
    // This would need to be enhanced based on the actual job data structure from the daemon API
    return jobs.filter((job: any) => {
      // This is a placeholder - the actual implementation would depend on
      // how the daemon API returns job execution details with agent references
      return job.agents?.includes(agentId) || job.agentIds?.includes(agentId);
    }).map((job: any) => ({
      id: job.name || job.id,
      name: job.name || job.id,
      description: job.description,
    }));
  };

  // Helper function to find signals that trigger jobs using this agent
  const getSignalsUsingAgent = (agentId: string) => {
    const jobsUsingAgent = getJobsUsingAgent(agentId);
    if (!signals || signals.length === 0 || jobsUsingAgent.length === 0) return [];

    // For now, return a simplified version
    // In a full implementation, this would need to query the daemon for signal-job relationships
    return signals.filter((signal: any) => {
      // Placeholder logic - would need to be based on actual signal-job trigger relationships
      return jobsUsingAgent.some((job) => signal.triggers?.includes(job.id));
    }).map((signal: any) => ({
      id: signal.name,
      description: signal.description,
      provider: signal.provider,
    }));
  };

  if (loading) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Text dimColor>Loading agent details...</Text>
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

  if (!agentData) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Text color="yellow">No agent data found</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={2}>
      {/* Agent Header */}
      <Box marginBottom={2}>
        <Text bold color="cyan">{agentId}</Text>
      </Box>

      {/* Basic Information */}
      <Box flexDirection="column" marginBottom={2}>
        <Box marginBottom={1}>
          <Text dimColor>Type:</Text>
          <Text>{agentData.type}</Text>
        </Box>
        {agentData.provider && (
          <Box marginBottom={1}>
            <Text dimColor>Provider:</Text>
            <Text>{agentData.provider}</Text>
          </Box>
        )}
        {agentData.model && (
          <Box marginBottom={1}>
            <Text dimColor>Model:</Text>
            <Text>{agentData.model}</Text>
          </Box>
        )}
        {agentData.purpose && (
          <Box marginBottom={1}>
            <Text dimColor>Purpose:</Text>
            <Text>{agentData.purpose}</Text>
          </Box>
        )}
        {agentData.max_steps && (
          <Box marginBottom={1}>
            <Text dimColor>Max Steps:</Text>
            <Text>{agentData.max_steps}</Text>
          </Box>
        )}
      </Box>

      {/* Type-Specific Configuration */}
      {agentData.type === "llm" && (
        <Box flexDirection="column" marginBottom={2}>
          <Box marginBottom={1}>
            <Text bold>LLM Configuration:</Text>
          </Box>
          {agentData.tools && agentData.tools.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>Tools:</Text>
              {agentData.tools.map((tool) => (
                <Box key={tool} marginLeft={2}>
                  <Text dimColor>•</Text>
                  <Text>{tool}</Text>
                </Box>
              ))}
            </Box>
          )}
          {agentData.mcp_servers && agentData.mcp_servers.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>MCP Servers:</Text>
              {agentData.mcp_servers.map((server) => (
                <Box key={server} marginLeft={2}>
                  <Text dimColor>•</Text>
                  <Text>{server}</Text>
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      {agentData.type === "tempest" && (
        <Box flexDirection="column" marginBottom={2}>
          <Box marginBottom={1}>
            <Text bold>Tempest Configuration:</Text>
          </Box>
          {agentData.path && (
            <Box marginBottom={1}>
              <Text dimColor>Path:</Text>
              <Text>{agentData.path}</Text>
            </Box>
          )}
        </Box>
      )}

      {agentData.type === "remote" && (
        <Box flexDirection="column" marginBottom={2}>
          <Box marginBottom={1}>
            <Text bold>Remote Configuration:</Text>
          </Box>
          {agentData.tools && agentData.tools.length > 0 && (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>Available Tools:</Text>
              {agentData.tools.map((tool) => (
                <Box key={tool} marginLeft={2}>
                  <Text dimColor>•</Text>
                  <Text>{tool}</Text>
                </Box>
              ))}
            </Box>
          )}
          {agentData.url && (
            <Box marginBottom={1}>
              <Text dimColor>URL:</Text>
              <Text>{agentData.url}</Text>
            </Box>
          )}
          {agentData.timeout_ms && (
            <Box marginBottom={1}>
              <Text dimColor>Timeout:</Text>
              <Text>{agentData.timeout_ms}ms</Text>
            </Box>
          )}
        </Box>
      )}

      {/* Prompts Section */}
      {agentData.prompts && Object.keys(agentData.prompts).length > 0 && (
        <Box flexDirection="column" marginBottom={2}>
          <Box marginBottom={1}>
            <Text bold>Prompts:</Text>
          </Box>
          {Object.entries(agentData.prompts).map(([promptType, prompt]) => (
            <Box key={promptType} flexDirection="column" marginBottom={2}>
              <Box marginBottom={1}>
                <Text dimColor>{promptType}:</Text>
              </Box>
              <Box marginLeft={2} flexDirection="column">
                {prompt.split("\n").slice(0, 10).map((line, index) => (
                  <Text key={index} dimColor>{line}</Text>
                ))}
                {prompt.split("\n").length > 10 && (
                  <Text dimColor>... ({prompt.split("\n").length - 10} more lines)</Text>
                )}
              </Box>
            </Box>
          ))}
        </Box>
      )}

      {/* Usage Section */}
      {(() => {
        const jobsUsingAgent = getJobsUsingAgent(agentId);
        const signalsUsingAgent = getSignalsUsingAgent(agentId);

        if (jobsUsingAgent.length > 0 || signalsUsingAgent.length > 0) {
          return (
            <Box flexDirection="column" marginBottom={2}>
              <Box marginBottom={1}>
                <Text bold>Usage:</Text>
              </Box>

              {jobsUsingAgent.length > 0 && (
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text dimColor>Used in Jobs:</Text>
                  </Box>
                  {jobsUsingAgent.map((job) => (
                    <Box key={job.id} marginLeft={2} marginBottom={1}>
                      <Box flexDirection="column">
                        <Box>
                          <Text dimColor>•</Text>
                          <Text bold>{job.name}</Text>
                        </Box>
                        {job.description && (
                          <Box marginLeft={2}>
                            <Text dimColor>{job.description}</Text>
                          </Box>
                        )}
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}

              {signalsUsingAgent.length > 0 && (
                <Box flexDirection="column" marginBottom={2}>
                  <Box marginBottom={1}>
                    <Text dimColor>Triggered by Signals:</Text>
                  </Box>
                  {signalsUsingAgent.map((signal) => (
                    <Box key={signal.id} marginLeft={2} marginBottom={1}>
                      <Box flexDirection="column">
                        <Box>
                          <Text dimColor>•</Text>
                          <Text bold>{signal.id}</Text>
                          <Text dimColor>({signal.provider})</Text>
                        </Box>
                        {signal.description && (
                          <Box marginLeft={2}>
                            <Text dimColor>{signal.description}</Text>
                          </Box>
                        )}
                      </Box>
                    </Box>
                  ))}
                </Box>
              )}
            </Box>
          );
        } else {
          return (
            <Box flexDirection="column" marginBottom={2}>
              <Box marginBottom={1}>
                <Text bold>Usage:</Text>
              </Box>
              <Box marginLeft={2}>
                <Text dimColor>
                  This agent is not currently used in any jobs or signals
                </Text>
              </Box>
            </Box>
          );
        }
      })()}

      {/* Raw Configuration (for debugging) */}
      <Box flexDirection="column" marginTop={2}>
        <Box marginBottom={1}>
          <Text bold>Raw Configuration:</Text>
        </Box>
        <Box marginLeft={2}>
          <Text dimColor>
            {JSON.stringify(agentData, null, 2)}
          </Text>
        </Box>
      </Box>
    </Box>
  );
};
