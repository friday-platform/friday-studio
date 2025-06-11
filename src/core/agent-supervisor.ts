/**
 * AgentSupervisor - Manages safe agent loading and execution with LLM intelligence
 */

import { BaseAgent } from "./agents/base-agent.ts";
import type {
  AgentConfig,
  AgentMetadata,
  AgentTask,
  LLMAgentConfig,
  RemoteAgentConfig,
  SessionContext,
  TempestAgentConfig,
} from "./session-supervisor.ts";

// Agent analysis and safety assessment
export interface AgentAnalysis {
  safety_assessment: {
    risk_level: "low" | "medium" | "high";
    identified_risks: string[];
    mitigations: string[];
  };
  resource_requirements: {
    memory_mb: number;
    timeout_seconds: number;
    required_capabilities: string[];
  };
  optimization_suggestions: {
    model_parameters: Record<string, any>;
    prompt_improvements: string[];
    tool_selections: string[];
  };
  execution_strategy: {
    isolation_level: "minimal" | "standard" | "strict";
    monitoring_required: boolean;
    validation_criteria: string[];
  };
}

// Prepared execution environment
export interface AgentEnvironment {
  worker_config: {
    memory_limit: number;
    timeout: number;
    allowed_permissions: string[];
    isolation_level: string;
  };
  agent_config: {
    type: string;
    model?: string;
    parameters: Record<string, any>;
    prompts: Record<string, string>;
    tools: string[];
    endpoint?: string;
    auth?: any;
  };
  monitoring_config: {
    log_level: string;
    metrics_collection: boolean;
    safety_checks: string[];
    output_validation: boolean;
  };
}

// Agent worker instance
export interface AgentWorkerInstance {
  id: string;
  agent_id: string;
  worker: Worker;
  environment: AgentEnvironment;
  created_at: Date;
  status: "initializing" | "ready" | "busy" | "error" | "terminated";
}

// Execution supervision configuration
export interface ExecutionSupervision {
  pre_execution_checks: string[];
  runtime_monitoring: {
    resource_usage: boolean;
    output_validation: boolean;
    safety_monitoring: boolean;
    timeout_enforcement: boolean;
  };
  post_execution_validation: {
    output_quality: boolean;
    success_criteria: boolean;
    security_compliance: boolean;
    format_validation: boolean;
  };
}

// Validation result
export interface ValidationResult {
  is_valid: boolean;
  quality_score: number;
  issues: Array<{
    type: "security" | "quality" | "format" | "completeness";
    severity: "low" | "medium" | "high";
    description: string;
    suggestion?: string;
  }>;
  recommendations: string[];
}

// Agent execution result with supervision metadata
export interface SupervisedAgentResult {
  agent_id: string;
  task: string;
  input: any;
  output: any;
  analysis: AgentAnalysis;
  environment: AgentEnvironment;
  supervision: ExecutionSupervision;
  validation: ValidationResult;
  execution_metadata: {
    duration: number;
    memory_used: number;
    safety_checks_passed: boolean;
    monitoring_events: any[];
  };
  timestamp: string;
}

export class AgentSupervisor extends BaseAgent {
  private activeWorkers: Map<string, AgentWorkerInstance> = new Map();
  private supervisorConfig: any;
  private supervisorCreatedAt: Date = new Date();
  private workerStats: Map<string, {
    created_at: Date;
    executions: number;
    total_duration: number;
    last_execution: Date;
    memory_peak: number;
  }> = new Map();

  constructor(supervisorConfig: any, parentScopeId?: string) {
    super(parentScopeId);
    this.supervisorConfig = supervisorConfig;

    // Set supervisor-specific prompts
    this.prompts = {
      system: supervisorConfig?.prompts?.system ||
        `You are an AgentSupervisor responsible for safe agent loading and execution.
        Your role is to:
        1. Analyze agents for safety and optimization before loading
        2. Prepare secure execution environments
        3. Monitor agent execution in real-time
        4. Validate outputs for quality and safety
        5. Handle failures and recovery scenarios
        
        Never load agents directly - always analyze, prepare, and supervise.`,
      user: "",
    };
  }

