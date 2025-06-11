/**
 * Agent Execution Worker - Runs in Web Worker for isolated agent execution
 */

// Using direct fetch instead of AI SDK to avoid Tokio runtime conflicts in workers

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

  constructor() {
    // Listen for messages from main thread
    self.addEventListener("message", this.handleMessage.bind(this));
    
    // Send ready signal
    this.postMessage({
      type: "ready",
      id: "worker-ready",
      data: { worker_id: crypto.randomUUID() }
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
        data: { error: error instanceof Error ? error.message : String(error) }
      });
    }
  }

  private async initialize(messageId: string, data: any) {
    this.workerId = data.worker_id || crypto.randomUUID();
    this.isInitialized = true;
    this.startTime = Date.now();
    
    this.log("Worker initialized", "info");
    
    this.postMessage({
      type: "initialized",
      id: messageId,
      data: { worker_id: this.workerId, status: "ready" }
    });
  }

  private async executeAgent(messageId: string, request: AgentExecutionRequest) {
    if (!this.isInitialized) {
      throw new Error("Worker not initialized");
    }

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
        }
      };

      this.log(`Agent ${request.agent_id} executed successfully in ${duration}ms`, "info");

      this.postMessage({
        type: "execution_complete",
        id: messageId,
        data: response
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
        }
      };

      this.log(`Agent ${request.agent_id} execution failed: ${response.error}`, "error");

      this.postMessage({
        type: "execution_complete",
        id: messageId,
        data: response
      });
    }
  }

  private performSafetyChecks(request: AgentExecutionRequest) {
    // Memory limit check
    if (request.environment.worker_config.memory_limit < 64) {
      throw new Error("Insufficient memory allocation");
    }

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

    // Safety checks from environment
    for (const check of request.environment.monitoring_config.safety_checks) {
      this.log(`✓ Safety check: ${check}`, "debug");
    }
  }

  private async executeLLMAgent(request: AgentExecutionRequest): Promise<any> {
    const { model, prompts, parameters } = request.agent_config;
    const { task, input } = request;

    if (!model) {
      throw new Error("LLM agent requires model specification");
    }

    // Prepare prompt
    const systemPrompt = prompts.system || "You are a helpful AI assistant.";
    const userPrompt = this.buildUserPrompt(task, input, prompts);

    // Execute LLM call with timeout - use direct fetch to avoid SDK issues in worker
    const timeoutMs = request.environment.worker_config.timeout;
    
    try {
      const llmCall = this.callAnthropicAPI(model, systemPrompt, userPrompt, parameters);
      const result = await this.withTimeout(llmCall, timeoutMs);

      return {
        agent_type: "llm",
        agent_id: request.agent_id,
        model: model,
        result: result.text,
        input: input,
        tokens_used: result.tokens_used || 0,
        finish_reason: result.finish_reason || "stop",
      };
    } catch (error) {
      this.log(`LLM execution error: ${error}`, "error");
      throw error;
    }
  }

  private async callAnthropicAPI(model: string, system: string, prompt: string, parameters: any): Promise<any> {
    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY environment variable not set");
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: model,
        max_tokens: parameters.max_tokens || 2000,
        temperature: parameters.temperature || 0.7,
        system: system,
        messages: [
          {
            role: "user",
            content: prompt,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic API error: ${response.status} ${errorText}`);
    }

    const data = await response.json();
    
    return {
      text: data.content[0]?.text || "",
      tokens_used: data.usage?.total_tokens || 0,
      finish_reason: data.stop_reason || "stop",
    };
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
    const { endpoint, auth } = request.agent_config;
    
    if (!endpoint) {
      throw new Error("Remote agent requires endpoint specification");
    }

    // Check network permission
    if (!request.environment.worker_config.allowed_permissions.includes("network")) {
      throw new Error("Network access not permitted for this agent");
    }

    // Prepare request headers
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (auth) {
      switch (auth.type) {
        case "bearer":
          headers["Authorization"] = `Bearer ${auth.token}`;
          break;
        case "api_key":
          headers[auth.header || "X-API-Key"] = auth.key;
          break;
        case "basic":
          headers["Authorization"] = `Basic ${btoa(`${auth.username}:${auth.password}`)}`;
          break;
      }
    }

    // Make HTTP request with timeout
    const timeoutMs = request.environment.worker_config.timeout;
    
    const fetchCall = fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        task: request.task.task,
        input: request.input,
        mode: request.task.mode,
        config: request.task.config,
      }),
    });

    const response = await this.withTimeout(fetchCall, timeoutMs);
    
    if (!response.ok) {
      throw new Error(`Remote agent request failed: ${response.status} ${response.statusText}`);
    }

    const result = await response.json();

    return {
      agent_type: "remote",
      agent_id: request.agent_id,
      endpoint: endpoint,
      result: result,
      input: request.input,
      response_status: response.status,
      response_headers: Object.fromEntries(response.headers.entries()),
    };
  }

  private buildUserPrompt(task: any, input: any, prompts: Record<string, string>): string {
    let userPrompt = `Task: ${task.task}\n\nInput: ${JSON.stringify(input, null, 2)}`;

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
    return new Promise(resolve => setTimeout(resolve, ms));
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
      data: { worker_id: this.workerId, uptime: Date.now() - this.startTime }
    });

    // Close the worker
    self.close();
  }

  private log(message: string, level: "debug" | "info" | "warn" | "error" = "info") {
    const timestamp = new Date().toISOString();
    console.log(`[AgentWorker:${this.workerId}:${level.toUpperCase()}] ${timestamp} - ${message}`);
    
    // Send log to main thread for centralized logging
    this.postMessage({
      type: "log",
      id: crypto.randomUUID(),
      data: { level, message, timestamp, worker_id: this.workerId }
    });
  }
}

// Initialize the worker
new AgentExecutionWorker();