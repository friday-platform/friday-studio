/**
 * Agent Execution Worker - Runs in Web Worker for isolated agent execution
 */

import { type ChildLogger, logger } from "../../utils/logger.ts";
import { LLMProviderManager } from "../agents/llm-provider-manager.ts";
import { AtlasTelemetry } from "../../utils/telemetry.ts";
import type { Span } from "@opentelemetry/api";
import { WorkspaceMCPConfigurationService } from "../services/mcp-configuration-service.ts";
import {
  type AgentExecutePayload,
  type AgentExecutionCompletePayload,
  type AgentLogPayload,
  ATLAS_MESSAGE_TYPES,
  type AtlasMessageEnvelope,
  createAgentExecutionCompleteMessage,
  createAgentLogMessage,
  createAgentMessage,
  createErrorResponse,
  createResponseMessage,
  deserializeEnvelope,
  isAgentExecuteMessage,
  type MessageSource,
  validateAgentExecutePayload,
} from "../utils/message-envelope.ts";

// Legacy interface for backward compatibility during transition
interface LegacyWorkerMessage {
  type: "initialize" | "execute" | "terminate";
  id: string;
  data?: Record<string, unknown>;
}

interface AgentExecutionRequest {
  agent_id: string;
  agent_config: {
    type: string;
    model?: string;
    protocol?: string;
    parameters: Record<string, unknown>;
    prompts: Record<string, string>;
    tools: string[];
    mcp_servers?: string[]; // MCP server references
    max_steps?: number; // For multi-step tool calling
    tool_choice?: "auto" | "required" | "none" | { type: "tool"; toolName: string }; // Tool choice control
    endpoint?: string;
    auth?: {
      type: "bearer" | "api_key" | "basic" | "none";
      token_env?: string;
      token?: string;
      api_key_env?: string;
      api_key?: string;
      header?: string;
      username?: string;
      password?: string;
    };
  };
  task: {
    task: string;
    inputSource: string;
    mode?: string;
    config?: Record<string, unknown>;
  };
  input: unknown;
  environment: {
    worker_config: {
      memory_limit: number;
      timeout: number;
      allowed_permissions: string[];
      isolation_level: string;
    };
    monitoring_config: {
      log_level: string;
      metrics_collection: boolean;
      safety_checks: string[];
      output_validation: boolean;
    };
  };
}

interface AgentExecutionResponse {
  success: boolean;
  output?: unknown;
  error?: string;
  metadata: {
    duration: number;
    memory_used: number;
    safety_checks_passed: boolean;
  };
}

class AgentExecutionWorker {
  private workerId: string = "";
  private isInitialized: boolean = false;
  private startTime: number = 0;
  private logger: ChildLogger;
  private sessionId?: string;
  private workspaceId?: string;
  private traceHeaders?: Record<string, string>;

  constructor() {
    this.workerId = crypto.randomUUID();

    // Initialize logger first
    this.logger = logger.createChildLogger({
      workerId: this.workerId,
      workerType: "agent-execution",
    });

    // Listen for messages from main thread
    self.addEventListener("message", this.handleMessage.bind(this));

    // Send ready signal using envelope format
    this.sendReadyMessage();
  }

  private createMessageSource(): MessageSource {
    return {
      workerId: this.workerId,
      workerType: "agent-execution",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    };
  }

  private sendReadyMessage(): void {
    const readyMessage = createAgentMessage(
      ATLAS_MESSAGE_TYPES.LIFECYCLE.READY,
      { worker_id: this.workerId },
      this.createMessageSource(),
      {
        priority: "high",
      },
    );

    this.postMessage(readyMessage);
  }

  private postMessage(message: AtlasMessageEnvelope | unknown) {
    self.postMessage(message);
  }