  name(): string {
    return "AgentSupervisor";
  }

  nickname(): string {
    return "Agent Supervisor";
  }

  version(): string {
    return "1.0.0";
  }

  provider(): string {
    return "atlas";
  }

  purpose(): string {
    return "Manages safe agent loading and supervised execution with LLM intelligence";
  }

  controls(): object {
    return {
      canAnalyze: true,
      canLoad: true,
      canMonitor: true,
      canValidate: true,
      canRecover: true,
    };
  }

  // Analyze agent before loading using LLM intelligence
  async analyzeAgent(
    agent: AgentMetadata,
    task: AgentTask,
    context: SessionContext,
  ): Promise<AgentAnalysis> {
    this.log(`Analyzing agent ${agent.id} for task execution`);

    const analysisPrompt = `Analyze this agent configuration and task for safe execution:

Agent Configuration:
- ID: ${agent.id}
- Type: ${agent.type}
- Purpose: ${agent.purpose}
- Config: ${JSON.stringify(agent.config, null, 2)}

Task Details:
- Task: ${task.task}
- Input Source: ${task.inputSource}
- Mode: ${task.mode || "standard"}
- Dependencies: ${task.dependencies?.join(", ") || "none"}

Session Context:
- Session ID: ${context.sessionId}
- Signal: ${context.signal.id}
- Constraints: ${JSON.stringify(context.constraints || {})}

Please analyze and provide:
1. Security risk assessment (low/medium/high)
2. Identified risks and appropriate mitigations
3. Resource requirements (memory, timeout, capabilities)
4. Optimization suggestions for better performance
5. Execution strategy recommendations

Focus on safety, efficiency, and reliability.`;

    try {
      const response = await this.generateLLM(
        this.supervisorConfig?.model || "claude-4-sonnet-20250514",
        this.prompts.system,
        analysisPrompt,
      );

      // Parse LLM response into structured analysis
      return this.parseAgentAnalysis(response, agent, task);
    } catch (error) {
      this.log(`Error analyzing agent ${agent.id}: ${error}`);
      // Return conservative analysis on error
      return this.createConservativeAnalysis(agent, task);
    }
  }

  // Parse LLM analysis response into structured format
  private parseAgentAnalysis(
    llmResponse: string,
    agent: AgentMetadata,
    task: AgentTask,
  ): AgentAnalysis {
    // For now, create analysis based on agent type and response content
    // In production, this would use structured parsing of LLM output

    const responseText = llmResponse.toLowerCase();

    // Determine risk level from response
    let riskLevel: "low" | "medium" | "high" = "medium";
    if (responseText.includes("high risk") || responseText.includes("dangerous")) {
      riskLevel = "high";
    } else if (responseText.includes("low risk") || responseText.includes("safe")) {
      riskLevel = "low";
    }

    // Base resource requirements on agent type
    let memoryMb = 256;
    let timeoutSeconds = 300;

    if (agent.type === "remote") {
      timeoutSeconds = 600; // Remote agents may need more time
    } else if (agent.type === "tempest") {
      memoryMb = 512; // Tempest agents may need more memory
    }

    return {
      safety_assessment: {
        risk_level: riskLevel,
        identified_risks: this.extractRisks(responseText, agent.type),
        mitigations: this.generateMitigations(agent.type, riskLevel),
      },
      resource_requirements: {
        memory_mb: memoryMb,
        timeout_seconds: timeoutSeconds,
        required_capabilities: this.extractCapabilities(agent, task),
      },
      optimization_suggestions: {
        model_parameters: this.generateModelParameters(agent),
        prompt_improvements: [],
        tool_selections: this.optimizeTools(agent),
      },
      execution_strategy: {
        isolation_level: riskLevel === "high" ? "strict" : "standard",
        monitoring_required: riskLevel !== "low",
        validation_criteria: this.generateValidationCriteria(task),
      },
    };
  }

