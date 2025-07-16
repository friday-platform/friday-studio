/**
 * Agent Execution Actor - Runs agents in main thread with direct function calls
 * Migrated from AgentExecutionWorker - preserves all functionality without worker complexity
 */

import { type ChildLogger, logger } from "../../utils/logger.ts";
import type { WorkspaceAgentConfig } from "../../../packages/config/src/schemas.ts";
import { getWorkspaceManager } from "../workspace-manager.ts";
import { SystemAgentRegistry } from "../system-agent-registry.ts";
import { RemoteAgent } from "../agents/remote/remote-agent.ts";
import type { AgentExecutePayload } from "../../types/messages.ts";

// Simple response wrapper - just for timing and error handling
interface AgentExecutionResult {
  output: unknown;
  duration: number;
}

export class AgentExecutionActor {
  private sessionId?: string;
  private workspaceId?: string;
  private logger: ChildLogger;
  private id: string;

  constructor(sessionId?: string, workspaceId?: string, id?: string) {
    this.id = id || crypto.randomUUID();
    this.sessionId = sessionId;
    this.workspaceId = workspaceId;

    // Initialize logger
    this.logger = logger.createChildLogger({
      actorId: this.id,
      actorType: "agent-execution",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    });
  }

  async initialize(): Promise<void> {
    this.logger.info("Agent execution actor initialized");
  }

  async executeTask(taskId: string, data: AgentExecutePayload): Promise<AgentExecutionResult> {
    const executionStart = Date.now();

    // Get workspace configuration transparently
    const workspaceConfig = await this.loadWorkspaceConfig();

    // Get agent config from workspace
    const agentConfig = workspaceConfig.agents?.[data.agent_id];
    if (!agentConfig) {
      throw new Error(
        `Agent configuration not found: ${data.agent_id} in workspace: ${
          this.workspaceId || "global"
        }`,
      );
    }

    // Dispatch based on agent type - simple orchestration
    let result: unknown;
    switch (agentConfig.type) {
      case "system": // System agents in schema
        result = await this.executeSystemAgent(agentConfig, data);
        break;
      case "llm":
        result = await this.executeLLMAgent(agentConfig, data);
        break;
      case "remote":
        result = await this.executeRemoteAgent(agentConfig, data);
        break;
      default:
        throw new Error(`Unsupported agent type: ${agentConfig.type}`);
    }

    const duration = Date.now() - executionStart;
    return { output: result, duration };
  }

  private async executeSystemAgent(
    agentConfig: WorkspaceAgentConfig,
    request: AgentExecutePayload,
  ): Promise<unknown> {
    // For system agents, the 'agent' field specifies which system agent to use
    const systemAgentId = (agentConfig as any).agent || request.agent_id;

    // Create system agent instance from registry
    // Pass the full agent config including tools, prompts, etc.
    const fullConfig = {
      ...agentConfig.config,
      tools: agentConfig.tools,
      prompts: agentConfig.prompts,
      model: agentConfig.model || agentConfig.config?.model,
      temperature: agentConfig.temperature || agentConfig.config?.temperature,
      max_tokens: agentConfig.max_tokens || agentConfig.config?.max_tokens,
    };

    const systemAgent = SystemAgentRegistry.createAgent(
      systemAgentId,
      fullConfig,
    );

    this.logger.debug(`Executing system agent: ${systemAgentId} (requested: ${request.agent_id})`);

    // Use invoke method from BaseAgent - pass input as-is for system agents
    return await systemAgent.invoke(request.input);
  }