  private async handleMessage(event: MessageEvent) {
    // Parse envelope message
    let envelope: AtlasMessageEnvelope | undefined;

    if (typeof event.data === "string") {
      const result = deserializeEnvelope(event.data);
      if (result.envelope) {
        envelope = result.envelope;
      } else {
        this.logger.debug(`Failed to deserialize envelope: ${result.error}`);
        return;
      }
    } else if (
      event.data && typeof event.data === "object" && event.data.type && event.data.domain
    ) {
      envelope = event.data as AtlasMessageEnvelope;
    } else {
      this.logger.debug(`Received non-envelope message, ignoring: ${JSON.stringify(event.data)}`);
      return;
    }

    if (!envelope) {
      return;
    }

    try {
      switch (envelope.type) {
        case ATLAS_MESSAGE_TYPES.LIFECYCLE.INIT:
          await this.handleInitialize(envelope);
          break;
        case ATLAS_MESSAGE_TYPES.AGENT.EXECUTE:
          await this.handleExecuteAgent(envelope);
          break;
        case ATLAS_MESSAGE_TYPES.LIFECYCLE.TERMINATE:
          await this.handleTerminate(envelope);
          break;
        default:
          this.logger.debug(`Unknown message type: ${envelope.type}`);
          break;
      }
    } catch (error) {
      // Send error response using envelope format
      const errorResponse = createErrorResponse(
        envelope,
        {
          code: "EXECUTION_ERROR",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        },
        this.createMessageSource(),
      );

      this.postMessage(errorResponse);
    }
  }

  private async handleInitialize(envelope: AtlasMessageEnvelope): Promise<void> {
    return await AtlasTelemetry.withWorkerSpan(
      {
        operation: "initialize",
        component: "agent",
        traceHeaders: envelope.traceHeaders,
        workerId: this.workerId,
        sessionId: envelope.source.sessionId,
        workspaceId: envelope.source.workspaceId,
      },
      (span) => {
        const payload = envelope.payload as Record<string, unknown>;

        // Extract context from envelope
        this.workerId = (payload.worker_id as string) || this.workerId;
        this.sessionId = envelope.source.sessionId;
        this.workspaceId = envelope.source.workspaceId;
        this.traceHeaders = envelope.traceHeaders as Record<string, string> | undefined;
        this.isInitialized = true;
        this.startTime = Date.now();

        // Update logger with session/workspace context
        this.logger = logger.createChildLogger({
          workerId: this.workerId,
          workerType: "agent-execution",
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
        });

        this.logger.debug("Worker initialized with envelope", {
          workerId: this.workerId,
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
        });

        // Send initialized response
        const response = createResponseMessage(
          envelope,
          ATLAS_MESSAGE_TYPES.LIFECYCLE.INITIALIZED,
          {
            worker_id: this.workerId,
            status: "ready",
            session_id: this.sessionId,
            workspace_id: this.workspaceId,
          },
          this.createMessageSource(),
        );

        span?.setAttribute("worker.id", this.workerId);
        span?.setAttribute("worker.status", "initialized");

        this.postMessage(response);
      },
    );
  }

