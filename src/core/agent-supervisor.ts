/**
 * AgentSupervisor - Manages safe agent loading and execution with LLM intelligence
 */

import { logger } from "../utils/logger.ts";
import { BaseAgent } from "./agents/base-agent.ts";
import { AtlasTelemetry } from "../utils/telemetry.ts";
import type { AtlasMemoryConfig } from "./memory-config.ts";
import type {
  AgentMetadata,
  AgentTask,
  LLMAgentConfig,
  RemoteAgentConfig,
  SessionContext,
} from "./session-supervisor.ts";
import {
  type AgentExecutionContext,
  WorkspaceCapabilityRegistry,
} from "./workspace-capabilities.ts";
import { DaemonCapabilityRegistry } from "./daemon-capabilities.ts";
import { capabilitiesToTools } from "./utils/capability-to-tool.ts";
import {
  type AgentExecutePayload,
  type AgentExecutionCompletePayload,
  ATLAS_MESSAGE_TYPES,
  type AtlasMessageEnvelope,
  createAgentExecuteMessage,
  createAgentMessage,
  deserializeEnvelope,
  generateCorrelationId,
  isAgentExecutionCompleteMessage,
  isAgentLogMessage,
  type MessageSource,
} from "./utils/message-envelope.ts";
import {
  type AgentAnalysisResult,
  type CacheKeyContext,
  type OutputValidationResult,
  SupervisionCache,
  SupervisionLevel,
} from "./caching/supervision-cache.ts";
import { MemoryCacheAdapter } from "./caching/adapters/memory-cache-adapter.ts";
import {
  getSupervisionConfig,
  shouldRunAnalysis,
  shouldRunValidation,
  type SupervisionConfig,
} from "./supervision-levels.ts";
import { createHash } from "node:crypto";

// Supervisor configuration interface
interface AgentSupervisorConfig {
  model?: string;
  memoryConfig: AtlasMemoryConfig;
  sessionId?: string;
  workspaceId?: string;
  workspacePath?: string; // Workspace directory path for environment loading
  supervisionLevel?: SupervisionLevel;
  cacheEnabled?: boolean;
  workspaceTools?: { mcp?: { servers?: Record<string, any> } }; // Workspace tools configuration
  prompts?: {
    system?: string;
    user?: string;
  };
}

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
    model_parameters: Record<string, string | number | boolean>;
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
    parameters: Record<string, string | number | boolean>;
    prompts: Record<string, string>;
    tools: string[];
    mcp_servers?: string[]; // MCP server names
    mcp_server_configs?: Record<string, any>; // MCP server configurations
    endpoint?: string;
    protocol?: string;
    auth?: {
      type: "bearer" | "api_key" | "basic" | "none";
      token_env?: string;
      token?: string;
      api_key_env?: string;
      api_key?: string;
      header?: string;
      [key: string]: string | undefined;
    };
  };
  monitoring_config: {
    log_level: string;
    metrics_collection: boolean;
    safety_checks: string[];
    output_validation: boolean;
  };
  // MCP server configurations for worker access
  mcp_server_configs?: Record<string, any>;
  // Workspace path for environment loading
  workspace_path?: string;
  // Workspace tools metadata for capabilities
  workspace_tools_metadata?: Record<string, any>;
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
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  analysis: AgentAnalysis;
  environment: AgentEnvironment;
  supervision: ExecutionSupervision;
  validation: ValidationResult;
  execution_metadata: {
    duration: number;
    memory_used: number;
    safety_checks_passed: boolean;
    monitoring_events: Array<{
      timestamp: string;
      event_type: string;
      data: Record<string, unknown>;
    }>;
  };
  timestamp: string;
}

export class AgentSupervisor extends BaseAgent {
  private activeWorkers: Map<string, AgentWorkerInstance> = new Map();
  private supervisorConfig: AgentSupervisorConfig;
  private supervisorCreatedAt: Date = new Date();
  private sessionId?: string;
  private workspaceId?: string;
  private supervisionCache: SupervisionCache;
  private supervisionLevel: SupervisionLevel;
  private supervisionConfig: SupervisionConfig;
  private cacheEnabled: boolean;
  private sessionSupervisor?: any; // Reference to SessionSupervisor for MCP registry access
  private onStreamMessage?: (message: any) => void; // Callback for stream messages
  private responseChannel?: any; // Response channel for streaming
  private workerStats: Map<
    string,
    {
      created_at: Date;
      executions: number;
      total_duration: number;
      last_execution: Date;
      memory_peak: number;
    }
  > = new Map();

