import type {
  JobSpecification,
  MCPServerConfig,
  WorkspaceAgentConfig,
  WorkspaceSignalConfig,
} from "@atlas/config";
import { tool } from "ai";
import { z } from "zod/v4";
import { agentDiscoveryTool } from "./agent-discovery-tool.ts";
import { WorkspaceBuilder } from "./builder.ts";
import { mcpDiscoveryTool } from "./mcp-discovery-tool.ts";

// Lazy initialization to avoid circular import issues
let workspaceBuilderInstance: WorkspaceBuilder | undefined;

function getWorkspaceBuilder(): WorkspaceBuilder {
  if (!workspaceBuilderInstance) {
    workspaceBuilderInstance = new WorkspaceBuilder();
  }
  return workspaceBuilderInstance;
}

export { getWorkspaceBuilder as workspaceBuilder };

export const workspaceBuilderTools = {
  discoverAgent: agentDiscoveryTool,
  discoverMCPServer: mcpDiscoveryTool,

  initializeWorkspace: tool({
    description: "Initialize workspace with identity metadata",
    inputSchema: z.object({
      name: z
        .string()
        .describe(
          "Workspace name in kebab-case format, e.g., 'nike-shoe-monitor', 'stripe-hubspot-sync', 'daily-reports'",
        ),
      description: z
        .string()
        .describe(
          "Brief description of what this workspace automates, e.g., 'Monitor Nike for new shoe releases', 'Sync Stripe customers to HubSpot'",
        ),
    }),
    execute: ({ name, description }) => {
      // TypeScript ensures this matches expected identity structure
      const result = getWorkspaceBuilder().initialize({ name, description });
      if (!result.success) {
        throw new Error(`Workspace initialization failed: ${result.errors.join("; ")}`);
      }
      return { status: "initialized", message: `Workspace '${name}' initialized successfully` };
    },
  }),

  addScheduleSignal: tool({
    description: "Add schedule-based signal for cron triggers",
    inputSchema: z.object({
      signalName: z
        .string()
        .describe(
          "Unique signal identifier within workspace, e.g., 'check_nike', 'daily_report', 'sync_customers'",
        ),
      description: z
        .string()
        .describe(
          "Human-readable description of what this signal does, e.g., 'Check Nike for new shoe releases', 'Generate daily sales report'",
        ),
      schedule: z
        .string()
        .describe(
          "Cron expression defining when this signal triggers, e.g., '0 * * * *', '*/30 * * * *', '0 9 * * 1-5'",
        ),
      timezone: z
        .string()
        .default("UTC")
        .describe(
          "Timezone for schedule interpretation, e.g., 'UTC', 'America/New_York', 'Europe/London'",
        ),
    }),
    execute: ({ signalName, description, schedule, timezone }) => {
      // TypeScript ensures this matches WorkspaceSignalConfig exactly
      const signalConfig: WorkspaceSignalConfig = {
        provider: "schedule",
        description,
        config: { schedule, timezone },
      };

      const result = getWorkspaceBuilder().addSignal(signalName, signalConfig);
      if (!result.success) {
        throw new Error(`Schedule signal creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", signalName, message: `Schedule signal '${signalName}' added` };
    },
  }),

  addWebhookSignal: tool({
    description: "Add HTTP webhook signal that triggers jobs on incoming requests",
    inputSchema: z.object({
      signalName: z
        .string()
        .describe(
          "Unique signal identifier within workspace, e.g., 'webhook_trigger', 'api_callback', 'form_submission'",
        ),
      description: z
        .string()
        .describe(
          "Human-readable description of what this signal does, e.g., 'Handle incoming webhook from Stripe', 'Process form submissions'",
        ),
      path: z
        .string()
        .describe("URL path for the webhook endpoint, e.g., '/webhook/stripe', '/api/callback'"),
    }),
    execute: ({ signalName, description, path }) => {
      const signalConfig: WorkspaceSignalConfig = {
        provider: "http",
        description,
        config: { path },
      };

      const result = getWorkspaceBuilder().addSignal(signalName, signalConfig);
      if (!result.success) {
        throw new Error(`Webhook signal creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", signalName, message: `Webhook signal '${signalName}' added` };
    },
  }),

  addFileWatchSignal: tool({
    description: "Add filesystem watch signal that triggers jobs on file changes",
    inputSchema: z.object({
      signalName: z
        .string()
        .describe(
          "Unique signal identifier within workspace, e.g., 'content_watch', 'src_changes'",
        ),
      description: z
        .string()
        .describe("Human-readable description, e.g., 'Watch content directory for updates'"),
      path: z.string().describe("Path to watch (absolute or workspace-relative), e.g., 'content/'"),
      recursive: z
        .boolean()
        .optional()
        .default(true)
        .describe("Watch subdirectories (default true)"),
      include: z.array(z.string()).optional().describe("Optional include substring filters"),
      exclude: z.array(z.string()).optional().describe("Optional exclude substring filters"),
    }),
    execute: ({ signalName, description, path, recursive, include, exclude }) => {
      const signalConfig: WorkspaceSignalConfig = {
        provider: "fs-watch",
        description,
        config: { path, recursive, include, exclude },
      };

      const result = getWorkspaceBuilder().addSignal(signalName, signalConfig);
      if (!result.success) {
        throw new Error(`FS watch signal creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", signalName, message: `File watch signal '${signalName}' added` };
    },
  }),

  addLLMAgent: tool({
    description: "Add AI agent using language models for processing and decision-making",
    inputSchema: z.object({
      agentId: z
        .string()
        .describe(
          "Unique agent identifier within workspace, e.g., 'nike_analyzer', 'content_generator', 'data_processor'",
        ),
      description: z
        .string()
        .describe(
          "What this agent does and its purpose, e.g., 'Analyze Nike products for hype level', 'Generate marketing content'",
        ),
      provider: z.enum(["anthropic", "openai", "google"]).describe("LLM provider for this agent"),
      model: z
        .string()
        .default("claude-3-7-sonnet-latest")
        .describe(
          "Model identifier from the selected provider, e.g., 'claude-3-7-sonnet-latest', 'gpt-4', 'gemini-pro'",
        ),
      prompt: z
        .string()
        .describe(
          "System prompt that defines the agent's behavior and capabilities, e.g., 'You analyze Nike products for hype potential...', 'You generate engaging social media content...'",
        ),
      tools: z
        .array(z.string())
        .default([])
        .describe(
          "Additional MCP servers for this agent. Atlas tools are automatically available to all agents. Only specify external MCP servers like ['github'], ['slack'] if needed.",
        ),
      temperature: z
        .number()
        .min(0)
        .max(1)
        .default(0.3)
        .describe("Controls randomness in model responses (0=deterministic, 1=creative)"),
      tool_choice: z
        .enum(["auto", "required", "none"])
        .optional()
        .describe(
          "Tool usage strategy: 'auto' (LLM decides), 'required' (must use tools), 'none' (no tools). Use 'required' for agents that MUST use specific tools like email notifications.",
        ),
    }),
    execute: ({
      agentId,
      description,
      provider,
      model,
      prompt,
      tools,
      temperature,
      tool_choice,
    }) => {
      const agentConfig: WorkspaceAgentConfig = {
        type: "llm",
        description,
        config: { provider, model, prompt, tools, temperature, tool_choice },
      };

      const result = getWorkspaceBuilder().addAgent(agentId, agentConfig);
      if (!result.success) {
        throw new Error(`LLM agent creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", agentId, message: `LLM agent '${agentId}' added successfully` };
    },
  }),

  addRemoteAgent: tool({
    description: "Add a remote agent that connects to external services via ACP protocol",
    inputSchema: z.object({
      agentId: z
        .string()
        .describe(
          "Unique agent identifier within workspace, e.g., 'external_api', 'third_party_service'",
        ),
      description: z
        .string()
        .describe(
          "What this agent does and its purpose, e.g., 'Connect to external API service', 'Interface with third-party system'",
        ),
      endpoint: z.string().url().describe("URL endpoint for the remote agent"),
      agentName: z.string().describe("Agent name on the remote system (lowercase with hyphens)"),
      defaultMode: z
        .enum(["sync", "async", "stream"])
        .default("async")
        .describe("Default communication mode with the remote agent"),
    }),
    execute: ({ agentId, description, endpoint, agentName, defaultMode }) => {
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

      const result = getWorkspaceBuilder().addAgent(agentId, agentConfig);
      if (!result.success) {
        throw new Error(`Remote agent creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", agentId, message: `Remote agent '${agentId}' added` };
    },
  }),

  createJob: tool({
    description: "Create a job that connects signals to agents in an execution pipeline",
    inputSchema: z.object({
      jobName: z
        .string()
        .regex(/^[a-zA-Z0-9_-]+$/)
        .describe(
          "Unique job name following MCP naming conventions (letters, numbers, underscores, and hyphens)",
        ),
      description: z.string().optional().describe("Optional description of what this job does"),
      triggerSignal: z.string().describe("Name of the signal that triggers this job"),
      agents: z
        .array(z.string())
        .min(1)
        .describe("Array of agent IDs that will execute in sequence"),
      strategy: z
        .enum(["sequential", "parallel"])
        .default("sequential")
        .describe("Execution strategy for the agents"),
    }),
    execute: ({ jobName, description, triggerSignal, agents, strategy }) => {
      const jobConfig: JobSpecification = {
        name: jobName,
        description,
        triggers: [{ signal: triggerSignal }],
        execution: { strategy, agents: agents },
      };

      const result = getWorkspaceBuilder().addJob(jobName, jobConfig);
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
      serverName: z
        .string()
        .describe(
          "MCP server identifier, e.g., 'github', 'slack', 'database_connector'. Atlas tools are automatically available.",
        ),
      command: z.string().describe("Command to start the MCP server, e.g., 'deno'"),
      args: z
        .array(z.string())
        .default([])
        .describe("Additional arguments for the MCP server command"),
      env: z
        .record(z.string(), z.string())
        .optional()
        .describe("Environment variables for the MCP server"),
    }),
    execute: ({ serverName, command, args, env }) => {
      // CRITICAL: Prevent using this tool for atlas-platform
      if (serverName === "atlas-platform") {
        throw new Error(
          "atlas-platform is automatically provided by the Atlas runtime. " +
            "You don't need to add it manually. All Atlas tools " +
            "will be available to your agents automatically.",
        );
      }

      const serverConfig: MCPServerConfig = { transport: { type: "stdio", command, args }, env };

      const result = getWorkspaceBuilder().addMCPIntegration(serverName, serverConfig);
      if (!result.success) {
        throw new Error(`MCP integration failed: ${result.errors.join("; ")}`);
      }
      return { status: "added", serverName, message: `MCP integration '${serverName}' added` };
    },
  }),

  discoverAndAddMCPServers: tool({
    description:
      "Automatically discover and add suitable MCP servers based on workspace requirements. This ensures consistent MCP registry usage.",
    inputSchema: z.object({
      requirements: z
        .array(z.string())
        .describe(
          "List of capability requirements, e.g., ['GitHub repository management', 'Discord notifications', 'Stripe payment processing']",
        ),
    }),
    execute: async ({ requirements }) => {
      const result = await getWorkspaceBuilder().discoverAndAddMCPServers(requirements);
      if (!result.success) {
        throw new Error(`MCP discovery failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "discovered",
        message: "MCP server discovery completed",
        warnings: result.warnings,
        discoveredCount: result.warnings.filter((w) => w.includes("Auto-discovered")).length,
      };
    },
  }),

  validateWorkspace: tool({
    description: "Validate the complete workspace configuration for errors",
    inputSchema: z.object({}),
    execute: () => {
      const result = getWorkspaceBuilder().validateWorkspace();
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
      try {
        const config = getWorkspaceBuilder().exportConfig();
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