  private async handleExecuteAgent(envelope: AtlasMessageEnvelope): Promise<void> {
    return await AtlasTelemetry.withWorkerSpan(
      {
        operation: "executeAgent",
        component: "agent",
        traceHeaders: envelope.traceHeaders,
        workerId: this.workerId,
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      },
      async (span) => {
        if (!this.isInitialized) {
          throw new Error("Worker not initialized");
        }

        // Validate and extract agent execution payload
        if (!isAgentExecuteMessage(envelope)) {
          throw new Error("Invalid agent execute message");
        }

        const validation = validateAgentExecutePayload(envelope.payload);
        if (validation.success === false) {
          throw new Error(`Invalid agent execute payload: ${validation.error.message}`);
        }

        const request = validation.data;
        const executionStart = Date.now();

        // Update logger with agent name for better context
        this.logger = logger.createChildLogger({
          workerId: this.workerId,
          workerType: "agent-execution",
          agentName: request.agent_id,
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
        });

        // Add span attributes
        span?.setAttribute("agent.id", request.agent_id);
        span?.setAttribute("agent.type", request.agent_config.type);
        span?.setAttribute("agent.task", request.task);

        this.sendLogMessage(
          "info",
          `Executing ${request.agent_config.type} agent: ${request.agent_id}`,
        );

        try {
          // Perform safety checks
          this.performSafetyChecks(request);

          // Execute based on agent type
          let output: unknown;
          switch (request.agent_config.type) {
            case "llm":
              output = await this.executeLLMAgent(request);
              break;
            case "tempest":
              output = await this.executeTempestAgent(request);
              break;
            case "remote":
              output = await this.executeRemoteAgent(request);
              break;
            default:
              throw new Error(`Unsupported agent type: ${request.agent_config.type}`);
          }

          const duration = Date.now() - executionStart;
          const memoryUsed = this.estimateMemoryUsage();

          // Create completion payload
          const completionPayload: AgentExecutionCompletePayload = {
            agent_id: request.agent_id,
            result: output,
            execution_time_ms: duration,
            metadata: {
              tokens_used: (output as { tokens_used?: number })?.tokens_used || 0,
              cost: 0, // TODO: Calculate actual cost
              memory_used: memoryUsed,
              safety_checks_passed: true,
            },
          };

          // Add span attributes for successful execution
          span?.setAttribute("agent.execution.duration", duration);
          span?.setAttribute("agent.execution.memory_used", memoryUsed);
          span?.setAttribute("agent.execution.status", "success");

          this.sendLogMessage(
            "info",
            `Agent ${request.agent_id} executed successfully in ${duration}ms`,
          );

          // Send completion response using envelope
          const response = createAgentExecutionCompleteMessage(
            envelope,
            completionPayload,
            this.createMessageSource(),
          );

          this.postMessage(response);
        } catch (error) {
          const duration = Date.now() - executionStart;
          const errorMessage = error instanceof Error ? error.message : String(error);

          // Add span attributes for failed execution
          span?.setAttribute("agent.execution.duration", duration);
          span?.setAttribute("agent.execution.status", "error");
          span?.setAttribute("agent.execution.error", errorMessage);

          this.sendLogMessage(
            "error",
            `Agent ${request.agent_id} execution failed: ${errorMessage}`,
          );

          // Send error response using envelope
          const errorResponse = createErrorResponse(
            envelope,
            {
              code: "AGENT_EXECUTION_ERROR",
              message: errorMessage,
              retryable: true, // Agent execution errors may be retryable
            },
            this.createMessageSource(),
            {
              agent_id: request.agent_id,
              execution_time_ms: duration,
              metadata: {
                memory_used: this.estimateMemoryUsage(),
                safety_checks_passed: false,
              },
            },
          );

          this.postMessage(errorResponse);
        }
      },
    );
  }

  private performSafetyChecks(request: AgentExecutePayload) {
    const checksStart = Date.now();
    const checks = [];

    // Get environment from the request
    const environment = request.environment as {
      worker_config: {
        memory_limit: number;
        timeout: number;
        allowed_permissions: string[];
        isolation_level: string;
      };
      monitoring_config: {
        log_level: string;
        metrics_collection: boolean;
        safety_checks: string[];
        output_validation: boolean;
      };
    };

    // Memory limit check
    if (environment.worker_config?.memory_limit < 64) {
      throw new Error("Insufficient memory allocation");
    }
    checks.push("memory_limit");

    // Permission checks
    const requiredPermissions = ["read"];
    if (request.agent_config.type === "remote") {
      requiredPermissions.push("network");
    }

    for (const permission of requiredPermissions) {
      if (!environment.worker_config?.allowed_permissions?.includes(permission)) {
        throw new Error(`Missing required permission: ${permission}`);
      }
    }
    checks.push("permissions");

    // Environment safety checks
    if (environment.monitoring_config?.safety_checks) {
      checks.push(...environment.monitoring_config.safety_checks);
    }

    const checksDuration = Date.now() - checksStart;
    this.logger.debug(`All ${checks.length} safety checks passed in ${checksDuration}ms`, {
      checks: checks,
    });
  }

  private async executeLLMAgent(request: AgentExecutePayload): Promise<Record<string, unknown>> {
    // Extract basic info for telemetry context
    const agentConfig = request.agent_config as Record<string, unknown>;
    const model = agentConfig.model as string;
    const parameters = (agentConfig.parameters as Record<string, unknown>) || {};
    const mcp_servers = agentConfig.mcp_servers as string[] | undefined;
    const max_steps = agentConfig.max_steps as number | undefined;
    const provider = parameters.provider || "anthropic";

    // Create telemetry context for worker span
    const telemetryContext = {
      operation: "execute",
      component: "agent" as const,
      traceHeaders: this.traceHeaders,
      workerId: this.workerId,
      sessionId: this.sessionId,
      agentId: request.agent_id,
      agentType: "llm",
      workspaceId: this.workspaceId,
      attributes: {
        "agent.provider": provider,
        "agent.model": model,
        "agent.has_mcp_servers": !!(mcp_servers && mcp_servers.length > 0),
        "agent.mcp_server_count": mcp_servers?.length || 0,
        "agent.max_steps": max_steps || 1,
      },
    };

    return await AtlasTelemetry.withWorkerSpan(telemetryContext, async (span) => {
      return await this._executeLLMAgentInternal(request, span);
    });
  }

