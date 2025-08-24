import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { checkDaemonRunning, getDaemonClient } from "../utils/daemon-client.ts";
import { MarkdownDisplay } from "./markdown-display.tsx";

interface AgentDetailsProps {
  workspaceId: string;
  agentId: string;
}

const appendSection = (markdown: string, title: string, content: string): string => {
  return `${markdown}## ${title}\n\n${content}\n\n`;
};

interface AgentData {
  type: string;
  provider?: string;
  model?: string;
  purpose?: string;
  max_steps?: number;
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
    return jobs
      .filter((job: any) => {
        // This is a placeholder - the actual implementation would depend on
        // how the daemon API returns job execution details with agent references
        return job.agents?.includes(agentId) || job.agentIds?.includes(agentId);
      })
      .map((job: any) => ({
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
    return signals
      .filter((signal: any) => {
        // Placeholder logic - would need to be based on actual signal-job trigger relationships
        return jobsUsingAgent.some((job) => signal.triggers?.includes(job.id));
      })
      .map((signal: any) => ({
        id: signal.name,
        description: signal.description,
        provider: signal.provider,
      }));
  };

  if (loading) {
    return (
      <Box flexDirection="column">
        <Text dimColor>Loading agent details...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box flexDirection="column">
        <Text color="red">Error: {error}</Text>
      </Box>
    );
  }

  if (!agentData) {
    return (
      <Box flexDirection="column">
        <Text color="yellow">No agent data found</Text>
      </Box>
    );
  }

  // Build markdown content
  let markdown = `# ${agentId}\n\n`;

  // Basic Information
  let basicInfo = `Type: ${agentData.type}\n`;
  if (agentData.provider) {
    basicInfo += `Provider: ${agentData.provider}\n`;
  }
  if (agentData.model) {
    basicInfo += `Model: ${agentData.model}\n`;
  }
  if (agentData.purpose) {
    basicInfo += `Purpose: ${agentData.purpose}\n`;
  }
  if (agentData.max_steps) {
    basicInfo += `Max Steps: ${agentData.max_steps}\n`;
  }
  markdown = appendSection(markdown, "Basic Information", basicInfo);

  // Type-Specific Configuration
  if (agentData.type === "llm") {
    let llmConfig = "";
    if (agentData.tools && agentData.tools.length > 0) {
      llmConfig += "**Tools:**\n";
      agentData.tools.forEach((tool) => {
        llmConfig += `- ${tool}\n`;
      });
      llmConfig += "\n";
    }
    if (agentData.tools && typeof agentData.tools === "object" && agentData.tools.mcp) {
      const mcpServers = agentData.tools.mcp;
      if (Array.isArray(mcpServers) && mcpServers.length > 0) {
        llmConfig += "**MCP Servers:**\n";
        mcpServers.forEach((server) => {
          llmConfig += `- ${server}\n`;
        });
      }
    }
    if (llmConfig) {
      markdown = appendSection(markdown, "LLM Configuration", llmConfig);
    }
  }

  if (agentData.type === "tempest") {
    let tempestConfig = "";
    if (agentData.path) {
      tempestConfig += `Path: ${agentData.path}\n`;
    }
    if (tempestConfig) {
      markdown = appendSection(markdown, "Tempest Configuration", tempestConfig);
    }
  }

  if (agentData.type === "remote") {
    let remoteConfig = "";
    if (agentData.tools && agentData.tools.length > 0) {
      remoteConfig += "**Available Tools:**\n";
      agentData.tools.forEach((tool) => {
        remoteConfig += `- ${tool}\n`;
      });
      remoteConfig += "\n";
    }
    if (agentData.url) {
      remoteConfig += `URL: ${agentData.url}\n`;
    }
    if (agentData.timeout_ms) {
      remoteConfig += `Timeout: ${agentData.timeout_ms}ms\n`;
    }
    if (remoteConfig) {
      markdown = appendSection(markdown, "Remote Configuration", remoteConfig);
    }
  }

  // Prompts Section
  if (agentData.prompts && Object.keys(agentData.prompts).length > 0) {
    let promptsContent = "";
    Object.entries(agentData.prompts).forEach(([promptType, prompt]) => {
      promptsContent += `### ${promptType}\n\n`;
      const lines = prompt.split("\n");
      if (lines.length > 10) {
        promptsContent += lines.slice(0, 10).join("\n");
        promptsContent += `\n\n... (${lines.length - 10} more lines)\n\n`;
      } else {
        promptsContent += prompt + "\n\n";
      }
    });
    markdown = appendSection(markdown, "Prompts", promptsContent);
  }

  // Usage Section
  const jobsUsingAgent = getJobsUsingAgent(agentId);
  const signalsUsingAgent = getSignalsUsingAgent(agentId);

  if (jobsUsingAgent.length > 0 || signalsUsingAgent.length > 0) {
    let usageContent = "";

    if (jobsUsingAgent.length > 0) {
      usageContent += "**Used in Jobs:**\n\n";
      jobsUsingAgent.forEach((job) => {
        usageContent += `- ${job.name}\n`;
        if (job.description) {
          usageContent += `  ${job.description}\n`;
        }
      });
      usageContent += "\n";
    }

    if (signalsUsingAgent.length > 0) {
      usageContent += "**Triggered by Signals:**\n\n";
      signalsUsingAgent.forEach((signal) => {
        usageContent += `- ${signal.id} (${signal.provider})\n`;
        if (signal.description) {
          usageContent += `  ${signal.description}\n`;
        }
      });
    }

    markdown = appendSection(markdown, "Usage", usageContent);
  } else {
    markdown = appendSection(
      markdown,
      "Usage",
      "This agent is not currently used in any jobs or signals",
    );
  }

  // Raw Configuration
  const rawConfig = JSON.stringify(agentData, null, 2);
  markdown = appendSection(markdown, "Raw Configuration", `\`\`\`json\n${rawConfig}\n\`\`\``);

  return (
    <Box flexDirection="column">
      <MarkdownDisplay content={markdown} />
    </Box>
  );
};
