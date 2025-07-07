import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { checkDaemonRunning } from "../utils/daemon-client.ts";
import { getAtlasClient } from "@atlas/client";
import type { JobDetailedInfo } from "@atlas/client";
import { MarkdownDisplay } from "./markdown-display.tsx";

interface JobDetailsProps {
  workspaceId: string;
  jobName: string;
  workspacePath: string;
}

const appendSection = (
  markdown: string,
  title: string,
  content: string,
): string => {
  return `${markdown}## ${title}\n\n${content}\n\n`;
};

export const JobDetails = ({
  workspaceId,
  jobName,
  workspacePath,
}: JobDetailsProps) => {
  const [jobData, setJobData] = useState<JobDetailedInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  useEffect(() => {
    const loadJobDetails = async () => {
      try {
        if (!workspaceId || !jobName) {
          setError(
            `Missing required parameters: workspaceId=${workspaceId}, jobName=${jobName}`,
          );
          return;
        }

        if (!workspacePath) {
          setError("Workspace path is required for job details");
          return;
        }

        if (await checkDaemonRunning()) {
          const client = getAtlasClient();

          // Use the new client package method to get detailed job information
          const jobDetails = await client.describeJob(
            workspaceId,
            jobName,
            workspacePath,
          );

          setJobData(jobDetails);
        } else {
          setError(
            "Daemon not running. Use 'atlas daemon start' to enable job management.",
          );
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

  // Build markdown content
  let markdown = `# ${jobData.name}\n\n`;

  if (jobData.description) {
    markdown += `${jobData.description}\n\n`;
  }

  if (jobData.task_template) {
    markdown = appendSection(markdown, "Task Template", jobData.task_template);
  }

  if (jobData.triggers && jobData.triggers.length > 0) {
    let triggersContent = "";
    jobData.triggers.forEach((trigger, index) => {
      triggersContent += `Signal: ${trigger.signal}\n`;
      if (trigger.condition) {
        if (typeof trigger.condition === "object") {
          const conditionStr = JSON.stringify(trigger.condition, null, 2);
          triggersContent += `Condition:\n\`\`\`\n${conditionStr}\n\`\`\`\n`;
        } else {
          triggersContent += `Condition: ${String(trigger.condition)}\n`;
        }
      }
      if (index < jobData.triggers.length - 1) triggersContent += "\n";
    });
    markdown = appendSection(markdown, "Triggers", triggersContent);
  }

  // Execution Strategy
  let executionContent = `**Strategy:** ${jobData.execution.strategy}\n\n`;
  executionContent += `**Agents (${jobData.execution.agents.length}):**\n`;
  jobData.execution.agents.forEach((agent) => {
    if (typeof agent === "string") {
      executionContent += `### ${agent}`;
    } else {
      executionContent += `### ${agent.id}\n`;
      if (agent.task) {
        executionContent += `Task: ${agent.task}\n`;
      }
      if (agent.input_source) {
        executionContent += `Input: ${agent.input_source}\n`;
      }
      if (agent.dependencies && agent.dependencies.length > 0) {
        executionContent += `Dependencies: ${agent.dependencies.join(", ")}\n`;
      }
      if (agent.tools && agent.tools.length > 0) {
        executionContent += `- Tools: ${agent.tools.join(", ")}\n`;
      }
    }
  });
  markdown = appendSection(markdown, "Execution", executionContent);

  // Context Configuration
  if (jobData.execution.context) {
    let contextContent = "";
    if (jobData.execution.context.filesystem) {
      contextContent += "**Filesystem:**\n";
      contextContent += `- Patterns: ${
        jobData.execution.context.filesystem.patterns.join(
          ", ",
        )
      }\n`;
      if (jobData.execution.context.filesystem.base_path) {
        contextContent += `- Base Path: ${jobData.execution.context.filesystem.base_path}\n`;
      }
      if (jobData.execution.context.filesystem.max_file_size) {
        contextContent +=
          `- Max File Size: ${jobData.execution.context.filesystem.max_file_size}\n`;
      }
      if (jobData.execution.context.filesystem.include_content !== undefined) {
        contextContent += `- Include Content: ${
          jobData.execution.context.filesystem.include_content ? "Yes" : "No"
        }\n`;
      }
    }
    if (jobData.execution.context.memory) {
      if (contextContent) contextContent += "\n";
      contextContent += "**Memory:**\n";
      if (jobData.execution.context.memory.recall_limit) {
        contextContent += `- Recall Limit: ${jobData.execution.context.memory.recall_limit}\n`;
      }
      if (jobData.execution.context.memory.strategy) {
        contextContent += `- Strategy: ${jobData.execution.context.memory.strategy}\n`;
      }
    }
    if (contextContent) {
      markdown = appendSection(markdown, "Context", contextContent);
    }
  }

  // Session Prompts
  if (
    jobData.session_prompts &&
    (jobData.session_prompts.planning || jobData.session_prompts.evaluation)
  ) {
    let promptsContent = "";
    if (jobData.session_prompts.planning) {
      promptsContent += `**Planning:**\n${jobData.session_prompts.planning}\n\n`;
    }
    if (jobData.session_prompts.evaluation) {
      promptsContent += `**Evaluation:**\n${jobData.session_prompts.evaluation}\n`;
    }
    markdown = appendSection(markdown, "Session Prompts", promptsContent);
  }

  // Success Criteria
  if (
    jobData.success_criteria &&
    Object.keys(jobData.success_criteria).length > 0
  ) {
    let criteriaContent = "";
    Object.entries(jobData.success_criteria).forEach(([key, value]) => {
      const valueStr = typeof value === "object" ? JSON.stringify(value) : String(value);
      criteriaContent += `- ${key}: ${valueStr}\n`;
    });
    markdown = appendSection(markdown, "Success Criteria", criteriaContent);
  }

  // Error Handling
  if (jobData.error_handling) {
    let errorContent = "";
    if (jobData.error_handling.max_retries) {
      errorContent += `- Max Retries: ${jobData.error_handling.max_retries}\n`;
    }
    if (jobData.error_handling.retry_delay_seconds) {
      errorContent += `- Retry Delay: ${jobData.error_handling.retry_delay_seconds}s\n`;
    }
    if (jobData.error_handling.timeout_seconds) {
      errorContent += `- Timeout: ${jobData.error_handling.timeout_seconds}s\n`;
    }
    if (jobData.error_handling.stage_failure_strategy) {
      errorContent +=
        `- Stage Failure Strategy: ${jobData.error_handling.stage_failure_strategy}\n`;
    }
    if (errorContent) {
      markdown = appendSection(markdown, "Error Handling", errorContent);
    }
  }

  // Resources
  if (jobData.resources) {
    let resourcesContent = "";
    if (jobData.resources.estimated_duration_seconds) {
      resourcesContent +=
        `- Estimated Duration: ${jobData.resources.estimated_duration_seconds}s\n`;
    }
    if (jobData.resources.max_memory_mb) {
      resourcesContent += `- Max Memory: ${jobData.resources.max_memory_mb}MB\n`;
    }
    if (
      jobData.resources.required_capabilities &&
      jobData.resources.required_capabilities.length > 0
    ) {
      resourcesContent += `- Required Capabilities: ${
        jobData.resources.required_capabilities.join(
          ", ",
        )
      }\n`;
    }
    if (jobData.resources.concurrent_agent_limit) {
      resourcesContent += `- Concurrent Agent Limit: ${jobData.resources.concurrent_agent_limit}\n`;
    }
    if (resourcesContent) {
      markdown = appendSection(markdown, "Resources", resourcesContent);
    }
  }

  // Execution Settings
  if (jobData.execution.timeout_seconds || jobData.execution.max_iterations) {
    let settingsContent = "";
    if (jobData.execution.timeout_seconds) {
      settingsContent += `- Timeout: ${jobData.execution.timeout_seconds}s\n`;
    }
    if (jobData.execution.max_iterations) {
      settingsContent += `- Max Iterations: ${jobData.execution.max_iterations}\n`;
    }
    markdown = appendSection(markdown, "Execution Settings", settingsContent);
  }

  return (
    <Box flexDirection="column" flexShrink={0}>
      <MarkdownDisplay content={markdown} />
    </Box>
  );
};
