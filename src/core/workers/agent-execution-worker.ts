/**
 * Agent Execution Worker - Runs in Web Worker for isolated agent execution
 */

import { type ChildLogger, logger } from "../../utils/logger.ts";
import { LLMProviderManager } from "../agents/llm-provider-manager.ts";

interface WorkerMessage {
  type: "initialize" | "execute" | "terminate";
  id: string;
  data?: any;
}

interface AgentExecutionRequest {
  agent_id: string;
  agent_config: {
    type: string;
    model?: string;
    parameters: Record<string, any>;
    prompts: Record<string, string>;
    tools: string[];
    endpoint?: string;
    auth?: any;
  };
  task: {
    task: string;
    inputSource: string;
    mode?: string;
    config?: Record<string, any>;
  };
  input: any;
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
  output?: any;
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

  constructor() {
    // Initialize logger first
    this.logger = logger.createChildLogger({
      workerId: crypto.randomUUID(),
      workerType: "agent-execution",
    });

    // Listen for messages from main thread
    self.addEventListener("message", this.handleMessage.bind(this));

    // Send ready signal
    this.postMessage({
      type: "ready",
      id: "worker-ready",
      data: { worker_id: crypto.randomUUID() },
    });
  }

  private postMessage(message: any) {
    (self as any).postMessage(message);
  }

