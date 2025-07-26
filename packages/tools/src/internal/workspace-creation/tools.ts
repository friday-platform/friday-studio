import { z } from "zod/v4";
import { tool } from "ai";
import type {
  JobSpecification,
  MCPServerConfig,
  WorkspaceAgentConfig,
  WorkspaceSignalConfig,
} from "@atlas/config";
import { WorkspaceBuilder } from "./builder.ts";
import { resourceTools } from "../resources.ts";
import { getAtlasDaemonUrl } from "../../daemon/utils.ts";

// Create singleton instance that tools will share
const workspaceBuilder = new WorkspaceBuilder();

export { workspaceBuilder };

export const workspaceBuilderTools = {
  // Include resource reading capability for accessing Atlas documentation
  ...resourceTools,

  initializeWorkspace: tool({
    description: "Initialize workspace with identity metadata",
    inputSchema: z.object({
      name: z.string().describe(
        "Workspace name in kebab-case format, e.g., 'nike-shoe-monitor', 'stripe-hubspot-sync', 'daily-reports'",
      ),
      description: z.string().describe(
        "Brief description of what this workspace automates, e.g., 'Monitor Nike for new shoe releases', 'Sync Stripe customers to HubSpot'",
      ),
    }),
    execute: ({ name, description }) => {
      // TypeScript ensures this matches expected identity structure
      const result = workspaceBuilder.initialize({ name, description });
      if (!result.success) {
        throw new Error(`Workspace initialization failed: ${result.errors.join("; ")}`);
      }
      return { status: "initialized", message: `Workspace '${name}' initialized successfully` };
    },
  }),

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
      // TypeScript ensures this matches WorkspaceSignalConfig exactly
      const signalConfig: WorkspaceSignalConfig = {
        provider: "schedule",
        description,
        config: { schedule, timezone },
      };

      const result = workspaceBuilder.addSignal(signalName, signalConfig);
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
      const signalConfig: WorkspaceSignalConfig = {
        provider: "http",
        description,
        config: { path },
      };

      const result = workspaceBuilder.addSignal(signalName, signalConfig);
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
        "Array of MCP server names available to this agent, e.g., ['atlas-platform', 'github'], ['atlas-platform', 'slack']. Use 'atlas-platform' for Atlas internal tools.",
      ),
      temperature: z.number().min(0).max(1).default(0.3).describe(
        "Controls randomness in model responses (0=deterministic, 1=creative)",
      ),
    }),
    execute: ({ agentId, description, provider, model, prompt, tools, temperature }) => {
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

      const result = workspaceBuilder.addAgent(agentId, agentConfig);
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

      const result = workspaceBuilder.addAgent(agentId, agentConfig);
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
      const jobConfig: JobSpecification = {
        name: jobName,
        description,
        triggers: [{ signal: triggerSignal }],
        execution: {
          strategy,
          agents: agents,
        },
      };

      const result = workspaceBuilder.addJob(jobName, jobConfig);
      if (!result.success) {
        throw new Error(`Job creation failed: ${result.errors.join("; ")}`);
      }
      return { status: "created", jobName, message: `Job '${jobName}' created successfully` };
    },
  }),

  addAtlasPlatformMCP: tool({
    description: "Add atlas-platform MCP server with only the tools needed for this workspace",
    inputSchema: z.object({
      requiredTools: z.array(z.string()).describe(
        "Array of specific Atlas tools needed for this workspace. Available tools: " +
          "atlas_library_list, atlas_library_get, atlas_library_store, atlas_library_stats, atlas_library_templates, " +
          "atlas_workspace_list, atlas_workspace_create, atlas_workspace_delete, atlas_workspace_describe, " +
          "atlas_session_describe, atlas_session_cancel, atlas_jobs_list, atlas_jobs_describe, " +
          "atlas_signals_list, atlas_signals_trigger, atlas_agents_list, atlas_agents_describe, " +
          "atlas_glob, atlas_grep, atlas_ls, atlas_read, atlas_write, " +
          "tavily_search, tavily_extract, tavily_crawl, " +
          "atlas_bash, atlas_notify_email",
      ),
    }),
    execute: ({ requiredTools }) => {
      // Validate that all requested tools are available Atlas tools
      const availableAtlasTools = [
        "atlas_library_list",
        "atlas_library_get",
        "atlas_library_store",
        "atlas_library_stats",
        "atlas_library_templates",
        "atlas_workspace_list",
        "atlas_workspace_create",
        "atlas_workspace_delete",
        "atlas_workspace_describe",
        "atlas_session_describe",
        "atlas_session_cancel",
        "atlas_jobs_list",
        "atlas_jobs_describe",
        "atlas_signals_list",
        "atlas_signals_trigger",
        "atlas_agents_list",
        "atlas_agents_describe",
        "atlas_glob",
        "atlas_grep",
        "atlas_ls",
        "atlas_read",
        "atlas_write",
        "tavily_search",
        "tavily_extract",
        "tavily_crawl",
        "atlas_bash",
        "atlas_notify_email",
      ];

      const invalidTools = requiredTools.filter((tool) => !availableAtlasTools.includes(tool));
      if (invalidTools.length > 0) {
        throw new Error(
          `Invalid Atlas tools requested: ${invalidTools.join(", ")}. Available tools: ${
            availableAtlasTools.join(", ")
          }`,
        );
      }

      const serverConfig: MCPServerConfig = {
        transport: {
          type: "http",
          url: `${getAtlasDaemonUrl()}/mcp`,
        },
        tools: {
          allow: requiredTools,
        },
        client_config: {
          timeout: "30s",
        },
      };

      const result = workspaceBuilder.addMCPIntegration("atlas-platform", serverConfig);
      if (!result.success) {
        throw new Error(`Atlas-platform MCP integration failed: ${result.errors.join("; ")}`);
      }
      return {
        status: "added",
        serverName: "atlas-platform",
        toolsConfigured: requiredTools.length,
        message: `Atlas-platform MCP server added with ${requiredTools.length} tools: ${
          requiredTools.join(", ")
        }`,
      };
    },
  }),

  addMCPIntegration: tool({
    description: "Add external MCP server integration for additional capabilities",
    inputSchema: z.object({
      serverName: z.string().describe(
        "MCP server identifier, e.g., 'web_scraper', 'email_service', 'database_connector'",
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
      const serverConfig: MCPServerConfig = {
        transport: {
          type: "stdio",
          command,
          args,
        },
        env,
      };

      const result = workspaceBuilder.addMCPIntegration(serverName, serverConfig);
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
      const result = workspaceBuilder.validateWorkspace();
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
        const config = workspaceBuilder.exportConfig();
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