  // Create conservative analysis when LLM analysis fails
  private createConservativeAnalysis(agent: AgentMetadata, task: AgentTask): AgentAnalysis {
    return {
      safety_assessment: {
        risk_level: "high", // Conservative approach
        identified_risks: ["Analysis failed - unknown risks"],
        mitigations: ["Strict isolation", "Enhanced monitoring", "Output validation"],
      },
      resource_requirements: {
        memory_mb: 512,
        timeout_seconds: 300,
        required_capabilities: ["basic-execution"],
      },
      optimization_suggestions: {
        model_parameters: {},
        prompt_improvements: [],
        tool_selections: [],
      },
      execution_strategy: {
        isolation_level: "strict",
        monitoring_required: true,
        validation_criteria: ["output_exists", "no_errors"],
      },
    };
  }

  // Prepare secure execution environment based on analysis
  async prepareEnvironment(
    agent: AgentMetadata,
    analysis: AgentAnalysis,
  ): Promise<AgentEnvironment> {
    this.log(
      `Preparing environment for agent ${agent.id} with ${analysis.execution_strategy.isolation_level} isolation`,
    );

    const modelValue = (agent.config as any).model;

    const environment: AgentEnvironment = {
      worker_config: {
        memory_limit: analysis.resource_requirements.memory_mb,
        timeout: analysis.resource_requirements.timeout_seconds * 1000,
        allowed_permissions: this.calculatePermissions(agent, analysis),
        isolation_level: analysis.execution_strategy.isolation_level,
      },
      agent_config: {
        type: agent.type,
        model: modelValue,
        parameters: {
          ...analysis.optimization_suggestions.model_parameters,
          safety_level: analysis.safety_assessment.risk_level,
        },
        prompts: this.preparePrompts(agent, analysis),
        tools: analysis.optimization_suggestions.tool_selections.length > 0
          ? analysis.optimization_suggestions.tool_selections
          : (agent.config as any).tools || [],
      },
      monitoring_config: {
        log_level: analysis.safety_assessment.risk_level === "high" ? "debug" : "info",
        metrics_collection: analysis.execution_strategy.monitoring_required,
        safety_checks: analysis.safety_assessment.mitigations,
        output_validation: true,
      },
    };

    // Add agent-type specific configuration
    if (agent.type === "remote") {
      const remoteConfig = agent.config as RemoteAgentConfig;
      environment.agent_config.endpoint = remoteConfig.endpoint;
      environment.agent_config.auth = remoteConfig.auth;
    } else if (agent.type === "tempest") {
      const tempestConfig = agent.config as TempestAgentConfig;
      environment.agent_config.parameters.agent = tempestConfig.agent;
      environment.agent_config.parameters.version = tempestConfig.version;
    }

    return environment;
  }