  private async executeLLMAgent(
    agentConfig: WorkspaceAgentConfig,
    request: AgentExecutePayload,
  ): Promise<unknown> {
    this.logger.debug(`Executing LLM agent: ${request.agent_id}`, {
      provider: agentConfig.provider,
      model: agentConfig.model,
    });

    // Use existing LLM infrastructure directly - no need for wrapper class
    const { LLMProvider } = await import("@atlas/core");

    const systemPrompt = agentConfig.prompts?.system || "You are a helpful AI assistant.";

    // Handle different input types - convert to string for LLM processing
    let userPrompt: string;
    if (typeof request.input === "string") {
      userPrompt = request.input;
    } else if (typeof request.input === "object" && request.input !== null) {
      // If input is an object, use the task description as the primary prompt
      // and include the input data as context
      userPrompt = request.task || "Complete the requested task.";
      if (Object.keys(request.input).length > 0) {
        userPrompt += `\n\nContext data: ${JSON.stringify(request.input, null, 2)}`;
      }
    } else {
      // Fallback to task description
      userPrompt = request.task || "Complete the requested task.";
    }

    this.logger.debug("DEBUG: Agent execution input analysis", {
      agentId: request.agent_id,
      inputType: typeof request.input,
      inputIsString: typeof request.input === "string",
      inputLength: typeof request.input === "string" ? request.input.length : 0,
      inputPreview: typeof request.input === "string"
        ? request.input.substring(0, 100)
        : JSON.stringify(request.input),
      taskDescription: request.task || "none",
      userPromptLength: userPrompt.length,
      userPromptPreview: userPrompt.substring(0, 100),
      systemPromptLength: systemPrompt.length,
      hasSystemPrompt: !!agentConfig.prompts?.system,
    });

    // Use unified API - tools are optional
    const result = await LLMProvider.generateText(userPrompt, {
      systemPrompt,
      model: agentConfig.model || "claude-3-5-sonnet-20241022",
      provider: agentConfig.provider || "google",
      temperature: agentConfig.temperature || 0.7,
      max_tokens: agentConfig.max_tokens || 4000,
      mcpServers: this.extractMcpServers(agentConfig),
      max_steps: agentConfig.max_steps || 10,
      tool_choice: agentConfig.tool_choice,
      operationContext: {
        operation: "llm_agent_execution",
        agentId: request.agent_id,
        workspaceId: this.workspaceId,
      },
    });

    return result.text;
  }

  private async executeRemoteAgent(
    agentConfig: WorkspaceAgentConfig,
    request: AgentExecutePayload,
  ): Promise<unknown> {
    // Create remote agent instance using existing infrastructure
    const remoteAgent = new RemoteAgent({
      id: request.agent_id,
      type: "remote" as const,
      config: agentConfig as any, // Type conversion needed - will fix with proper types
    });

    // Initialize with workspace context
    await remoteAgent.initialize();

    this.logger.debug(`Executing remote agent: ${request.agent_id}`, {
      protocol: agentConfig.protocol,
      endpoint: agentConfig.endpoint,
    });

    // Use invoke method from BaseAgent
    return await remoteAgent.invoke(request.input as string);
  }

  /**
   * Extract MCP servers from modern tools.mcp format only
   */
  private extractMcpServers(agentConfig: WorkspaceAgentConfig): string[] | undefined {
    if (
      agentConfig.tools && typeof agentConfig.tools === "object" &&
      !Array.isArray(agentConfig.tools)
    ) {
      const toolsConfig = agentConfig.tools as { mcp?: string[] };
      if (toolsConfig.mcp && Array.isArray(toolsConfig.mcp)) {
        return toolsConfig.mcp;
      }
    }
    return undefined;
  }

  /**
   * Load workspace configuration transparently
   * - If workspaceId is provided: load specific workspace config from WorkspaceManager
   * - If workspaceId is undefined: load global atlas.yml config from WorkspaceManager
   */
  private async loadWorkspaceConfig() {
    const workspaceManager = await getWorkspaceManager();

    if (!this.workspaceId) {
      // No workspace ID means we're in the global workspace (atlas.yml only)
      this.logger.debug("Loading global atlas.yml configuration from WorkspaceManager");

      const atlasConfig = await workspaceManager.getAtlasConfig();
      if (!atlasConfig) {
        throw new Error("Global atlas.yml configuration not found in registry");
      }

      // AtlasConfig is now a superset of WorkspaceConfig, use directly
      return atlasConfig;
    } else {
      // Load specific workspace config from WorkspaceManager
      const workspaceConfig = await workspaceManager.getWorkspaceConfigBySlug(this.workspaceId);
      if (!workspaceConfig) {
        throw new Error(`Workspace configuration not found: ${this.workspaceId}`);
      }
      return workspaceConfig;
    }
  }
}
