/**
 * Agent Execution Actor - Runs agents in main thread with direct function calls
 * Migrated from AgentExecutionWorker - preserves all functionality without worker complexity
 */

import { type ChildLogger, logger } from "../../utils/logger.ts";
import type { WorkspaceManager } from "../workspace-manager.ts";
import type { WorkspaceAgentConfig } from "../../../packages/config/src/schemas.ts";
import { SystemAgentRegistry } from "../system-agent-registry.ts";
import { RemoteAgent } from "../agents/remote/remote-agent.ts";
import type { AgentExecutePayload } from "../../types/messages.ts";

// Simple response wrapper - just for timing and error handling
interface AgentExecutionResult {
  output: unknown;
  duration: number;
}

export class AgentExecutionActor {
  private workspaceManager?: WorkspaceManager;
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

  async initialize(workspaceManager: WorkspaceManager): Promise<void> {
    this.workspaceManager = workspaceManager;
    this.logger.info("Agent execution actor initialized");
  }

  async executeTask(taskId: string, data: AgentExecutePayload): Promise<AgentExecutionResult> {
    const executionStart = Date.now();

    // Get agent configuration from workspace registry
    const agentConfig = await this.getAgentConfig(data.agent_id);

    // Dispatch based on agent type - simple orchestration
    let result: unknown;
    switch (agentConfig.type) {
      case "tempest": // System agents in schema
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

  private async getAgentConfig(agentId: string): Promise<WorkspaceAgentConfig> {
    if (!this.workspaceId) {
      throw new Error("Workspace ID required to get agent config");
    }

    const workspaceConfig = await this.workspaceManager?.getWorkspaceConfigBySlug(this.workspaceId);
    if (!workspaceConfig?.agents?.[agentId]) {
      throw new Error(`Agent configuration not found: ${agentId}`);
    }

    return workspaceConfig.agents[agentId];
  }

  private async executeSystemAgent(
    agentConfig: WorkspaceAgentConfig,
    request: AgentExecutePayload,
  ): Promise<unknown> {
    // Create system agent instance from registry
    const systemAgent = SystemAgentRegistry.createAgent(
      request.agent_id, // Use agent_id from request
      agentConfig,
    );

    this.logger.debug(`Executing system agent: ${request.agent_id}`);

    // Use invoke method from BaseAgent
    return await systemAgent.invoke(request.input as string);
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
    const { LLMProvider } = await import("../../utils/llm/provider.ts");

    const systemPrompt = agentConfig.prompts?.system || "You are a helpful AI assistant.";
    const userPrompt = request.input as string;

    // Use generateTextWithTools if MCP servers or tools are configured
    const hasMcpServers = agentConfig.mcp_servers?.length > 0;
    const hasTools = Array.isArray(agentConfig.tools)
      ? agentConfig.tools.length > 0
      : Object.keys(agentConfig.tools || {}).length > 0;

    if (hasMcpServers || hasTools) {
      const result = await LLMProvider.generateTextWithTools(userPrompt, {
        systemPrompt,
        model: agentConfig.model || "claude-3-5-sonnet-20241022",
        provider: agentConfig.provider || "anthropic",
        temperature: agentConfig.temperature || 0.7,
        maxTokens: agentConfig.max_tokens || 4000,
        mcpServers: agentConfig.mcp_servers,
        maxSteps: agentConfig.max_steps || 10,
        toolChoice: agentConfig.tool_choice,
        operationContext: {
          operation: "llm_agent_execution",
          agentId: request.agent_id,
          workspaceId: this.workspaceId,
        },
      });

      return result.text;
    } else {
      // Use simple text generation for agents without tools
      return await LLMProvider.generateText(userPrompt, {
        systemPrompt,
        model: agentConfig.model || "claude-3-5-sonnet-20241022",
        provider: agentConfig.provider || "anthropic",
        temperature: agentConfig.temperature || 0.7,
        maxTokens: agentConfig.max_tokens || 4000,
        operationContext: {
          operation: "llm_agent_execution",
          agentId: request.agent_id,
          workspaceId: this.workspaceId,
        },
      });
    }
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
}