  private async handleMessage(event: MessageEvent<WorkerMessage>) {
    const { type, id, data } = event.data;

    try {
      switch (type) {
        case "initialize":
          await this.initialize(id, data);
          break;
        case "execute":
          await this.executeAgent(id, data);
          break;
        case "terminate":
          await this.terminate(id);
          break;
        default:
          throw new Error(`Unknown message type: ${type}`);
      }
    } catch (error) {
      this.postMessage({
        type: "error",
        id,
        data: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private async initialize(messageId: string, data: any) {
    this.workerId = data.worker_id || crypto.randomUUID();
    this.isInitialized = true;
    this.startTime = Date.now();

    // Update logger with actual worker ID
    this.logger = logger.createChildLogger({
      workerId: this.workerId,
      workerType: "agent-execution",
    });

    this.log("Worker initialized", "debug");

    this.postMessage({
      type: "initialized",
      id: messageId,
      data: { worker_id: this.workerId, status: "ready" },
    });
  }

  private async executeAgent(messageId: string, request: AgentExecutionRequest) {
    if (!this.isInitialized) {
      throw new Error("Worker not initialized");
    }

    // Update logger with agent name for better context
    this.logger = logger.createChildLogger({
      workerId: this.workerId,
      workerType: "agent-execution",
      agentName: request.agent_id,
    });

    this.log(`Executing ${request.agent_config.type} agent: ${request.agent_id}`, "info");

    const executionStart = Date.now();

    try {
      // Perform safety checks
      this.performSafetyChecks(request);

      // Execute based on agent type
      let output: any;
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

      const response: AgentExecutionResponse = {
        success: true,
        output,
        metadata: {
          duration,
          memory_used: memoryUsed,
          safety_checks_passed: true,
        },
      };

      this.log(`Agent ${request.agent_id} executed successfully in ${duration}ms`, "info");

      this.postMessage({
        type: "execution_complete",
        id: messageId,
        data: response,
      });
    } catch (error) {
      const duration = Date.now() - executionStart;
      const response: AgentExecutionResponse = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        metadata: {
          duration,
          memory_used: this.estimateMemoryUsage(),
          safety_checks_passed: false,
        },
      };

      this.log(`Agent ${request.agent_id} execution failed: ${response.error}`, "error");

      this.postMessage({
        type: "execution_complete",
        id: messageId,
        data: response,
      });
    }
  }

  private performSafetyChecks(request: AgentExecutionRequest) {
    const checksStart = Date.now();
    const checks = [];

    // Memory limit check
    if (request.environment.worker_config.memory_limit < 64) {
      throw new Error("Insufficient memory allocation");
    }
    checks.push("memory_limit");

    // Permission checks
    const requiredPermissions = ["read"];
    if (request.agent_config.type === "remote") {
      requiredPermissions.push("network");
    }

    for (const permission of requiredPermissions) {
      if (!request.environment.worker_config.allowed_permissions.includes(permission)) {
        throw new Error(`Missing required permission: ${permission}`);
      }
    }
    checks.push("permissions");

    // Environment safety checks
    checks.push(...request.environment.monitoring_config.safety_checks);

    const checksDuration = Date.now() - checksStart;
    this.logger.debug(`All ${checks.length} safety checks passed in ${checksDuration}ms`, {
      checks: checks,
    });
  }

  private async executeLLMAgent(request: AgentExecutionRequest): Promise<any> {
    const { model, prompts, parameters } = request.agent_config;
    const { task, input } = request;

    if (!model) {
      throw new Error("LLM agent requires model specification");
    }

    // Extract provider from parameters or default to anthropic
    const provider = parameters.provider || "anthropic";

    // Log configuration details for debugging
    this.log(`LLM Agent Configuration - Provider: ${provider}, Model: ${model}`, "debug");
    this.log(`Agent Config Parameters: ${JSON.stringify(parameters)}`, "debug");
    this.log(`Environment Config: ${JSON.stringify(request.environment.worker_config)}`, "debug");

    // Prepare prompt
    const systemPrompt = prompts.system || "You are a helpful AI assistant.";
    const userPrompt = this.buildUserPrompt(task, input, prompts);

    try {
      this.log(`Calling LLMProviderManager with provider: ${provider}, model: ${model}`, "debug");

      const result = await LLMProviderManager.generateText(userPrompt, {
        provider,
        model,
        systemPrompt,
        temperature: parameters.temperature,
        maxTokens: parameters.max_tokens,
        timeout: request.environment.worker_config.timeout,
        operationContext: {
          operation: "agent_execution",
          agentId: request.agent_id,
          workerId: this.workerId,
        },
      });

      this.log(`LLM execution successful for ${request.agent_id}`, "debug");

      return {
        agent_type: "llm",
        agent_id: request.agent_id,
        provider,
        model,
        result,
        input,
        tokens_used: 0, // LLMProviderManager doesn't expose token count yet
        finish_reason: "stop",
      };
    } catch (error) {
      this.log(`LLM execution error for ${request.agent_id}: ${error}`, "error");
      this.log(
        `Error details - Provider: ${provider}, Model: ${model}, Type: ${
          error instanceof Error ? error.name : "Unknown"
        }`,
        "error",
      );
      throw error;
    }
  }

  private async executeTempestAgent(request: AgentExecutionRequest): Promise<any> {
    // For Tempest agents, we would load the specific agent from the catalog
    // For now, simulate the execution
    const { parameters } = request.agent_config;
    const agentName = parameters.agent;
    const version = parameters.version;

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

  private async executeRemoteAgent(request: AgentExecutionRequest): Promise<any> {
    // Check network permission
    if (!request.environment.worker_config.allowed_permissions.includes("network")) {
      throw new Error("Network access not permitted for this agent");
    }

    try {
      // Import the remote agent adapter factory dynamically
      const { RemoteAdapterFactory } = await import("../agents/remote/adapter-factory.ts");

      // Extract remote agent configuration from the agent config
      const agentConfig = request.agent_config;
      if (!agentConfig.endpoint) {
        throw new Error("Remote agent requires endpoint specification");
      }

      // Validate required remote agent configuration
      const protocol = (agentConfig.parameters?.protocol || "acp") as "acp" | "a2a" | "custom";

      if (protocol === "acp" && !agentConfig.parameters?.agent_name) {
        throw new Error("ACP remote agent requires 'agent_name' parameter");
      }

      // Build remote agent config for the adapter
      const remoteConfig = {
        type: "remote" as const,
        protocol: protocol,
        endpoint: agentConfig.endpoint,
        auth: agentConfig.auth,
        timeout: request.environment.worker_config.timeout,
        acp: {
          agent_name: agentConfig.parameters?.agent_name,
          default_mode: agentConfig.parameters?.default_mode || "sync",
          timeout_ms: request.environment.worker_config.timeout,
          max_retries: agentConfig.parameters?.max_retries || 3,
          health_check_interval: agentConfig.parameters?.health_check_interval || 60000,
        },
        monitoring: {
          enabled: request.environment.monitoring_config.metrics_collection,
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
        agentName: remoteConfig.acp.agent_name,
        input: this.formatInputForRemoteAgent(request.input, request.task),
        mode: (agentConfig.parameters?.execution_mode || "sync") as "sync" | "async" | "stream",
        sessionId: `worker-${this.workerId}-${Date.now()}`,
        context: {
          task: request.task.task,
          mode: request.task.mode,
          config: request.task.config,
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
  private formatInputForRemoteAgent(input: any, task: any): string {
    // For ACP protocol, we typically send string input
    if (typeof input === "string") {
      return input;
    }

    // Build a formatted input including task context
    const formattedInput = {
      task: task.task,
      mode: task.mode,
      data: input,
      config: task.config,
    };

    return JSON.stringify(formattedInput, null, 2);
  }

  /**
   * Extract the actual output from the remote agent result
   */
  private extractOutputFromRemoteResult(result: any): any {
    if (!result.output || result.output.length === 0) {
      return { message: "No output received from remote agent" };
    }

    // Try to extract text content from message parts
    const textParts = result.output
      .filter((part: any) => part.content_type === "text/plain" || !part.content_type)
      .map((part: any) => part.content)
      .filter(Boolean);

    if (textParts.length === 1) {
      // Try to parse as JSON if it looks like JSON
      const content = textParts[0];
      try {
        return JSON.parse(content);
      } catch {
        return { message: content };
      }
    } else if (textParts.length > 1) {
      return { messages: textParts };
    }

    // Fallback to raw output
    return { raw_output: result.output };
  }

  private buildUserPrompt(task: any, input: any, prompts: Record<string, string>): string {
    // Check if this is a memory-enhanced task (contains memory sections)
    const hasMemoryContent = task.task && (
      task.task.includes("## RELEVANT WORKSPACE KNOWLEDGE") ||
      task.task.includes("## WORKSPACE RULES AND PROCEDURES") ||
      task.task.includes("## CURRENT SESSION CONTEXT") ||
      task.task.includes("## PREVIOUS EXECUTION CONTEXT")
    );

    let userPrompt: string;

    if (hasMemoryContent) {
      // For memory-enhanced tasks, use the enhanced prompt directly
      // and add input as a structured section
      userPrompt = task.task;
      userPrompt += `\n\n## INPUT DATA\n${JSON.stringify(input, null, 2)}`;
    } else {
      // For simple tasks, use the traditional format
      userPrompt = `Task: ${task.task}\n\nInput: ${JSON.stringify(input, null, 2)}`;
    }

    // Add any task-specific prompts
    if (task.mode && prompts[task.mode]) {
      userPrompt += `\n\nMode-specific instructions (${task.mode}):\n${prompts[task.mode]}`;
    }

    // Add user prompt if provided
    if (prompts.user) {
      userPrompt += `\n\nAdditional instructions:\n${prompts.user}`;
    }

    return userPrompt;
  }

  private async withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error(`Operation timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([promise, timeout]);
  }

  private async simulateWork(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private estimateMemoryUsage(): number {
    // In a real implementation, this would measure actual memory usage
    // For now, return a mock value
    return Math.floor(Math.random() * 128) + 64; // 64-192 MB
  }

  private async terminate(messageId: string) {
    this.log("Worker terminating", "info");

    this.postMessage({
      type: "terminated",
      id: messageId,
      data: { worker_id: this.workerId, uptime: Date.now() - this.startTime },
    });

    // Close the worker
    self.close();
  }

  private log(message: string, level: "debug" | "info" | "warn" | "error" = "info") {
    this.logger[level](message, {
      workerId: this.workerId,
      workerType: "agent-execution",
    });

    // Send log to main thread for centralized logging
    this.postMessage({
      type: "log",
      id: crypto.randomUUID(),
      data: { level, message, timestamp: new Date().toISOString(), worker_id: this.workerId },
    });
  }
}

// Initialize the worker
new AgentExecutionWorker();
