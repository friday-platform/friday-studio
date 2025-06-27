import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { checkDaemonRunning } from "../utils/daemon-client.ts";
import { getAtlasClient } from "@atlas/client";
import type { JobDetailedInfo } from "@atlas/client";

interface JobDetailsProps {
  workspaceId: string;
  jobName: string;
  workspacePath: string;
}

export const JobDetails = ({ workspaceId, jobName, workspacePath }: JobDetailsProps) => {
  const [jobData, setJobData] = useState<JobDetailedInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const loadJobDetails = async () => {
      try {
        if (!workspaceId || !jobName) {
          setError(`Missing required parameters: workspaceId=${workspaceId}, jobName=${jobName}`);
          return;
        }

        if (!workspacePath) {
          setError("Workspace path is required for job details");
          return;
        }

        if (await checkDaemonRunning()) {
          const client = getAtlasClient();

          // Use the new client package method to get detailed job information
          const jobDetails = await client.describeJob(workspaceId, jobName, workspacePath);

          setJobData(jobDetails);
        } else {
          setError("Daemon not running. Use 'atlas daemon start' to enable job management.");
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    };

    loadJobDetails();
  }, [workspaceId, jobName, workspacePath]);

  if (loading) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Text dimColor>Loading job details...</Text>
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

  if (!jobData) {
    return (
      <Box flexDirection="column" marginBottom={2}>
        <Text color="yellow">No job data found</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginBottom={2}>
      {/* Job Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">{jobData.name}</Text>
      </Box>

      {/* Description */}
      {jobData.description && (
        <Box marginBottom={1}>
          <Text dimColor>{jobData.description}</Text>
        </Box>
      )}

      {/* Task Template */}
      {jobData.task_template && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Task Template:</Text>
          <Box marginLeft={2}>
            <Text>{jobData.task_template}</Text>
          </Box>
        </Box>
      )}

      {/* Triggers */}
      {jobData.triggers && jobData.triggers.length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Triggers:</Text>
          {jobData.triggers.map((trigger, index) => (
            <Box key={index} marginLeft={2}>
              <Text dimColor>Signal:</Text>
              <Text color="white">{trigger.signal}</Text>
              {trigger.condition && (
                <>
                  <Text dimColor>(Condition:</Text>
                  <Text color="gray">{trigger.condition}</Text>
                  <Text dimColor>)</Text>
                </>
              )}
            </Box>
          ))}
        </Box>
      )}

      {/* Execution Strategy */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="green">Execution:</Text>
        <Box marginLeft={2}>
          <Text dimColor>Strategy:</Text>
          <Text color="white">{jobData.execution.strategy}</Text>
        </Box>

        {/* Agents */}
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text dimColor>Agents ({jobData.execution.agents.length}):</Text>
          {jobData.execution.agents.map((agent, index) => (
            <Box key={index} marginLeft={2}>
              {typeof agent === "string" ? <Text>• {agent}</Text> : (
                <Box flexDirection="column">
                  <Text>• {agent.id}</Text>
                  {agent.task && (
                    <Box marginLeft={2}>
                      <Text dimColor>Task: {agent.task}</Text>
                    </Box>
                  )}
                  {agent.input_source && (
                    <Box marginLeft={2}>
                      <Text dimColor>Input: {agent.input_source}</Text>
                    </Box>
                  )}
                  {agent.dependencies && agent.dependencies.length > 0 && (
                    <Box marginLeft={2}>
                      <Text dimColor>Dependencies: {agent.dependencies.join(", ")}</Text>
                    </Box>
                  )}
                  {agent.tools && agent.tools.length > 0 && (
                    <Box marginLeft={2}>
                      <Text dimColor>Tools: {agent.tools.join(", ")}</Text>
                    </Box>
                  )}
                </Box>
              )}
            </Box>
          ))}
        </Box>
      </Box>

      {/* Context Configuration */}
      {jobData.execution.context && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Context:</Text>
          {jobData.execution.context.filesystem && (
            <Box flexDirection="column" marginLeft={2}>
              <Text dimColor>Filesystem:</Text>
              <Box marginLeft={2}>
                <Text dimColor>
                  Patterns: {jobData.execution.context.filesystem.patterns.join(", ")}
                </Text>
                {jobData.execution.context.filesystem.base_path && (
                  <Text dimColor>Base Path: {jobData.execution.context.filesystem.base_path}</Text>
                )}
                {jobData.execution.context.filesystem.max_file_size && (
                  <Text dimColor>
                    Max File Size: {jobData.execution.context.filesystem.max_file_size}
                  </Text>
                )}
                {jobData.execution.context.filesystem.include_content !== undefined && (
                  <Text dimColor>
                    Include Content:{" "}
                    {jobData.execution.context.filesystem.include_content ? "Yes" : "No"}
                  </Text>
                )}
              </Box>
            </Box>
          )}
          {jobData.execution.context.memory && (
            <Box flexDirection="column" marginLeft={2}>
              <Text dimColor>Memory:</Text>
              <Box marginLeft={2}>
                {jobData.execution.context.memory.recall_limit && (
                  <Text dimColor>
                    Recall Limit: {jobData.execution.context.memory.recall_limit}
                  </Text>
                )}
                {jobData.execution.context.memory.strategy && (
                  <Text dimColor>Strategy: {jobData.execution.context.memory.strategy}</Text>
                )}
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* Session Prompts */}
      {jobData.session_prompts &&
        (jobData.session_prompts.planning || jobData.session_prompts.evaluation) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Session Prompts:</Text>
          {jobData.session_prompts.planning && (
            <Box flexDirection="column" marginLeft={2}>
              <Text dimColor>Planning:</Text>
              <Box marginLeft={2}>
                <Text>{jobData.session_prompts.planning}</Text>
              </Box>
            </Box>
          )}
          {jobData.session_prompts.evaluation && (
            <Box flexDirection="column" marginLeft={2}>
              <Text dimColor>Evaluation:</Text>
              <Box marginLeft={2}>
                <Text>{jobData.session_prompts.evaluation}</Text>
              </Box>
            </Box>
          )}
        </Box>
      )}

      {/* Success Criteria */}
      {jobData.success_criteria && Object.keys(jobData.success_criteria).length > 0 && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Success Criteria:</Text>
          {Object.entries(jobData.success_criteria).map(([key, value]) => (
            <Box key={key} marginLeft={2}>
              <Text dimColor>{key}:</Text>
              <Text color="white">{String(value)}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Error Handling */}
      {jobData.error_handling && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Error Handling:</Text>
          <Box marginLeft={2}>
            {jobData.error_handling.max_retries && (
              <Text dimColor>Max Retries: {jobData.error_handling.max_retries}</Text>
            )}
            {jobData.error_handling.retry_delay_seconds && (
              <Text dimColor>Retry Delay: {jobData.error_handling.retry_delay_seconds}s</Text>
            )}
            {jobData.error_handling.timeout_seconds && (
              <Text dimColor>Timeout: {jobData.error_handling.timeout_seconds}s</Text>
            )}
            {jobData.error_handling.stage_failure_strategy && (
              <Text dimColor>
                Stage Failure Strategy: {jobData.error_handling.stage_failure_strategy}
              </Text>
            )}
          </Box>
        </Box>
      )}

      {/* Resources */}
      {jobData.resources && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Resources:</Text>
          <Box marginLeft={2}>
            {jobData.resources.estimated_duration_seconds && (
              <Text dimColor>
                Estimated Duration: {jobData.resources.estimated_duration_seconds}s
              </Text>
            )}
            {jobData.resources.max_memory_mb && (
              <Text dimColor>Max Memory: {jobData.resources.max_memory_mb}MB</Text>
            )}
            {jobData.resources.required_capabilities &&
              jobData.resources.required_capabilities.length > 0 && (
              <Text dimColor>
                Required Capabilities: {jobData.resources.required_capabilities.join(", ")}
              </Text>
            )}
            {jobData.resources.concurrent_agent_limit && (
              <Text dimColor>
                Concurrent Agent Limit: {jobData.resources.concurrent_agent_limit}
              </Text>
            )}
          </Box>
        </Box>
      )}

      {/* Execution Settings */}
      {(jobData.execution.timeout_seconds || jobData.execution.max_iterations) && (
        <Box flexDirection="column" marginBottom={1}>
          <Text bold color="green">Execution Settings:</Text>
          <Box marginLeft={2}>
            {jobData.execution.timeout_seconds && (
              <Text dimColor>Timeout: {jobData.execution.timeout_seconds}s</Text>
            )}
            {jobData.execution.max_iterations && (
              <Text dimColor>Max Iterations: {jobData.execution.max_iterations}</Text>
            )}
          </Box>
        </Box>
      )}
    </Box>
  );
};