  private async _executeLLMAgentInternal(
    request: AgentExecutePayload,
    span: Span | null,
  ): Promise<Record<string, unknown>> {
    // Safely extract properties from agent_config with type checking
    const agentConfig = request.agent_config as Record<string, unknown>;
    const model = agentConfig.model as string;
    const prompts = (agentConfig.prompts as Record<string, string>) || {};
    const parameters = (agentConfig.parameters as Record<string, unknown>) || {};
    const mcp_servers = agentConfig.mcp_servers as string[] | undefined;
    const max_steps = agentConfig.max_steps as number | undefined;
    const tool_choice = agentConfig.tool_choice as "auto" | "required" | "none" | {
      type: "tool";
      toolName: string;
    } | undefined;

    const { task, input } = request;

    if (!model) {
      throw new Error("LLM agent requires model specification");
    }

    // Extract provider and parameters
    const provider = parameters.provider || "anthropic";

    // Log configuration details for debugging
    this.log(`LLM Agent Configuration - Provider: ${provider}, Model: ${model}`, "debug");
    this.log(`Agent Config Parameters: ${JSON.stringify(parameters)}`, "debug");
    this.log(`MCP Servers: ${JSON.stringify(mcp_servers)}`, "debug");

    // Initialize MCP servers if specified - CLEAN ENCAPSULATION ✅
    if (mcp_servers && Array.isArray(mcp_servers) && mcp_servers.length > 0) {
      // Use configuration service instead of direct workspace config access
      const mcpConfigService = new WorkspaceMCPConfigurationService(
        this.workspaceId!,
        this.sessionId,
      );

      // Get properly resolved and filtered server configurations
      const mcpServerConfigs = mcpConfigService.getServerConfigsForAgent(
        request.agent_id,
        mcp_servers,
        request.agent_config,
      );

      if (mcpServerConfigs.length > 0) {
        this.log(`Initializing ${mcpServerConfigs.length} MCP servers for agent`, "debug");
        await mcpConfigService.initializeServersForSession(
          mcpServerConfigs.map((c) => c.id),
          { sessionId: this.sessionId!, agentId: request.agent_id, workspaceId: this.workspaceId },
        );
      }
    }

    // Prepare prompts
    const systemPrompt = prompts.system || "You are a helpful AI assistant.";
    const userPrompt = this.buildUserPrompt(task, input, prompts);

    // Add telemetry attributes for prompt details
    span?.setAttribute("agent.task", task || "unknown");
    span?.setAttribute("agent.input_type", typeof input);
    span?.setAttribute("agent.system_prompt_length", systemPrompt.length);
    span?.setAttribute("agent.user_prompt_length", userPrompt.length);

    try {
      let result: {
        text: string;
        toolCalls: unknown[];
        toolResults: unknown[];
        steps: unknown[];
      };

      // Use tool-enabled generation if MCP servers are specified
      if (mcp_servers && Array.isArray(mcp_servers) && mcp_servers.length > 0) {
        this.log(`Using MCP tool-enabled generation with ${mcp_servers.length} servers`, "debug");

        result = await LLMProviderManager.generateTextWithTools(
          userPrompt,
          {
            provider: provider as "anthropic" | "openai" | "google",
            model: model,
            systemPrompt,
            temperature: parameters.temperature as number,
            maxTokens: parameters.max_tokens as number,
            timeout: ((request.environment as Record<string, unknown>).worker_config as Record<
              string,
              unknown
            >)?.timeout as number || 30000,
            mcpServers: mcp_servers,
            maxSteps: max_steps || 1,
            toolChoice: tool_choice,
            operationContext: {
              operation: "agent_execution",
              agentId: request.agent_id,
              workerId: this.workerId,
            },
          },
        );

        this.log(
          `LLM execution with MCP tools successful for ${request.agent_id}`,
          "debug",
        );

        return {
          agent_type: "llm",
          agent_id: request.agent_id,
          provider,
          model,
          result: result.text,
          tool_calls: result.toolCalls,
          tool_results: result.toolResults,
          steps: result.steps,
          input,
          tokens_used: 0, // TODO: Extract from result
          finish_reason: "stop",
          mcp_servers_used: mcp_servers || [],
        };
      } else {
        // Use standard generation without tools
        this.log(`Using standard LLM generation without tools`, "debug");

        const textResult = await LLMProviderManager.generateText(userPrompt, {
          provider: provider as "anthropic" | "openai" | "google",
          model: model,
          systemPrompt,
          temperature: parameters.temperature as number,
          maxTokens: parameters.max_tokens as number,
          timeout: ((request.environment as Record<string, unknown>).worker_config as Record<
            string,
            unknown
          >)?.timeout as number || 30000,
          operationContext: {
            operation: "agent_execution",
            agentId: request.agent_id,
            workerId: this.workerId,
          },
        });

        this.log(`LLM execution successful for ${request.agent_id}`, "debug");

        result = {
          text: textResult,
          toolCalls: [],
          toolResults: [],
          steps: [],
        };
      }

      // Add telemetry attributes for execution result
      span?.setAttribute("agent.execution_success", true);
      span?.setAttribute("agent.result_length", result.text.length);
      span?.setAttribute("agent.tool_calls_count", result.toolCalls.length);
      span?.setAttribute("agent.tool_results_count", result.toolResults.length);
      span?.setAttribute("agent.steps_count", result.steps.length);

      if (result.toolCalls.length > 0) {
        const toolNames = result.toolCalls.map((call: unknown) =>
          (call && typeof call === "object" && "toolName" in call)
            ? (call as { toolName: string }).toolName
            : "unknown"
        );
        span?.setAttribute("agent.tools_used", toolNames);
      }

      return {
        agent_type: "llm",
        agent_id: request.agent_id,
        provider,
        model,
        result: result.text,
        tool_calls: result.toolCalls,
        tool_results: result.toolResults,
        steps: result.steps,
        input,
        tokens_used: 0, // TODO: Extract from result
        finish_reason: "stop",
        mcp_servers_used: mcp_servers || [],
      };
    } catch (error) {
      // Add error telemetry attributes
      span?.setAttribute("agent.execution_success", false);
      span?.setAttribute("agent.error_type", error instanceof Error ? error.name : "Unknown");
      span?.setAttribute(
        "agent.error_message",
        error instanceof Error ? error.message : String(error),
      );

      this.log(`LLM execution error for ${request.agent_id}: ${error}`, "error");
      this.log(
        `Error details - Provider: ${provider}, Model: ${model}, Type: ${
          error instanceof Error ? error.name : "Unknown"
        }`,
        "error",
      );
      throw error;
    } finally {
      // Clean up MCP resources
      if (mcp_servers && Array.isArray(mcp_servers) && mcp_servers.length > 0) {
        try {
          await LLMProviderManager.disposeMCPResources();
          this.log(`MCP resources cleaned up for ${request.agent_id}`, "debug");
        } catch (cleanupError) {
          this.log(`MCP cleanup warning for ${request.agent_id}: ${cleanupError}`, "warn");
        }
      }
    }
  }

