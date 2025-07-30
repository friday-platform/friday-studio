import { z } from "zod/v4";
import { tool } from "ai";
import type {
  JobSpecification,
  MCPServerConfig,
  WorkspaceAgentConfig,
  WorkspaceSignalConfig,
} from "@atlas/config";
import { WorkspaceBuilder } from "../workspace-creation/builder.ts";
import { resourceTools } from "../resources.ts";

// Create singleton instance that tools will share - this will be initialized with existing config
let workspaceUpdateBuilder: WorkspaceBuilder | null = null;

export function initializeUpdateBuilder(builder: WorkspaceBuilder): void {
  workspaceUpdateBuilder = builder;
}

export function getUpdateBuilder(): WorkspaceBuilder {
  if (!workspaceUpdateBuilder) {
    throw new Error(
      "Workspace update builder not initialized. This indicates a bug in the update process.",
    );
  }
  return workspaceUpdateBuilder;
}

export const workspaceUpdateTools = {
  // Include resource reading capability for accessing Atlas documentation
  ...resourceTools,

  // Include existing creation tools (for adding new components)
  initializeWorkspace: tool({
    description: "DEPRECATED in update mode - workspace already initialized",
    inputSchema: z.object({
      name: z.string(),
      description: z.string(),
    }),
    execute: () => {
      throw new Error(
        "initializeWorkspace is not available in update mode - workspace already initialized",
      );
    },
  }),

  // New query tool for understanding current workspace state
  listWorkspaceComponents: tool({
    description: "List all current workspace components (signals, agents, jobs, MCP servers)",
    inputSchema: z.object({}),
    execute: () => {
      const builder = getUpdateBuilder();
      const config = builder.exportConfig();

      const components = {
        signals: Object.keys(config.signals || {}).map((id) => ({
          id,
          type: config.signals![id].provider,
          description: config.signals![id].description,
        })),
        agents: Object.keys(config.agents || {}).map((id) => ({
          id,
          type: config.agents![id].type,
          description: config.agents![id].description,
        })),
        jobs: Object.keys(config.jobs || {}).map((id) => ({
          id,
          signal: config.jobs![id].triggers[0]?.signal,
          agents: config.jobs![id].execution.agents,
          description: config.jobs![id].description,
        })),
        mcpServers: config.tools?.mcp?.servers
          ? Object.keys(config.tools.mcp.servers).map((id) => ({
            id,
            transport: config.tools!.mcp!.servers![id].transport.type,
            tools: config.tools!.mcp!.servers![id].tools?.allow?.length || 0,
          }))
          : [],
      };

      return {
        status: "listed",
        message:
          `Found ${components.signals.length} signals, ${components.agents.length} agents, ${components.jobs.length} jobs, ${components.mcpServers.length} MCP servers`,
        components,
      };
    },
  }),

  // Update tools for existing components
  updateSignal: tool({
    description: "Update an existing signal's configuration",
    inputSchema: z.object({
      signalId: z.string().describe("ID of the existing signal to update"),
      updates: z.object({
        description: z.string().optional().describe("New description for the signal"),
        schedule: z.string().optional().describe("New cron schedule (for schedule signals only)"),
        timezone: z.string().optional().describe("New timezone (for schedule signals only)"),
        path: z.string().optional().describe("New webhook path (for webhook signals only)"),
      }).describe("Signal configuration updates to apply"),
    }),
    execute: ({ signalId, updates }) => {
      const builder = getUpdateBuilder();
      const result = builder.updateSignal(signalId, updates);
      if (!result.success) {
        throw new Error(`Signal update failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "updated",
        signalId,
        message: `Signal '${signalId}' updated successfully`,
        updatedFields: Object.keys(updates),
      };
    },
  }),

  updateAgent: tool({
    description: "Update an existing agent's configuration",
    inputSchema: z.object({
      agentId: z.string().describe("ID of the existing agent to update"),
      updates: z.object({
        description: z.string().optional().describe("New description for the agent"),
        prompt: z.string().optional().describe("New system prompt (for LLM agents only)"),
        model: z.string().optional().describe("New model identifier (for LLM agents only)"),
        temperature: z.number().min(0).max(1).optional().describe(
          "New temperature setting (for LLM agents only)",
        ),
        tools: z.array(z.string()).optional().describe(
          "New array of MCP server names (for LLM agents only)",
        ),
        endpoint: z.string().url().optional().describe("New endpoint URL (for remote agents only)"),
        agentName: z.string().optional().describe("New agent name (for remote agents only)"),
        defaultMode: z.enum(["sync", "async", "stream"]).optional().describe(
          "New default mode (for remote agents only)",
        ),
      }).describe("Agent configuration updates to apply"),
    }),
    execute: ({ agentId, updates }) => {
      const builder = getUpdateBuilder();
      const result = builder.updateAgent(agentId, updates);
      if (!result.success) {
        throw new Error(`Agent update failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "updated",
        agentId,
        message: `Agent '${agentId}' updated successfully`,
        updatedFields: Object.keys(updates),
      };
    },
  }),

  updateJob: tool({
    description: "Update an existing job's configuration",
    inputSchema: z.object({
      jobId: z.string().describe("ID of the existing job to update"),
      updates: z.object({
        description: z.string().optional().describe("New description for the job"),
        triggerSignal: z.string().optional().describe("New signal that triggers this job"),
        agents: z.array(z.string()).optional().describe("New array of agent IDs for execution"),
        strategy: z.enum(["sequential", "parallel"]).optional().describe("New execution strategy"),
      }).describe("Job configuration updates to apply"),
    }),
    execute: ({ jobId, updates }) => {
      const builder = getUpdateBuilder();
      const result = builder.updateJob(jobId, updates);
      if (!result.success) {
        throw new Error(`Job update failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "updated",
        jobId,
        message: `Job '${jobId}' updated successfully`,
        updatedFields: Object.keys(updates),
      };
    },
  }),

  // Removal tools
  removeSignal: tool({
    description: "Remove an existing signal and handle dependent jobs",
    inputSchema: z.object({
      signalId: z.string().describe("ID of the signal to remove"),
    }),
    execute: ({ signalId }) => {
      const builder = getUpdateBuilder();
      const result = builder.removeSignal(signalId);
      if (!result.success) {
        throw new Error(`Signal removal failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "removed",
        signalId,
        message: `Signal '${signalId}' removed successfully`,
      };
    },
  }),

  removeAgent: tool({
    description: "Remove an existing agent and update job references",
    inputSchema: z.object({
      agentId: z.string().describe("ID of the agent to remove"),
    }),
    execute: ({ agentId }) => {
      const builder = getUpdateBuilder();
      const result = builder.removeAgent(agentId);
      if (!result.success) {
        throw new Error(`Agent removal failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "removed",
        agentId,
        message: `Agent '${agentId}' removed successfully`,
      };
    },
  }),

  removeJob: tool({
    description: "Remove an existing job",
    inputSchema: z.object({
      jobId: z.string().describe("ID of the job to remove"),
    }),
    execute: ({ jobId }) => {
      const builder = getUpdateBuilder();
      const result = builder.removeJob(jobId);
      if (!result.success) {
        throw new Error(`Job removal failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "removed",
        jobId,
        message: `Job '${jobId}' removed successfully`,
      };
    },
  }),

  // Addition tools (reuse existing creation tools for new components)
  addScheduleSignal: tool({
    description: "Add schedule-based signal for cron triggers",
    inputSchema: z.object({
      signalName: z.string().describe(
        "Unique signal identifier within workspace, e.g., 'check_nike', 'daily_report', 'sync_customers'",
      ),
      description: z.string().describe(
        "Human-readable description of what this signal does, e.g., 'Check Nike for new shoe releases', 'Generate daily sales report'",
      ),
      schedule: z.string().describe(
        "Cron expression defining when this signal triggers, e.g., '0 * * * *', '*/30 * * * *', '0 9 * * 1-5'",
      ),
      timezone: z.string().default("UTC").describe(
        "Timezone for schedule interpretation, e.g., 'UTC', 'America/New_York', 'Europe/London'",
      ),
    }),
    execute: ({ signalName, description, schedule, timezone }) => {
      const builder = getUpdateBuilder();
      const signalConfig: WorkspaceSignalConfig = {
        provider: "schedule",
        description,
        config: { schedule, timezone },
      };

      const result = builder.addSignal(signalName, signalConfig);
      if (!result.success) {
        throw new Error(`Schedule signal creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", signalName, message: `Schedule signal '${signalName}' added` };
    },
  }),

  addWebhookSignal: tool({
    description: "Add HTTP webhook signal that triggers jobs on incoming requests",
    inputSchema: z.object({
      signalName: z.string().describe(
        "Unique signal identifier within workspace, e.g., 'webhook_trigger', 'api_callback', 'form_submission'",
      ),
      description: z.string().describe(
        "Human-readable description of what this signal does, e.g., 'Handle incoming webhook from Stripe', 'Process form submissions'",
      ),
      path: z.string().describe(
        "URL path for the webhook endpoint, e.g., '/webhook/stripe', '/api/callback'",
      ),
    }),
    execute: ({ signalName, description, path }) => {
      const builder = getUpdateBuilder();
      const signalConfig: WorkspaceSignalConfig = {
        provider: "http",
        description,
        config: { path },
      };

      const result = builder.addSignal(signalName, signalConfig);
      if (!result.success) {
        throw new Error(`Webhook signal creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", signalName, message: `Webhook signal '${signalName}' added` };
    },
  }),

  addLLMAgent: tool({
    description: "Add AI agent using language models for processing and decision-making",
    inputSchema: z.object({
      agentId: z.string().describe(
        "Unique agent identifier within workspace, e.g., 'nike_analyzer', 'content_generator', 'data_processor'",
      ),
      description: z.string().describe(
        "What this agent does and its purpose, e.g., 'Analyze Nike products for hype level', 'Generate marketing content'",
      ),
      provider: z.enum(["anthropic", "openai", "google"]).describe(
        "LLM provider for this agent",
      ),
      model: z.string().default("claude-3-5-sonnet-latest").describe(
        "Model identifier from the selected provider, e.g., 'claude-3-5-sonnet-latest', 'gpt-4', 'gemini-pro'",
      ),
      prompt: z.string().describe(
        "System prompt that defines the agent's behavior and capabilities, e.g., 'You analyze Nike products for hype potential...', 'You generate engaging social media content...'",
      ),
      tools: z.array(z.string()).default([]).describe(
        "Array of external MCP server names available to this agent, e.g., ['github'], ['slack']. Atlas tools are automatically available.",
      ),
      temperature: z.number().min(0).max(1).default(0.3).describe(
        "Controls randomness in model responses (0=deterministic, 1=creative)",
      ),
    }),
    execute: ({ agentId, description, provider, model, prompt, tools, temperature }) => {
      const builder = getUpdateBuilder();
      const agentConfig: WorkspaceAgentConfig = {
        type: "llm",
        description,
        config: {
          provider,
          model,
          prompt,
          tools,
          temperature,
        },
      };

      const result = builder.addAgent(agentId, agentConfig);
      if (!result.success) {
        throw new Error(`LLM agent creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", agentId, message: `LLM agent '${agentId}' added` };
    },
  }),

  addRemoteAgent: tool({
    description: "Add a remote agent that connects to external services via ACP protocol",
    inputSchema: z.object({
      agentId: z.string().describe(
        "Unique agent identifier within workspace, e.g., 'external_api', 'third_party_service'",
      ),
      description: z.string().describe(
        "What this agent does and its purpose, e.g., 'Connect to external API service', 'Interface with third-party system'",
      ),
      endpoint: z.string().url().describe(
        "URL endpoint for the remote agent",
      ),
      agentName: z.string().describe(
        "Agent name on the remote system (lowercase with hyphens)",
      ),
      defaultMode: z.enum(["sync", "async", "stream"]).default("async").describe(
        "Default communication mode with the remote agent",
      ),
    }),
    execute: ({ agentId, description, endpoint, agentName, defaultMode }) => {
      const builder = getUpdateBuilder();
      const agentConfig: WorkspaceAgentConfig = {
        type: "remote",
        description,
        config: {
          protocol: "acp",
          endpoint,
          agent_name: agentName,
          default_mode: defaultMode,
          health_check_interval: "30s",
          max_retries: 2,
        },
      };

      const result = builder.addAgent(agentId, agentConfig);
      if (!result.success) {
        throw new Error(`Remote agent creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", agentId, message: `Remote agent '${agentId}' added` };
    },
  }),

  createJob: tool({
    description: "Create a job that connects signals to agents in an execution pipeline",
    inputSchema: z.object({
      jobName: z.string().regex(/^[a-zA-Z0-9_-]+$/).describe(
        "Unique job name following MCP naming conventions (letters, numbers, underscores, and hyphens)",
      ),
      description: z.string().optional().describe(
        "Optional description of what this job does",
      ),
      triggerSignal: z.string().describe(
        "Name of the signal that triggers this job",
      ),
      agents: z.array(z.string()).min(1).describe(
        "Array of agent IDs that will execute in sequence",
      ),
      strategy: z.enum(["sequential", "parallel"]).default("sequential").describe(
        "Execution strategy for the agents",
      ),
    }),
    execute: ({ jobName, description, triggerSignal, agents, strategy }) => {
      const builder = getUpdateBuilder();
      const jobConfig: JobSpecification = {
        name: jobName,
        description,
        triggers: [{ signal: triggerSignal }],
        execution: {
          strategy,
          agents: agents,
        },
      };

      const result = builder.addJob(jobName, jobConfig);
      if (!result.success) {
        throw new Error(`Job creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "created", jobName, message: `Job '${jobName}' created successfully` };
    },
  }),

  addMCPIntegration: tool({
    description:
      "Add external MCP server integration for additional capabilities. Note: atlas-platform is automatically provided by the runtime.",
    inputSchema: z.object({
      serverName: z.string().describe(
        "MCP server identifier, e.g., 'github', 'slack', 'database_connector'. Atlas tools are automatically available.",
      ),
      command: z.string().describe(
        "Command to start the MCP server, e.g., 'deno'",
      ),
      args: z.array(z.string()).default([]).describe(
        "Additional arguments for the MCP server command",
      ),
      env: z.record(z.string(), z.string()).optional().describe(
        "Environment variables for the MCP server",
      ),
    }),
    execute: ({ serverName, command, args, env }) => {
      // CRITICAL: Prevent using this tool for atlas-platform
      if (serverName === "atlas-platform") {
        throw new Error(
          "atlas-platform is automatically provided by the Atlas runtime. " +
            "You don't need to add it manually. All Atlas tools (atlas_*, tavily_*) " +
            "will be available to your agents automatically.",
        );
      }

      const builder = getUpdateBuilder();
      const serverConfig: MCPServerConfig = {
        transport: {
          type: "stdio",
          command,
          args,
        },
        env,
      };

      const result = builder.addMCPIntegration(serverName, serverConfig);
      if (!result.success) {
        throw new Error(`MCP integration failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", serverName, message: `MCP integration '${serverName}' added` };
    },
  }),

  validateWorkspace: tool({
    description: "Validate the complete workspace configuration for errors",
    inputSchema: z.object({}),
    execute: () => {
      const builder = getUpdateBuilder();
      const result = builder.validateWorkspace();
      if (!result.success) {
        throw new Error(`Workspace validation failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "valid",
        message: "Workspace configuration is valid",
        warnings: result.warnings.length > 0 ? result.warnings : undefined,
      };
    },
  }),

  exportWorkspace: tool({
    description: "Export the final workspace configuration",
    inputSchema: z.object({}),
    execute: () => {
      const builder = getUpdateBuilder();
      try {
        const config = builder.exportConfig();
        return {
          status: "exported",
          message: "Workspace configuration exported successfully",
          config,
        };
      } catch (error) {
        throw new Error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  }),
};