  constructor(supervisorConfig: AgentSupervisorConfig, parentScopeId?: string) {
    super(supervisorConfig.memoryConfig, parentScopeId);
    this.supervisorConfig = supervisorConfig;
    this.sessionId = supervisorConfig.sessionId;
    this.workspaceId = supervisorConfig.workspaceId;
    this.supervisionLevel = supervisorConfig.supervisionLevel || SupervisionLevel.STANDARD;
    this.supervisionConfig = getSupervisionConfig(this.supervisionLevel);
    this.cacheEnabled = this.supervisionConfig.cacheEnabled &&
      (supervisorConfig.cacheEnabled !== false);

    // Initialize supervision cache
    const cacheAdapter = new MemoryCacheAdapter();
    this.supervisionCache = new SupervisionCache(cacheAdapter, {
      defaultTtl: 60 * 60 * 1000, // 1 hour cache
      maxEntries: 5000,
    });

    // Override logger from BaseAgent with proper supervisor context
    this.logger = logger.createChildLogger({
      supervisorId: this.id,
      workerType: "agent-supervisor",
    });

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

  // Set reference to SessionSupervisor for MCP registry access
  setSessionSupervisor(sessionSupervisor: any): void {
    this.sessionSupervisor = sessionSupervisor;
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

  // Set callback for stream messages from agents
  setStreamCallback(callback: (message: any) => void): void {
    this.onStreamMessage = callback;
  }

  setResponseChannel(responseChannel: any): void {
    this.responseChannel = responseChannel;
  }

  // Analyze agent before loading using LLM intelligence
  async analyzeAgent(
    agent: AgentMetadata,
    task: AgentTask,
    context: SessionContext,
  ): Promise<AgentAnalysis> {
    // Check if analysis should be skipped based on supervision level
    if (!shouldRunAnalysis(this.supervisionLevel)) {
      this.logger.debug(
        `Skipping analysis for agent ${agent.id} (supervision level: ${this.supervisionLevel})`,
      );
      return this.getMinimalAnalysis(agent, task);
    }

    const analysisStart = Date.now();
    this.logger.debug(`Starting analysis for agent ${agent.id}`, { agentType: agent.type });

    // Try cache first if enabled
    if (this.cacheEnabled) {
      const cacheContext = this.createCacheContext(agent, task, context);
      const cached = await this.supervisionCache.getAnalysis(cacheContext);

      if (cached) {
        this.logger.debug(`Cache hit for agent analysis: ${agent.id}`, {
          cacheKey: this.supervisionCache.generateAnalysisKey(cacheContext),
          riskLevel: cached.riskLevel,
        });

        // Convert cached result to AgentAnalysis format
        return this.convertCachedAnalysis(cached, agent, task);
      }

      this.logger.debug(`Cache miss for agent analysis: ${agent.id}`, {
        cacheKey: this.supervisionCache.generateAnalysisKey(cacheContext),
      });
    }

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
        this.supervisorConfig?.model || "claude-3-5-sonnet-20241022",
        this.prompts.system,
        analysisPrompt,
      );

      // Parse LLM response into structured analysis
      const analysis = this.parseAgentAnalysis(response, agent, task);
      const analysisDuration = Date.now() - analysisStart;

      // Cache the analysis result if enabled
      if (this.cacheEnabled) {
        const cacheContext = this.createCacheContext(agent, task, context);
        const cacheableResult: AgentAnalysisResult = {
          riskLevel: analysis.safety_assessment.risk_level,
          requiredIsolation: analysis.execution_strategy.isolation_level,
          preExecutionChecks: ["safety_check", "resource_check", "permission_check"],
          estimatedDuration: analysisDuration,
          analysis: JSON.stringify(analysis),
          confidence: 0.8, // TODO: Extract from LLM response
        };

        await this.supervisionCache.setAnalysis(cacheContext, cacheableResult);
        this.logger.debug(`Cached agent analysis: ${agent.id}`, {
          cacheKey: this.supervisionCache.generateAnalysisKey(cacheContext),
          duration: analysisDuration,
        });
      }

      this.logger.debug(`Agent analysis completed in ${analysisDuration}ms`, {
        agentId: agent.id,
        riskLevel: analysis.safety_assessment.risk_level,
        isolationLevel: analysis.execution_strategy.isolation_level,
      });

      return analysis;
    } catch (error) {
      const analysisDuration = Date.now() - analysisStart;
      this.logger.error(`Agent analysis failed after ${analysisDuration}ms: ${error}`, {
        agentId: agent.id,
      });
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
    if (
      responseText.includes("high risk") ||
      responseText.includes("dangerous")
    ) {
      riskLevel = "high";
    } else if (
      responseText.includes("low risk") ||
      responseText.includes("safe")
    ) {
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
  private createConservativeAnalysis(
    _agent: AgentMetadata,
    _task: AgentTask,
  ): AgentAnalysis {
    return {
      safety_assessment: {
        risk_level: "high", // Conservative approach
        identified_risks: ["Analysis failed - unknown risks"],
        mitigations: [
          "Strict isolation",
          "Enhanced monitoring",
          "Output validation",
        ],
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

  // Create minimal analysis for performance when detailed analysis is disabled
  private getMinimalAnalysis(agent: AgentMetadata, task: AgentTask): AgentAnalysis {
    return {
      safety_assessment: {
        risk_level: "low",
        identified_risks: [],
        mitigations: ["Basic safety checks applied"],
      },
      resource_requirements: {
        memory_mb: 256,
        timeout_seconds: 300,
        required_capabilities: ["read", "write"],
      },
      optimization_suggestions: {
        model_parameters: {},
        prompt_improvements: [],
        tool_selections: [],
      },
      execution_strategy: {
        isolation_level: "standard",
        monitoring_required: false,
        validation_criteria: [],
      },
    };
  }

  // Prepare secure execution environment based on analysis
  prepareEnvironment(
    agent: AgentMetadata,
    analysis: AgentAnalysis,
  ): AgentEnvironment {
    this.log(
      `Preparing environment for agent ${agent.id} with ${analysis.execution_strategy.isolation_level} isolation`,
    );

    const modelValue = (agent.config as LLMAgentConfig).model;

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
          // Include provider for LLM agents
          ...(agent.type === "llm" && (agent.config as LLMAgentConfig).provider && {
            provider: (agent.config as LLMAgentConfig).provider,
          }),
        },
        prompts: this.preparePrompts(agent, analysis),
        tools: analysis.optimization_suggestions.tool_selections.length > 0
          ? analysis.optimization_suggestions.tool_selections
          : (agent.config as LLMAgentConfig).tools || [],
        mcp_servers: this.prepareAgentMcpServerNames(agent),
        mcp_server_configs: this.prepareAgentMcpServerConfigs(agent),
      },
      monitoring_config: {
        log_level: analysis.safety_assessment.risk_level === "high" ? "debug" : "info",
        metrics_collection: analysis.execution_strategy.monitoring_required,
        safety_checks: analysis.safety_assessment.mitigations,
        output_validation: true,
      },
      // Include workspace path for .env file loading in worker context
      workspace_path: this.supervisorConfig.workspacePath,
    };

    // Note: Workspace tools are now prepared as metadata only (see below)
    // to avoid DataCloneError when passing functions to workers

    // Add agent-type specific configuration
    if (agent.type === "remote") {
      const remoteConfig = agent.config as RemoteAgentConfig;
      environment.agent_config.endpoint = remoteConfig.endpoint;
      environment.agent_config.auth = remoteConfig.auth;

      // Add protocol at root level for worker validation
      if (remoteConfig.protocol) {
        (environment.agent_config as any).protocol = remoteConfig.protocol;
        // Also keep in parameters for backward compatibility
        environment.agent_config.parameters.protocol = remoteConfig.protocol;
      }

      // Copy ACP configuration
      if (remoteConfig.acp) {
        if (remoteConfig.acp.agent_name) {
          environment.agent_config.parameters.agent_name = remoteConfig.acp.agent_name;
        }
        if (remoteConfig.acp.default_mode) {
          environment.agent_config.parameters.default_mode = remoteConfig.acp.default_mode;
        }
        if (remoteConfig.acp.max_retries !== undefined) {
          environment.agent_config.parameters.max_retries = remoteConfig.acp.max_retries;
        }
        if (remoteConfig.acp.health_check_interval !== undefined) {
          environment.agent_config.parameters.health_check_interval =
            remoteConfig.acp.health_check_interval;
        }
      }
    } else if (agent.type === "tempest") {
      // Access tempest-specific fields directly from agent.config
      if (agent.config.agent) {
        environment.agent_config.parameters.agent = agent.config.agent;
      }
      if (agent.config.version) {
        environment.agent_config.parameters.version = agent.config.version;
      }
      // Ensure tools are passed for tempest agents
      if (
        agent.config.tools && Array.isArray(agent.config.tools) && agent.config.tools.length > 0
      ) {
        environment.agent_config.tools = agent.config.tools;
      }
    }

    // Add MCP server configurations for worker access
    environment.mcp_server_configs = this.prepareAgentMcpServerConfigs(agent);

    // Add workspace tools metadata if agent has tools configured
    let agentTools: string[] | undefined;
    if (agent.type === "llm") {
      const llmConfig = agent.config as LLMAgentConfig;
      agentTools = llmConfig.tools;
    } else if (agent.type === "tempest") {
      agentTools = agent.config.tools;
    }

    this.log(`Agent ${agent.id} config tools: ${JSON.stringify(agentTools)}`, "debug");
    if (agentTools && agentTools.length > 0) {
      const workspaceToolsMetadata = this.prepareWorkspaceToolsMetadata(agent, agentTools);
      if (workspaceToolsMetadata) {
        environment.workspace_tools_metadata = workspaceToolsMetadata;
        this.log(
          `Added ${
            Object.keys(workspaceToolsMetadata).length
          } workspace tools metadata to agent environment`,
        );
      } else {
        this.log(`No workspace tools prepared for agent ${agent.id}`, "warn");
      }
    }

    return environment;
  }

  // Get MCP server names for agent based on agent configuration
  private prepareAgentMcpServerNames(agent: AgentMetadata): string[] | undefined {
    // Only provide MCP servers to LLM agents that have mcp_servers configured
    if (agent.type !== "llm") {
      return undefined;
    }

    const llmConfig = agent.config as LLMAgentConfig;
    const agentMcpServerNames = llmConfig.mcp_servers;

    if (
      !agentMcpServerNames || !Array.isArray(agentMcpServerNames) ||
      agentMcpServerNames.length === 0
    ) {
      return undefined;
    }

    const workspaceTools = this.supervisorConfig.workspaceTools;
    const workspaceMcpServers = workspaceTools?.mcp?.servers;
    if (!workspaceMcpServers) {
      this.log(
        `Agent ${agent.id} requests MCP servers ${
          agentMcpServerNames.join(", ")
        } but no workspace MCP servers available`,
        "warn",
      );
      return undefined;
    }

    // Filter to only include server names that are actually configured in workspace
    const availableServerNames: string[] = [];
    for (const serverName of agentMcpServerNames) {
      if (workspaceMcpServers[serverName]) {
        availableServerNames.push(serverName);
        this.log(`Providing MCP server ${serverName} to agent ${agent.id}`);
      } else {
        this.log(
          `Agent ${agent.id} requests MCP server ${serverName} but it's not configured in workspace`,
          "warn",
        );
      }
    }

    return availableServerNames.length > 0 ? availableServerNames : undefined;
  }

  // Get MCP server configurations for agent from registry via SessionSupervisor
  private prepareAgentMcpServerConfigs(agent: AgentMetadata): Record<string, any> | undefined {
    // Only provide MCP servers to LLM agents that have mcp_servers configured
    if (agent.type !== "llm") {
      return undefined;
    }

    const llmConfig = agent.config as LLMAgentConfig;
    const agentMcpServerNames = llmConfig.mcp_servers;

    if (
      !agentMcpServerNames || !Array.isArray(agentMcpServerNames) ||
      agentMcpServerNames.length === 0
    ) {
      return undefined;
    }

    // Get the configurations from the registry via SessionSupervisor
    if (
      !this.sessionSupervisor ||
      typeof this.sessionSupervisor.getMcpServerConfigsForAgent !== "function"
    ) {
      this.log(
        `SessionSupervisor not available or missing getMcpServerConfigsForAgent method for agent ${agent.id}`,
        "warn",
      );
      return undefined;
    }

    const configs = this.sessionSupervisor.getMcpServerConfigsForAgent(
      agent.id,
      agentMcpServerNames,
    );

    if (!configs || configs.length === 0) {
      this.log(`No MCP server configs retrieved from registry for agent ${agent.id}`, "warn");
      return undefined;
    }

    // Convert array of configs to object keyed by server ID
    const configsObj: Record<string, any> = {};
    for (const config of configs) {
      configsObj[config.id] = config;
    }

    this.log(`Prepared ${configs.length} MCP server configs for agent ${agent.id}`);

    return configsObj;
  }

  // Load agent safely in web worker with envelope communication
  loadAgentSafely(
    agent: AgentMetadata,
    environment: AgentEnvironment,
    traceHeaders?: Record<string, string>,
  ): Promise<AgentWorkerInstance> {
    this.log(`Loading agent ${agent.id} in secure worker`);

    // Create worker instance
    const workerId = `${agent.id}-${Date.now()}`;

    // Create actual web worker
    const workerScript = new URL(
      "./workers/agent-execution-worker.ts",
      import.meta.url,
    );
    const worker = new Worker(workerScript, {
      type: "module",
      name: `agent-worker-${agent.id}`,
      deno: {
        permissions: {
          read: true,
          write: true,
          net: true, // Allow network access for daemon communication
          env: true, // Allow environment variable access
          run: true, // Allow process execution for MCP servers
          ffi: false, // Restrict FFI access
        },
      },
    });

    const workerInstance: AgentWorkerInstance = {
      id: workerId,
      agent_id: agent.id,
      worker,
      environment,
      created_at: new Date(),
      status: "initializing",
    };

    // Set up worker communication with envelope support
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        worker.terminate();
        reject(
          new Error(`Worker initialization timeout for agent ${agent.id}`),
        );
      }, 10000); // 10 second timeout

      const messageSource = this.createMessageSource();
      let initializeMessageId: string | null = null;

      worker.addEventListener("message", (event) => {
        // Parse envelope message
        let envelope: AtlasMessageEnvelope | undefined;

        if (typeof event.data === "string") {
          const result = deserializeEnvelope(event.data);
          if (result.envelope) {
            envelope = result.envelope;
          } else {
            this.log(`Failed to deserialize envelope: ${result.error}`);
            return;
          }
        } else if (
          event.data && typeof event.data === "object" && event.data.type && event.data.domain
        ) {
          envelope = event.data as AtlasMessageEnvelope;
        } else {
          this.log(`Received non-envelope message, ignoring: ${JSON.stringify(event.data)}`);
          return;
        }

        if (envelope) {
          switch (envelope.type) {
            case ATLAS_MESSAGE_TYPES.LIFECYCLE.READY:
              // Worker is ready, now initialize it with envelope
              (async () => {
                const currentTraceHeaders = traceHeaders ||
                  await AtlasTelemetry.createTraceHeaders();
                // Debug: check for non-serializable data
                try {
                  // Test if environment can be cloned
                  const testClone = structuredClone(environment);
                  this.log(`Environment is serializable`);
                } catch (e) {
                  this.log(`Environment contains non-serializable data: ${e}`, "error");
                  // Log the keys of environment to debug
                  this.log(`Environment keys: ${Object.keys(environment).join(", ")}`, "error");
                }

                const initMessage = createAgentMessage(
                  ATLAS_MESSAGE_TYPES.LIFECYCLE.INIT,
                  {
                    worker_id: workerId,
                    environment,
                    agent_config: agent.config,
                  },
                  messageSource,
                  {
                    traceHeaders: currentTraceHeaders,
                    destination: {
                      workerId,
                      workerType: "agent-execution",
                    },
                    priority: "high",
                  },
                );
                initializeMessageId = initMessage.id;
                worker.postMessage(initMessage);
              })();
              break;

            case ATLAS_MESSAGE_TYPES.LIFECYCLE.INITIALIZED:
              if (
                envelope.correlationId === initializeMessageId ||
                envelope.parentMessageId === initializeMessageId
              ) {
                clearTimeout(timeout);
                workerInstance.status = "ready";
                this.activeWorkers.set(workerId, workerInstance);
                this.log(
                  `Agent ${agent.id} loaded successfully as worker ${workerId}`,
                );
                resolve(workerInstance);
              }
              break;

            case ATLAS_MESSAGE_TYPES.TASK.ERROR:
            case ATLAS_MESSAGE_TYPES.LIFECYCLE.TERMINATED: {
              clearTimeout(timeout);
              worker.terminate();
              const errorMsg = envelope.error?.message || "Worker initialization failed";
              this.log(
                `Worker initialization failed for agent ${agent.id}: ${errorMsg}`,
              );
              reject(new Error(`Worker initialization failed: ${errorMsg}`));
              break;
            }

            default:
              if (isAgentLogMessage(envelope)) {
                const logPayload = envelope.payload;
                this.logger[logPayload.level](
                  `[Worker:${logPayload.agent_id}] ${logPayload.message}`,
                  logPayload.metadata,
                );
              }
              break;
          }
        }
      });

      worker.addEventListener("error", (error) => {
        clearTimeout(timeout);
        this.log(`Worker error for agent ${agent.id}: ${error.message}`);
        reject(new Error(`Worker error: ${error.message}`));
      });
    });
  }

  // Create MessageSource for envelope communication
  private createMessageSource(): MessageSource {
    return {
      workerId: this.id,
      workerType: "agent-supervisor", // AgentSupervisor is its own worker type
      sessionId: this.sessionId,
      workspaceId: this.workspaceId,
    };
  }

  // Execute agent with supervision
  async executeAgentSupervised(
    instance: AgentWorkerInstance,
    input: Record<string, unknown>,
    task: AgentTask,
    supervision: ExecutionSupervision,
    traceHeaders?: Record<string, string>,
  ): Promise<SupervisedAgentResult> {
    return await AtlasTelemetry.withWorkerSpan(
      {
        operation: "executeAgentSupervised",
        component: "agent",
        traceHeaders,
        workerId: this.id,
        sessionId: this.sessionId,
        workspaceId: this.workspaceId,
        agentId: instance.agent_id,
        agentType: instance.environment.agent_config.type,
      },
      async (span) => {
        this.log(`Executing agent ${instance.agent_id} with supervision`);

        const startTime = Date.now();
        instance.status = "busy";

        try {
          // Pre-execution checks
          const preCheckStart = Date.now();
          this.performPreExecutionChecks(instance, supervision);
          const preCheckDuration = Date.now() - preCheckStart;
          this.logger.debug(`Pre-execution checks completed in ${preCheckDuration}ms`);

          // Execute agent via worker communication with envelope format
          const executionStart = Date.now();
          const workerResult = await this.executeAgentInWorker(instance, input, task, traceHeaders);
          const executionDuration = Date.now() - executionStart;
          this.log(`Agent ${instance.agent_id} executed successfully in ${executionDuration}ms`);

          // Post-execution validation
          const validationStart = Date.now();
          const validation = await this.validateOutput(workerResult.output, task, supervision);
          const validationDuration = Date.now() - validationStart;
          this.logger.debug(`Output validation completed in ${validationDuration}ms`);

          const duration = Date.now() - startTime;

          // Update worker statistics
          this.updateWorkerStats(
            instance.id,
            duration,
            workerResult.metadata.memory_used as number,
          );

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
              memory_used: workerResult.metadata.memory_used as number,
              safety_checks_passed: workerResult.metadata.safety_checks_passed as boolean,
              monitoring_events: [],
            },
            timestamp: new Date().toISOString(),
          };

          instance.status = "ready";
          this.log(`Agent ${instance.agent_id} execution completed successfully`);

          // Add span attributes for telemetry
          span?.setAttribute("agent.execution.duration", duration);
          span?.setAttribute(
            "agent.execution.memory_used",
            workerResult.metadata.memory_used as number,
          );
          span?.setAttribute("agent.execution.status", "success");

          return result;
        } catch (error) {
          instance.status = "error";
          this.log(`Agent ${instance.agent_id} execution failed: ${error}`, "error", {
            agentId: instance.agent_id,
            duration: Date.now() - startTime,
            errorType: error instanceof Error ? error.name : "UnknownError",
          });

          // Add error attributes to span
          span?.setAttribute("agent.execution.status", "error");
          span?.setAttribute(
            "agent.execution.error",
            error instanceof Error ? error.message : String(error),
          );

          throw error;
        }
      },
    );
  }

  // Validate agent output
  async validateOutput(
    output: Record<string, unknown>,
    task: AgentTask,
    supervision: ExecutionSupervision,
  ): Promise<ValidationResult> {
    // Check if validation should be skipped based on supervision level
    if (!shouldRunValidation(this.supervisionLevel)) {
      this.logger.debug(`Skipping output validation (supervision level: ${this.supervisionLevel})`);
      return {
        is_valid: true,
        quality_score: 1.0,
        issues: [],
        recommendations: [],
      };
    }

    if (!supervision.post_execution_validation.output_quality) {
      return {
        is_valid: true,
        quality_score: 1.0,
        issues: [],
        recommendations: [],
      };
    }

    // Check cache first for validation results
    if (this.cacheEnabled) {
      const outputHash = this.hashObject(output);
      const cacheContext: CacheKeyContext = {
        agentId: "validation", // Generic for output validation
        agentType: "validation",
        inputHash: this.hashObject({ task: task.task, outputHash }),
        supervisionLevel: this.supervisionLevel,
      };

      const cached = await this.supervisionCache.getValidation(cacheContext, outputHash);
      if (cached) {
        this.logger.debug(`Cache hit for output validation`, {
          outputHash,
          validationScore: cached.riskScore,
        });

        return {
          is_valid: cached.isValid,
          quality_score: 1.0 - cached.riskScore, // Convert risk to quality
          issues: cached.findings.map((f) => ({
            type: f.type as "security" | "quality" | "format" | "completeness",
            severity: f.severity,
            description: f.description,
          })),
          recommendations: cached.recommendations,
        };
      }
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
        "claude-3-5-sonnet-20241022",
        this.prompts.system,
        validationPrompt,
      );

      const validation = this.parseValidationResult(response);

      // Cache the validation result
      if (this.cacheEnabled) {
        const outputHash = this.hashObject(output);
        const cacheContext: CacheKeyContext = {
          agentId: "validation",
          agentType: "validation",
          inputHash: this.hashObject({ task: task.task, outputHash }),
          supervisionLevel: this.supervisionLevel,
        };

        const cacheableResult: OutputValidationResult = {
          isValid: validation.is_valid,
          riskScore: 1.0 - validation.quality_score,
          findings: validation.issues.map((issue) => ({
            type: issue.type,
            severity: issue.severity,
            description: issue.description,
          })),
          recommendations: validation.recommendations,
          confidence: 0.8,
        };

        await this.supervisionCache.setValidation(cacheContext, outputHash, cacheableResult);
      }

      return validation;
    } catch (error) {
      this.log(`Error validating output: ${error}`);
      return {
        is_valid: false,
        quality_score: 0.5,
        issues: [
          {
            type: "quality",
            severity: "medium",
            description: "Validation failed",
          },
        ],
        recommendations: ["Review output manually"],
      };
    }
  }

  // Clean up worker instance with envelope communication
  async terminateWorker(workerId: string): Promise<void> {
    const instance = this.activeWorkers.get(workerId);
    if (instance) {
      try {
        // Send graceful termination message using envelope format
        const messageSource = this.createMessageSource();
        const traceHeaders = await AtlasTelemetry.createTraceHeaders();

        const terminateMessage = createAgentMessage(
          ATLAS_MESSAGE_TYPES.LIFECYCLE.TERMINATE,
          { reason: "supervisor_cleanup" },
          messageSource,
          {
            traceHeaders,
            destination: {
              workerId: instance.id,
              workerType: "agent-execution",
            },
            priority: "high",
          },
        );

        instance.worker.postMessage(terminateMessage);

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
    if (riskLevel === "high") {
      mitigations.push("Enhanced monitoring", "Strict timeouts");
    }
    if (agentType === "remote") {
      mitigations.push("Request sanitization", "Response validation");
    }
    return mitigations;
  }

  private extractCapabilities(agent: AgentMetadata, task: AgentTask): string[] {
    const capabilities = ["basic-execution"];
    if (agent.type === "llm") capabilities.push("text-processing");
    if (agent.type === "remote") capabilities.push("network-access");
    if (task.mode) capabilities.push(`mode-${task.mode}`);
    return capabilities;
  }

  private generateModelParameters(agent: AgentMetadata): Record<string, string | number | boolean> {
    if (agent.type === "llm") {
      return { temperature: 0.7, max_tokens: 2000 };
    }
    return {};
  }

  private optimizeTools(agent: AgentMetadata): string[] {
    const config = agent.config as LLMAgentConfig;
    return config.tools || [];
  }

  private generateValidationCriteria(_task: AgentTask): string[] {
    return ["output_exists", "task_completed", "format_valid"];
  }

  // Prepare workspace capability tools metadata for agent (serializable)
  private prepareWorkspaceToolsMetadata(
    agent: AgentMetadata,
    requestedTools: string[],
  ): Record<string, any> | undefined {
    this.log(
      `Preparing workspace tools metadata for agent ${agent.id}, requested: ${
        JSON.stringify(requestedTools)
      }`,
      "debug",
    );

    if (!this.sessionSupervisor) {
      this.log(`No session supervisor available for workspace tools`, "warn");
      return undefined;
    }

    // Filter capabilities based on what the agent has declared
    const capabilities = WorkspaceCapabilityRegistry.filterCapabilitiesForAgent({
      agentId: agent.id,
      agentConfig: agent.config as any,
      grantedTools: requestedTools,
    });

    this.log(`Filtered ${capabilities.length} capabilities for agent ${agent.id}`, "debug");

    if (capabilities.length === 0) {
      return undefined;
    }

    // Create metadata-only tools (serializable)
    const toolsMetadata: Record<string, any> = {};

    for (const capability of capabilities) {
      toolsMetadata[capability.id] = {
        description: capability.description,
        inputSchema: capability.inputSchema || {
          type: "object",
          properties: {},
          required: [],
        },
      };
    }

    this.log(
      `Created ${Object.keys(toolsMetadata).length} workspace tools metadata for agent ${agent.id}`,
      "debug",
      {
        tools: Object.keys(toolsMetadata),
      },
    );

    return toolsMetadata;
  }

  // Prepare workspace capability tools for agent
  private prepareWorkspaceTools(
    agent: AgentMetadata,
    requestedTools: string[],
  ): Record<string, any> | undefined {
    this.log(
      `Preparing workspace tools for agent ${agent.id}, requested: ${
        JSON.stringify(requestedTools)
      }`,
      "debug",
    );

    if (!this.sessionSupervisor) {
      this.log(`No session supervisor available for workspace tools`, "warn");
      return undefined;
    }

    // Create agent execution context for capabilities
    const context: AgentExecutionContext = {
      workspaceId: this.workspaceId || "",
      sessionId: this.sessionId || "",
      agentId: agent.id,
      sessionSupervisor: this.sessionSupervisor,
      responseChannel: this.responseChannel,
    };

    // Filter capabilities based on what the agent has declared
    const capabilities = WorkspaceCapabilityRegistry.filterCapabilitiesForAgent({
      agentId: agent.id,
      agentConfig: agent.config as any,
      grantedTools: requestedTools,
    });

    this.log(`Filtered ${capabilities.length} capabilities for agent ${agent.id}`, "debug");

    if (capabilities.length === 0) {
      return undefined;
    }

    // Convert capabilities to AI SDK tools
    const tools = capabilitiesToTools(capabilities, context);

    this.log(
      `Converted ${capabilities.length} workspace capabilities to tools for agent ${agent.id}`,
      "debug",
      {
        capabilities: capabilities.map((c) => c.id),
      },
    );

    return tools;
  }

  private calculatePermissions(
    agent: AgentMetadata,
    analysis: AgentAnalysis,
  ): string[] {
    const permissions = ["read"];
    if (agent.type === "remote") permissions.push("network");
    if (analysis.safety_assessment.risk_level === "low") {
      permissions.push("write");
    }
    return permissions;
  }

  private preparePrompts(agent: AgentMetadata, analysis: AgentAnalysis): Record<string, string> {
    const config = agent.config as LLMAgentConfig;
    const prompts = { ...config.prompts };

    // Add safety instructions based on risk level
    if (analysis.safety_assessment.risk_level === "high") {
      prompts.safety =
        "CRITICAL: Follow all safety protocols. Do not execute any potentially harmful operations.";
    }

    return prompts as Record<string, string>;
  }

  private performPreExecutionChecks(
    instance: AgentWorkerInstance,
    supervision: ExecutionSupervision,
  ): void {
    const checksStart = Date.now();

    // Mock pre-execution checks - in production these would be real validations
    // Example checks: worker health, resource availability, permissions, etc.

    const checksDuration = Date.now() - checksStart;
    this.logger.debug(
      `All ${supervision.pre_execution_checks.length} pre-execution checks passed in ${checksDuration}ms`,
      {
        workerId: instance.id,
        checks: supervision.pre_execution_checks,
      },
    );
  }

  // Execute agent in worker with envelope communication
  private async executeAgentInWorker(
    instance: AgentWorkerInstance,
    input: Record<string, unknown>,
    task: AgentTask,
    traceHeaders?: Record<string, string>,
  ): Promise<{ output: Record<string, unknown>; metadata: Record<string, unknown> }> {
    const correlationId = generateCorrelationId();
    const messageSource = this.createMessageSource();

    // Create the envelope message payload
    const payload: AgentExecutePayload = {
      agent_id: instance.agent_id,
      agent_config: instance.environment.agent_config,
      task: task.task,
      input,
      environment: instance.environment as unknown as Record<string, unknown>,
    };

    // Create trace headers for this worker operation
    const currentTraceHeaders = traceHeaders || await AtlasTelemetry.createTraceHeaders();

    // Create envelope message using the standardized format
    const executeMessage = createAgentExecuteMessage(
      payload,
      messageSource,
      {
        correlationId,
        traceHeaders: currentTraceHeaders,
        destination: {
          workerId: instance.id,
          workerType: "agent-execution",
          sessionId: this.sessionId,
          workspaceId: this.workspaceId,
        },
        priority: "normal",
        timeout: instance.environment.worker_config.timeout,
        acknowledgmentRequired: true,
      },
    );

    this.logger.debug("Sending envelope message to agent worker", {
      agentId: instance.agent_id,
      messageId: executeMessage.id,
      correlationId,
      messageType: executeMessage.type,
      domain: executeMessage.domain,
    });

    return new Promise((resolve, reject) => {
      // Set up timeout
      const timeout = setTimeout(() => {
        reject(
          new Error(
            `Agent execution timeout after ${instance.environment.worker_config.timeout}ms`,
          ),
        );
      }, instance.environment.worker_config.timeout);

      // Listen for worker response using envelope format
      const messageHandler = (event: MessageEvent) => {
        // Parse envelope message
        let envelope: AtlasMessageEnvelope | undefined;

        if (typeof event.data === "string") {
          const result = deserializeEnvelope(event.data);
          if (result.envelope) {
            envelope = result.envelope;
          } else {
            this.logger.debug(`Failed to deserialize envelope response: ${result.error}`);
            return;
          }
        } else if (
          event.data && typeof event.data === "object" && event.data.type && event.data.domain
        ) {
          envelope = event.data as AtlasMessageEnvelope;
        } else if (event.data && typeof event.data === "object" && event.data.type === "stream") {
          // Forward stream messages to session supervisor
          // Forward the stream message up the chain
          if (this.onStreamMessage) {
            this.onStreamMessage(event.data);
          }
          return;
        } else {
          this.logger.debug(
            `Received non-envelope response, ignoring: ${JSON.stringify(event.data)}`,
          );
          return;
        }

        if (envelope) {
          // Check if this is our correlated response
          if (envelope.correlationId === correlationId) {
            clearTimeout(timeout);
            instance.worker.removeEventListener("message", messageHandler);

            this.logger.debug("Received envelope response from agent worker", {
              agentId: instance.agent_id,
              messageId: envelope.id,
              correlationId: envelope.correlationId,
              messageType: envelope.type,
              domain: envelope.domain,
            });

            if (isAgentExecutionCompleteMessage(envelope)) {
              const completionPayload = envelope.payload as AgentExecutionCompletePayload;
              resolve({
                output: completionPayload.result as Record<string, unknown>,
                metadata: {
                  duration: completionPayload.execution_time_ms,
                  memory_used: completionPayload.metadata?.tokens_used || 0,
                  safety_checks_passed: true,
                  ...completionPayload.metadata,
                },
              });
            } else if (envelope.type === ATLAS_MESSAGE_TYPES.TASK.ERROR || envelope.error) {
              const errorMessage = envelope.error?.message || "Unknown error";
              reject(new Error(`Worker error: ${errorMessage}`));
            }
            return;
          }

          // Handle log messages (broadcast, no correlation needed)
          if (isAgentLogMessage(envelope)) {
            const logPayload = envelope.payload;
            this.logger[logPayload.level](
              `[Agent:${logPayload.agent_id}] ${logPayload.message}`,
              logPayload.metadata,
            );
            return;
          }

          // Handle workspace capability requests
          if (envelope.type === "workspace_capability_request") {
            this.handleWorkspaceCapabilityRequest(instance, envelope);
            return;
          }
        }
      };

      instance.worker.addEventListener("message", messageHandler);

      // Send envelope message to worker
      instance.worker.postMessage(executeMessage);
    });
  }

  // Handle workspace capability requests from agent workers
  private async handleWorkspaceCapabilityRequest(
    instance: AgentWorkerInstance,
    envelope: AtlasMessageEnvelope,
  ): Promise<void> {
    const payload = envelope.payload as {
      requestId: string;
      capabilityId: string;
      args: any;
      sessionId: string;
      agentId: string;
    };

    try {
      this.log(
        `Executing capability ${payload.capabilityId} for agent ${payload.agentId}`,
        "debug",
      );

      let result: any;

      // Check if it's a daemon capability first
      const daemonCapability = DaemonCapabilityRegistry.getCapability(payload.capabilityId);
      if (daemonCapability) {
        // It's a daemon-level capability - route to daemon via HTTP
        const daemonContext = {
          sessionId: payload.sessionId,
          agentId: payload.agentId,
          workspaceId: this.workspaceId || "",
          conversationId: payload.args.conversationId,
          daemon: this.getDaemonInstance(),
        };

        console.log(
          `[AgentSupervisor] About to execute daemon capability: ${payload.capabilityId}`,
        );
        console.log(`[AgentSupervisor] Daemon context:`, daemonContext);
        console.log(`[AgentSupervisor] Args:`, Object.values(payload.args));

        result = await DaemonCapabilityRegistry.executeCapability(
          payload.capabilityId,
          daemonContext,
          ...Object.values(payload.args),
        );

        console.log(`[AgentSupervisor] Daemon capability result:`, result);
      } else {
        // It's a workspace capability
        const context = {
          workspaceId: this.workspaceId || "",
          sessionId: payload.sessionId,
          agentId: payload.agentId,
          sessionSupervisor: this.sessionSupervisor,
          conversationId: payload.args.conversationId,
        };

        result = await WorkspaceCapabilityRegistry.executeCapability(
          payload.capabilityId,
          context,
          ...Object.values(payload.args),
        );
      }

      // Send successful response back to worker
      const responseMessage = createAgentMessage(
        "workspace_capability_response",
        {
          requestId: payload.requestId,
          success: true,
          result: result,
        },
        this.createMessageSource(),
        {
          channel: "direct",
          priority: "high",
        },
      );

      instance.worker.postMessage(responseMessage);

      this.log(`Workspace capability ${payload.capabilityId} executed successfully`, "debug");
    } catch (error) {
      this.log(`Workspace capability ${payload.capabilityId} failed: ${error}`, "error");

      // Send error response back to worker
      const errorResponse = createAgentMessage(
        "workspace_capability_response",
        {
          requestId: payload.requestId,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        },
        this.createMessageSource(),
        {
          channel: "direct",
          priority: "high",
        },
      );

      instance.worker.postMessage(errorResponse);
    }
  }

  /**
   * Get reference to the daemon instance for daemon capabilities
   * TODO: This should be properly passed through the supervision hierarchy
   */
  private getDaemonInstance(): any {
    return DaemonCapabilityRegistry.getDaemonInstance();
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
  private updateWorkerStats(
    workerId: string,
    duration: number,
    memoryUsed: number,
  ): void {
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
  getWorkerMetrics(workerId?: string): Record<string, string | number | boolean | Date> {
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
    const allMetrics: Record<string, string | number | boolean | Date> = {};
    for (const [id, _instance] of this.activeWorkers) {
      const workerMetrics = this.getWorkerMetrics(id);
      Object.assign(allMetrics, workerMetrics);
    }
    return allMetrics;
  }

  // Monitor worker health and performance
  monitorWorkers(): {
    healthy: number;
    unhealthy: number;
    idle: number;
    busy: number;
    total_memory: number;
  } {
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
  async cleanupIdleWorkers(maxIdleTime: number = 300000): Promise<number> {
    // 5 minutes default
    const now = Date.now();
    let cleanedUp = 0;

    for (const [workerId, instance] of this.activeWorkers) {
      const stats = this.workerStats.get(workerId);

      if (instance.status === "ready" && stats) {
        const idleTime = now - stats.last_execution.getTime();

        if (idleTime > maxIdleTime) {
          this.log(
            `Cleaning up idle worker ${workerId} (idle for ${idleTime}ms)`,
          );
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
    const totalExecutions = Array.from(this.workerStats.values()).reduce(
      (sum, stats) => sum + stats.executions,
      0,
    );

    const totalMemory = Array.from(this.workerStats.values()).reduce(
      (sum, stats) => sum + stats.memory_peak,
      0,
    );

    const activeWorkers = this.activeWorkers.size;

    let status: "healthy" | "degraded" | "unhealthy" = "healthy";
    if (activeWorkers > 10) {
      status = "degraded"; // Too many workers
    }
    if (totalMemory > 2048) {
      // Over 2GB total
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

  // Cache helper methods
  private createCacheContext(
    agent: AgentMetadata,
    task: AgentTask,
    context: SessionContext,
  ): CacheKeyContext {
    // Create deterministic hash of input data
    const inputData = {
      agentConfig: agent.config,
      task: task.task,
      inputSource: task.inputSource,
      mode: task.mode,
      dependencies: task.dependencies,
      constraints: context.constraints,
    };
    const inputHash = this.hashObject(inputData);

    return {
      agentId: agent.id,
      agentType: agent.type,
      inputHash,
      supervisionLevel: this.supervisionLevel,
      sessionContext: {
        signal: context.signal.id,
        agentSequence: 0, // TODO: Get from session context
        previousOutputHash: undefined, // TODO: Calculate from previous output
      },
    };
  }

  private convertCachedAnalysis(
    cached: AgentAnalysisResult,
    agent: AgentMetadata,
    task: AgentTask,
  ): AgentAnalysis {
    // Parse the cached analysis JSON back to AgentAnalysis format
    try {
      const parsed = JSON.parse(cached.analysis);
      return parsed as AgentAnalysis;
    } catch (error) {
      this.logger.warn(`Failed to parse cached analysis for ${agent.id}, generating new`, {
        error,
      });

      // Fallback to a basic analysis based on cached risk level
      return {
        safety_assessment: {
          risk_level: cached.riskLevel,
          identified_risks: [],
          mitigations: [],
        },
        resource_requirements: {
          memory_mb: 256,
          timeout_seconds: 300,
          required_capabilities: ["basic-execution"],
        },
        optimization_suggestions: {
          model_parameters: {},
          prompt_improvements: [],
          tool_selections: [],
        },
        execution_strategy: {
          isolation_level: cached.requiredIsolation,
          monitoring_required: true,
          validation_criteria: ["output_exists", "no_errors"],
        },
      };
    }
  }

  private hashObject(obj: any): string {
    const str = JSON.stringify(obj, Object.keys(obj).sort());
    return createHash("sha256").update(str).digest("hex").substring(0, 16);
  }

  // Get cache statistics
  async getCacheStats() {
    return await this.supervisionCache.getStats();
  }

  // Clear supervision cache
  async clearCache() {
    await this.supervisionCache.clear();
  }
}