  // Load agent safely in web worker
  async loadAgentSafely(
    agent: AgentMetadata,
    environment: AgentEnvironment,
  ): Promise<AgentWorkerInstance> {
    this.log(`Loading agent ${agent.id} in secure worker`);

    // Create worker instance
    const workerId = `${agent.id}-${Date.now()}`;

    // Create actual web worker
    const workerScript = new URL("./workers/agent-execution-worker.ts", import.meta.url);
    const worker = new Worker(workerScript, {
      type: "module",
      name: `agent-worker-${agent.id}`,
    });

    const workerInstance: AgentWorkerInstance = {
      id: workerId,
      agent_id: agent.id,
      worker,
      environment,
      created_at: new Date(),
      status: "initializing",
    };

    // Set up worker communication
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(new Error(`Worker initialization timeout for agent ${agent.id}`));
      }, 10000); // 10 second timeout

      worker.addEventListener("message", (event) => {
        const { type, data } = event.data;

        switch (type) {
          case "ready":
            // Worker is ready, now initialize it
            worker.postMessage({
              type: "initialize",
              id: crypto.randomUUID(),
              data: {
                worker_id: workerId,
                environment,
                agent_config: agent.config,
              },
            });
            break;

          case "initialized":
            clearTimeout(timeout);
            workerInstance.status = "ready";
            this.activeWorkers.set(workerId, workerInstance);
            this.log(`Agent ${agent.id} loaded successfully as worker ${workerId}`);
            resolve(workerInstance);
            break;

          case "error":
            clearTimeout(timeout);
            worker.terminate();
            this.log(`Worker initialization failed for agent ${agent.id}: ${data.error}`);
            reject(new Error(`Worker initialization failed: ${data.error}`));
            break;

          case "log":
            // Forward worker logs to supervisor
            this.log(`[Worker:${data.worker_id}] ${data.message}`, data.level);
            break;
        }
      });

      worker.addEventListener("error", (error) => {
        clearTimeout(timeout);
        this.log(`Worker error for agent ${agent.id}: ${error.message}`);
        reject(new Error(`Worker error: ${error.message}`));
      });
    });
  }

  // Execute agent with supervision
  async executeAgentSupervised(
    instance: AgentWorkerInstance,
    input: any,
    task: AgentTask,
    supervision: ExecutionSupervision,
  ): Promise<SupervisedAgentResult> {
    this.log(`Executing agent ${instance.agent_id} with supervision`);

    const startTime = Date.now();
    instance.status = "busy";

    try {
      // Pre-execution checks
      await this.performPreExecutionChecks(instance, supervision);

      // Execute agent via worker communication
      const workerResult = await this.executeAgentInWorker(instance, input, task);

      // Post-execution validation
      const validation = await this.validateOutput(workerResult.output, task, supervision);

      const duration = Date.now() - startTime;

      // Update worker statistics
      this.updateWorkerStats(instance.id, duration, workerResult.metadata.memory_used);

      const result: SupervisedAgentResult = {
        agent_id: instance.agent_id,
        task: task.task,
        input,
        output: workerResult.output,
        analysis: {} as AgentAnalysis, // Would be stored from analysis phase
        environment: instance.environment,
        supervision,
        validation,
        execution_metadata: {
          duration,
          memory_used: workerResult.metadata.memory_used,
          safety_checks_passed: workerResult.metadata.safety_checks_passed,
          monitoring_events: [],
        },
        timestamp: new Date().toISOString(),
      };

      instance.status = "ready";
      this.log(`Agent ${instance.agent_id} execution completed successfully`);

      return result;
    } catch (error) {
      instance.status = "error";
      this.log(`Agent ${instance.agent_id} execution failed: ${error}`);
      throw error;
    }
  }

  // Validate agent output
  async validateOutput(
    output: any,
    task: AgentTask,
    supervision: ExecutionSupervision,
  ): Promise<ValidationResult> {
    if (!supervision.post_execution_validation.output_quality) {
      return { is_valid: true, quality_score: 1.0, issues: [], recommendations: [] };
    }

    const validationPrompt = `Validate this agent execution output:

Task: ${task.task}
Agent Output: ${JSON.stringify(output).slice(0, 1000)}...

Evaluate:
1. Task completion quality and accuracy
2. Output format and structure
3. Completeness and usefulness
4. Security and safety compliance

Provide validation assessment with quality score (0-1) and any issues found.`;

    try {
      const response = await this.generateLLM(
        "claude-4-sonnet-20250514",
        this.prompts.system,
        validationPrompt,
      );

      return this.parseValidationResult(response);
    } catch (error) {
      this.log(`Error validating output: ${error}`);
      return {
        is_valid: false,
        quality_score: 0.5,
        issues: [{ type: "quality", severity: "medium", description: "Validation failed" }],
        recommendations: ["Review output manually"],
      };
    }
  }

  // Clean up worker instance
  async terminateWorker(workerId: string): Promise<void> {
    const instance = this.activeWorkers.get(workerId);
    if (instance) {
      try {
        // Send graceful termination message to worker
        instance.worker.postMessage({
          type: "terminate",
          id: crypto.randomUUID(),
          data: { reason: "supervisor_cleanup" },
        });

        // Wait a short time for graceful shutdown
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (error) {
        this.log(`Error during graceful worker termination: ${error}`);
      } finally {
        // Force terminate worker
        instance.worker.terminate();
        instance.status = "terminated";
        this.activeWorkers.delete(workerId);
        this.log(`Worker ${workerId} terminated`);
      }
    }
  }

  // Helper methods
  private extractRisks(responseText: string, agentType: string): string[] {
    const risks = [];
    if (agentType === "remote") risks.push("External API dependency");
    if (responseText.includes("credential")) risks.push("Credential exposure");
    if (responseText.includes("injection")) risks.push("Code injection");
    return risks;
  }

  private generateMitigations(agentType: string, riskLevel: string): string[] {
    const mitigations = ["Worker isolation", "Output validation"];
    if (riskLevel === "high") mitigations.push("Enhanced monitoring", "Strict timeouts");
    if (agentType === "remote") mitigations.push("Request sanitization", "Response validation");
    return mitigations;
  }

  private extractCapabilities(agent: AgentMetadata, task: AgentTask): string[] {
    const capabilities = ["basic-execution"];
    if (agent.type === "llm") capabilities.push("text-processing");
    if (agent.type === "remote") capabilities.push("network-access");
    if (task.mode) capabilities.push(`mode-${task.mode}`);
    return capabilities;
  }

  private generateModelParameters(agent: AgentMetadata): Record<string, any> {
    if (agent.type === "llm") {
      return { temperature: 0.7, max_tokens: 2000 };
    }
    return {};
  }

  private optimizeTools(agent: AgentMetadata): string[] {
    const config = agent.config as any;
    return config.tools || [];
  }

  private generateValidationCriteria(task: AgentTask): string[] {
    return ["output_exists", "task_completed", "format_valid"];
  }

  private calculatePermissions(agent: AgentMetadata, analysis: AgentAnalysis): string[] {
    const permissions = ["read"];
    if (agent.type === "remote") permissions.push("network");
    if (analysis.safety_assessment.risk_level === "low") permissions.push("write");
    return permissions;
  }

  private preparePrompts(agent: AgentMetadata, analysis: AgentAnalysis): Record<string, string> {
    const config = agent.config as any;
    const prompts = { ...config.prompts };

    // Add safety instructions based on risk level
    if (analysis.safety_assessment.risk_level === "high") {
      prompts.safety =
        "CRITICAL: Follow all safety protocols. Do not execute any potentially harmful operations.";
    }

    return prompts;
  }

  private async performPreExecutionChecks(
    instance: AgentWorkerInstance,
    supervision: ExecutionSupervision,
  ): Promise<void> {
    // Mock pre-execution checks
    this.log(`Performing pre-execution checks for worker ${instance.id}`);
    for (const check of supervision.pre_execution_checks) {
      this.log(`Pre-execution check passed`, { checkType: check });
    }
  }

  // Execute agent in worker with real communication
  private async executeAgentInWorker(
    instance: AgentWorkerInstance,
    input: any,
    task: AgentTask,
  ): Promise<{ output: any; metadata: any }> {
    const messageId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Agent execution timeout after ${instance.environment.worker_config.timeout}ms`,
          ),
        );
      }, instance.environment.worker_config.timeout);

      // Listen for worker response
      const messageHandler = (event: MessageEvent) => {
        const { type, id, data } = event.data;

        if (id === messageId) {
          clearTimeout(timeout);
          instance.worker.removeEventListener("message", messageHandler);

          switch (type) {
            case "execution_complete":
              if (data.success) {
                resolve({
                  output: data.output,
                  metadata: data.metadata,
                });
              } else {
                reject(new Error(`Worker execution failed: ${data.error}`));
              }
              break;

            case "error":
              reject(new Error(`Worker error: ${data.error}`));
              break;

            default:
              // Ignore other message types
              break;
          }
        }
      };

      instance.worker.addEventListener("message", messageHandler);

      // Send execution request to worker
      instance.worker.postMessage({
        type: "execute",
        id: messageId,
        data: {
          agent_id: instance.agent_id,
          agent_config: instance.environment.agent_config,
          task,
          input,
          environment: instance.environment,
        },
      });
    });
  }

  private parseValidationResult(llmResponse: string): ValidationResult {
    // Simple parsing - in production would use structured output
    const responseText = llmResponse.toLowerCase();

    const isValid = !responseText.includes("invalid") && !responseText.includes("failed");
    const qualityScore = responseText.includes("excellent")
      ? 0.9
      : responseText.includes("good")
      ? 0.7
      : responseText.includes("poor")
      ? 0.3
      : 0.6;

    return {
      is_valid: isValid,
      quality_score: qualityScore,
      issues: [],
      recommendations: [],
    };
  }

  // Worker lifecycle management methods

  // Update worker statistics after execution
  private updateWorkerStats(workerId: string, duration: number, memoryUsed: number): void {
    let stats = this.workerStats.get(workerId);
    if (!stats) {
      stats = {
        created_at: new Date(),
        executions: 0,
        total_duration: 0,
        last_execution: new Date(),
        memory_peak: 0,
      };
    }

    stats.executions += 1;
    stats.total_duration += duration;
    stats.last_execution = new Date();
    stats.memory_peak = Math.max(stats.memory_peak, memoryUsed);

    this.workerStats.set(workerId, stats);
  }

  // Get worker performance metrics
  getWorkerMetrics(workerId?: string): Record<string, any> {
    if (workerId) {
      const stats = this.workerStats.get(workerId);
      const instance = this.activeWorkers.get(workerId);

      if (!stats || !instance) {
        return {};
      }

      return {
        worker_id: workerId,
        agent_id: instance.agent_id,
        status: instance.status,
        uptime: Date.now() - instance.created_at.getTime(),
        executions: stats.executions,
        average_duration: stats.executions > 0 ? stats.total_duration / stats.executions : 0,
        memory_peak: stats.memory_peak,
        last_execution: stats.last_execution,
      };
    }

    // Return metrics for all workers
    const allMetrics: Record<string, any> = {};
    for (const [id, instance] of this.activeWorkers) {
      allMetrics[id] = this.getWorkerMetrics(id);
    }
    return allMetrics;
  }

  // Monitor worker health and performance
  async monitorWorkers(): Promise<{
    healthy: number;
    unhealthy: number;
    idle: number;
    busy: number;
    total_memory: number;
  }> {
    let healthy = 0;
    let unhealthy = 0;
    let idle = 0;
    let busy = 0;
    let totalMemory = 0;

    for (const [workerId, instance] of this.activeWorkers) {
      const stats = this.workerStats.get(workerId);

      switch (instance.status) {
        case "ready":
          healthy++;
          idle++;
          break;
        case "busy":
          healthy++;
          busy++;
          break;
        case "error":
        case "terminated":
          unhealthy++;
          break;
        default:
          // initializing
          break;
      }

      if (stats) {
        totalMemory += stats.memory_peak;
      }
    }

    return {
      healthy,
      unhealthy,
      idle,
      busy,
      total_memory: totalMemory,
    };
  }

  // Clean up idle workers to free resources
  async cleanupIdleWorkers(maxIdleTime: number = 300000): Promise<number> { // 5 minutes default
    const now = Date.now();
    let cleanedUp = 0;

    for (const [workerId, instance] of this.activeWorkers) {
      const stats = this.workerStats.get(workerId);

      if (instance.status === "ready" && stats) {
        const idleTime = now - stats.last_execution.getTime();

        if (idleTime > maxIdleTime) {
          this.log(`Cleaning up idle worker ${workerId} (idle for ${idleTime}ms)`);
          await this.terminateWorker(workerId);
          cleanedUp++;
        }
      }
    }

    return cleanedUp;
  }

  // Get supervisor health status
  getHealthStatus(): {
    supervisor_id: string;
    status: "healthy" | "degraded" | "unhealthy";
    active_workers: number;
    total_executions: number;
    memory_usage: number;
    uptime: number;
  } {
    const totalExecutions = Array.from(this.workerStats.values())
      .reduce((sum, stats) => sum + stats.executions, 0);

    const totalMemory = Array.from(this.workerStats.values())
      .reduce((sum, stats) => sum + stats.memory_peak, 0);

    const activeWorkers = this.activeWorkers.size;

    let status: "healthy" | "degraded" | "unhealthy" = "healthy";
    if (activeWorkers > 10) {
      status = "degraded"; // Too many workers
    }
    if (totalMemory > 2048) { // Over 2GB total
      status = "unhealthy";
    }

    return {
      supervisor_id: this.id,
      status,
      active_workers: activeWorkers,
      total_executions: totalExecutions,
      memory_usage: totalMemory,
      uptime: Date.now() - this.supervisorCreatedAt.getTime(),
    };
  }
}
