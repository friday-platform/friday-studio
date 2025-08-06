/**
 * Agent Execution Actor - Executes agents (LLM, System, or Remote) within the Atlas actor hierarchy.
 * Receives typed configuration and task payloads from SessionSupervisor, dispatches to appropriate
 * agent implementation based on type, and returns execution results.
 */

import type { LLMAgentConfig, RemoteAgentConfig, SystemAgentConfig } from "@atlas/config";
import { parseDuration } from "@atlas/config";
import type {
  ActorInitParams,
  AgentContext,
  AgentExecutePayload,
  AgentExecutionActor as IAgentExecutionActor,
  AgentExecutionConfig,
  AgentExecutionResult,
  AgentResult,
} from "@atlas/core";
import { LLMProvider } from "@atlas/core";
import { type Logger, logger } from "@atlas/logger";
import { RemoteAgent } from "../agents/remote/remote-agent.ts";
import { SystemAgentRegistry } from "../system-agent-registry.ts";

export class AgentExecutionActor implements IAgentExecutionActor {
  readonly type = "agent" as const;
  private logger: Logger;
  id: string;
  private config: AgentExecutionConfig;

  constructor(
    id: string,
    config: AgentExecutionConfig,
  ) {
    this.id = id;
    this.config = config;

    // Initialize logger
    this.logger = logger.child({
      actorId: this.id,
      actorType: "agent-execution",
    });
  }

  initialize(params?: ActorInitParams): Promise<void> {
    if (params) {
      this.id = params.actorId;

      // Update logger with new actor ID
      this.logger = logger.child({
        actorId: this.id,
        actorType: "agent-execution",
      });
    }

    this.logger.info("Agent execution actor initialized", {
      agentId: this.config.agentId,
      agentType: this.config.agent.type,
    });

    return Promise.resolve();
  }

  shutdown(): Promise<void> {
    this.logger.info("Agent execution actor shutting down");
    return Promise.resolve();
  }

  async executeTask(data: AgentExecutePayload): Promise<AgentExecutionResult> {
    const executionStart = Date.now();

    // Get agent ID from payload
    const agentId = data.agentId;

    // Validate agent ID matches configuration
    if (this.config.agentId !== agentId) {
      throw new Error(
        `Agent ID mismatch: expected ${this.config.agentId} but got ${agentId}`,
      );
    }

    const agentConfig = this.config.agent;

    // Dispatch based on agent type
    // @FIXME: results can be typed better. This requires work in the base-agent v2.
    let result: unknown;
    switch (agentConfig.type) {
      case "system":
        result = await this.executeSystemAgent(agentConfig, data);
        break;
      case "llm":
        result = await this.executeLLMAgent(agentConfig, data);
        break;
      case "remote":
        result = await this.executeRemoteAgent(agentConfig, data);
        break;
    }

    const duration = Date.now() - executionStart;
    return { output: result, duration };
  }

  private async executeSystemAgent(
    agentConfig: SystemAgentConfig,
    request: AgentExecutePayload,
  ): Promise<unknown> {
    // For system agents, the 'agent' field specifies which system agent to use
    const systemAgentId = agentConfig.agent;

    // Create system agent instance from registry
    // System agents have optional config object
    const fullConfig = agentConfig.config || {};

    const systemAgent = SystemAgentRegistry.createAgent(
      systemAgentId,
      fullConfig,
    );

    this.logger.debug(`Executing system agent: ${systemAgentId}`, {
      agentId: request.agentId,
      sessionId: request.sessionContext?.sessionId,
      workspaceId: request.sessionContext?.workspaceId,
    });

    // System agents receive input as-is without transformation
    return await systemAgent.invoke(request.input);
  }