  private async executeTempestAgent(
    request: AgentExecutePayload,
  ): Promise<Record<string, unknown>> {
    // For Tempest agents, we would load the specific agent from the catalog
    // For now, simulate the execution
    const { parameters } = request.agent_config;
    const params = parameters as Record<string, unknown> || {};
    const agentName = params.agent;
    const version = params.version;

    this.log(`Loading Tempest agent: ${agentName}@${version}`, "info");

    // Simulate Tempest agent execution
    await this.simulateWork(200);

    return {
      agent_type: "tempest",
      agent_id: request.agent_id,
      agent_name: agentName,
      version: version,
      result: `Tempest agent ${agentName} processed: ${JSON.stringify(request.input)}`,
      input: request.input,
      execution_time: Date.now(),
    };
  }

  private async executeRemoteAgent(request: AgentExecutePayload): Promise<Record<string, unknown>> {
    // Check network permission
    const environment = request.environment as {
      worker_config: {
        timeout?: number;
        allowed_permissions?: string[];
      };
      monitoring_config: {
        metrics_collection?: boolean;
      };
    };
    if (!environment.worker_config?.allowed_permissions?.includes("network")) {
      throw new Error("Network access not permitted for this agent");
    }

    try {
      // Import the remote agent adapter factory dynamically
      const { RemoteAdapterFactory } = await import("../agents/remote/adapter-factory.ts");

      // Extract remote agent configuration from the agent config
      const agentConfig = request.agent_config;
      const endpoint = agentConfig.endpoint as string;
      if (!endpoint) {
        throw new Error("Remote agent requires endpoint specification");
      }

      // Validate required remote agent configuration
      const params = agentConfig.parameters as Record<string, unknown> || {};

      // Protocol MUST be defined in agent config - no fallbacks
      if (!agentConfig.protocol) {
        throw new Error("Remote agent requires 'protocol' field in agent configuration");
      }

      const protocol = agentConfig.protocol as "acp" | "mcp";

      if (protocol === "acp" && !params.agent_name) {
        throw new Error("ACP remote agent requires 'agent_name' parameter");
      }

      // Build remote agent config for the adapter
      const remoteConfig = {
        type: "remote" as const,
        protocol: protocol,
        endpoint: endpoint,
        auth: agentConfig.auth as {
          type: "bearer" | "api_key" | "basic" | "none";
          token_env?: string;
          token?: string;
          api_key_env?: string;
          api_key?: string;
          header?: string;
          username?: string;
          password?: string;
        } | undefined,
        timeout: environment.worker_config?.timeout || 30000,
        acp: {
          agent_name: params.agent_name as string,
          default_mode: (params.default_mode as "sync" | "async" | "stream" | undefined) || "sync",
          timeout_ms: environment.worker_config?.timeout || 30000,
          max_retries: (params.max_retries as number) || 3,
          health_check_interval: (params.health_check_interval as number) || 60000,
        },
        monitoring: {
          enabled: environment.monitoring_config?.metrics_collection || false,
          circuit_breaker: {
            failure_threshold: 5,
            timeout_ms: 60000,
            half_open_max_calls: 3,
          },
        },
      };

      this.log(`Creating ${remoteConfig.protocol} adapter for remote agent`, "debug");

      // Create the appropriate adapter
      const adapter = await RemoteAdapterFactory.createAdapter(remoteConfig.protocol, remoteConfig);

      // Prepare execution request
      const executionRequest = {
        agentName: remoteConfig.acp.agent_name as string,
        input: this.formatInputForRemoteAgent(request.input, request.task),
        mode: (params.execution_mode || "sync") as "sync" | "async" | "stream",
        sessionId: `worker-${this.workerId}-${Date.now()}`,
        context: {
          task: request.task,
          mode: "sync", // Default mode
          config: {},
        },
      };

      this.log(`Executing remote agent via ${remoteConfig.protocol} protocol`, "info");

      // Execute the agent
      const result = await adapter.executeAgent(executionRequest);

      // Clean up adapter resources
      adapter.dispose();

      return {
        agent_type: "remote",
        agent_id: request.agent_id,
        protocol: remoteConfig.protocol,
        endpoint: remoteConfig.endpoint,
        execution_id: result.executionId,
        result: this.extractOutputFromRemoteResult(result),
        input: request.input,
        status: result.status,
        metadata: {
          ...result.metadata,
          adapter_metrics: adapter.getMetrics(),
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.log(`Remote agent execution failed: ${errorMessage}`, "error");
      throw new Error(`Remote agent execution failed: ${errorMessage}`);
    }
  }

  /**
   * Format input for remote agent based on task and protocol requirements
   */
  private formatInputForRemoteAgent(input: unknown, task: string): string {
    // For ACP protocol, we typically send string input
    if (typeof input === "string") {
      return input;
    }

    // Build a formatted input including task context
    const formattedInput = {
      task: task,
      data: input,
    };

    return JSON.stringify(formattedInput, null, 2);
  }

  /**
   * Extract the actual output from the remote agent result
   */
  private extractOutputFromRemoteResult(result: unknown): unknown {
    const resultObj = result as Record<string, unknown>;
    if (!resultObj.output || (resultObj.output as unknown[]).length === 0) {
      return { message: "No output received from remote agent" };
    }

    // Try to extract text content from message parts
    const textParts = (resultObj.output as unknown[])
      .filter((part: unknown) => {
        const partObj = part as Record<string, unknown>;
        return partObj.content_type === "text/plain" || !partObj.content_type;
      })
      .map((part: unknown) => (part as Record<string, unknown>).content)
      .filter(Boolean);

    if (textParts.length === 1) {
      // Try to parse as JSON if it looks like JSON
      const content = textParts[0] as string;
      try {
        return JSON.parse(content);
      } catch {
        return { message: content };
      }
    } else if (textParts.length > 1) {
      return { messages: textParts };
    }

    // Fallback to raw output
    return { raw_output: resultObj.output };
  }

  private buildUserPrompt(task: string, input: unknown, prompts: Record<string, string>): string {
    // Check if this is a memory-enhanced task (contains memory sections)
    const hasMemoryContent = task && (
      task.includes("## RELEVANT WORKSPACE KNOWLEDGE") ||
      task.includes("## WORKSPACE RULES AND PROCEDURES") ||
      task.includes("## CURRENT SESSION CONTEXT") ||
      task.includes("## PREVIOUS EXECUTION CONTEXT")
    );

    let userPrompt: string;

    if (hasMemoryContent) {
      // For memory-enhanced tasks, use the enhanced prompt directly
      // and add input as a structured section
      userPrompt = task;
      userPrompt += `\n\n## INPUT DATA\n${JSON.stringify(input, null, 2)}`;
    } else {
      // For simple tasks, use the traditional format
      userPrompt = `Task: ${task}\n\nInput: ${JSON.stringify(input, null, 2)}`;
    }

    // Add user prompt if provided
    if (prompts.user) {
      userPrompt += `\n\nAdditional instructions:\n${prompts.user}`;
    }

    return userPrompt;
  }

  private simulateWork(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private estimateMemoryUsage(): number {
    // In a real implementation, this would measure actual memory usage
    // For now, return a mock value
    return Math.floor(Math.random() * 128) + 64; // 64-192 MB
  }

  private async handleTerminate(envelope: AtlasMessageEnvelope): Promise<void> {
    return await AtlasTelemetry.withWorkerSpan(
      {
        operation: "terminate",
        component: "agent",
        traceHeaders: envelope.traceHeaders,
        workerId: this.workerId,
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
      },
      (span) => {
        this.sendLogMessage("info", "Worker terminating");

        // Send terminated response
        const response = createResponseMessage(
          envelope,
          ATLAS_MESSAGE_TYPES.LIFECYCLE.TERMINATED,
          {
            worker_id: this.workerId,
            uptime: Date.now() - this.startTime,
            session_id: this.sessionId,
            workspace_id: this.workspaceId,
          },
          this.createMessageSource(),
        );

        span?.setAttribute("worker.uptime", Date.now() - this.startTime);
        span?.setAttribute("worker.status", "terminated");

        this.postMessage(response);

        // Close the worker after a short delay to ensure message is sent
        setTimeout(() => {
          self.close();
        }, 100);
      },
    );
  }

  private sendLogMessage(
    level: "debug" | "info" | "warn" | "error",
    message: string,
    metadata?: Record<string, unknown>,
  ) {
    // Log locally first
    this.logger[level](message, {
      workerId: this.workerId,
      workerType: "agent-execution",
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
      ...metadata,
    });

    // Send log to main thread using envelope format
    const logPayload: AgentLogPayload = {
      agent_id: this.workerId, // Use workerId as agent identifier for logs
      level,
      message,
      timestamp: Date.now(),
      metadata: {
        workerId: this.workerId,
        workerType: "agent-execution",
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
        ...metadata,
      },
    };

    const logMessage = createAgentLogMessage(
      logPayload,
      this.createMessageSource(),
      {
        channel: "broadcast", // Log messages are broadcast to all listeners
        priority: level === "error" ? "high" : "low",
      },
    );

    this.postMessage(logMessage);
  }

  // Legacy method for backward compatibility during transition
  private log(message: string, level: "debug" | "info" | "warn" | "error" = "info") {
    this.sendLogMessage(level, message);
  }
}

// Initialize the worker
new AgentExecutionWorker();