  private buildAgentSystemPrompt(basePrompt: string, agentDescription?: string): string {
    const currentDate = new Date().toISOString().split("T")[0];
    const autonomyInstructions =
      `You are an autonomous agent operating within the Atlas platform. You MUST complete your assigned task immediately without asking for additional input, clarification, or confirmation. Work independently and provide results based on the information and tools available to you.

CRITICAL AUTONOMY REQUIREMENTS:
- Never ask questions or request additional input
- Never ask for confirmation before taking actions
- Complete the task using available information and tools
- Provide comprehensive output based on your analysis
- If information is missing, work with what you have and note limitations in your output
- Execute your task immediately and thoroughly`;

    // Include agent description if provided - this contains critical configuration like email addresses
    const descriptionSection = agentDescription
      ? `\n\nAGENT ROLE AND CONFIGURATION:\n${agentDescription}`
      : "";

    return `Current date and time: ${currentDate}\n\n${autonomyInstructions}${descriptionSection}\n\n${basePrompt}`;
  }

  private async executeLLMAgent(
    agentConfig: LLMAgentConfig,
    request: AgentExecutePayload,
  ): Promise<string> {
    const llmConfig = agentConfig.config;

    this.logger.debug(`Executing LLM agent: ${request.agentId}`, {
      provider: llmConfig.provider,
      model: llmConfig.model,
    });

    const systemPrompt = this.buildAgentSystemPrompt(llmConfig.prompt, agentConfig.description);
    const userPrompt = request.input;

    // Use generateTextWithTools if MCP servers or tools are configured
    // Tools can come from the agent's config or from the execution config
    const mcpServers = this.config.tools;

    // LLM agents use the watchdog timer through LLMProvider.generateText()
    // Progress reporting is handled automatically within the LLM provider
    // @FIXME: This is a temporary fix to get the agent execution actor working.
    const result = await LLMProvider.generateText(JSON.stringify(userPrompt), {
      systemPrompt,
      model: llmConfig.model,
      provider: llmConfig.provider,
      temperature: llmConfig.temperature,
      max_tokens: llmConfig.max_tokens,
      mcpServers: mcpServers,
      max_steps: llmConfig.max_steps,
      tool_choice: llmConfig.tool_choice,
      timeout: this.config.workspaceTimeout, // Use workspace watchdog timeout configuration
      operationContext: {
        operation: "llm_agent_execution",
        agentId: request.agentId,
        workspaceId: request.sessionContext?.workspaceId,
      },
    });

    return result.text;
  }

  private async executeRemoteAgent(
    agentConfig: RemoteAgentConfig,
    request: AgentExecutePayload,
  ): Promise<unknown> {
    // Create remote agent instance using existing infrastructure
    const remoteAgent = new RemoteAgent({
      id: request.agentId,
      type: "remote" as const,
      config: {
        type: "remote" as const,
        protocol: agentConfig.config.protocol,
        endpoint: agentConfig.config.endpoint,
        // Convert Duration string to milliseconds if present
        timeout: agentConfig.config.timeout ? parseDuration(agentConfig.config.timeout) : undefined,
        // Include other config fields, excluding those we've already handled
        ...Object.fromEntries(
          Object.entries(agentConfig.config)
            .filter(([key]) => !["type", "protocol", "endpoint", "timeout"].includes(key)),
        ),
      },
    });

    // Initialize with workspace context
    await remoteAgent.initialize();

    this.logger.debug(`Executing remote agent: ${request.agentId}`, {
      protocol: agentConfig.config.protocol,
      endpoint: agentConfig.config.endpoint,
      sessionId: request.sessionContext?.sessionId,
      workspaceId: request.sessionContext?.workspaceId,
    });

    return await remoteAgent.invoke(request.input as string);
  }

  async execute(context: AgentContext): Promise<AgentResult> {
    const payload: AgentExecutePayload = {
      agentId: this.config.agentId,
      input: context.input,
      sessionContext: {
        sessionId: context.sessionId,
        workspaceId: context.workspaceId,
        task: context.task,
        reasoning: context.reasoning,
      },
    };

    const result = await this.executeTask(payload);

    return {
      agentId: this.config.agentId,
      output: result.output,
      duration: result.duration,
      metadata: result.metadata,
    };
  }
}
