/**
 * WorkspaceRuntime - Multi-FSM coordinator with direct FSMEngine integration
 *
 * Manages multiple FSM definitions (jobs) and sessions within a workspace.
 * Each FSM represents a workflow, and each session is one FSM execution.
 */

import { EventEmitter } from "node:events";
import type { AgentResult, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import type { MergedConfig } from "@atlas/config";
import {
  AgentOrchestrator,
  type AgentSnapshot,
  type GlobalMCPServerPool,
  ReasoningResultStatus,
  SessionHistoryStorage,
} from "@atlas/core";
import { FileSystemDocumentStore } from "@atlas/document-store";
import {
  type AgentExecutor,
  AtlasLLMProviderAdapter,
  type Context,
  createEngine,
  FSMDefinitionSchema,
  type FSMEngine,
  GlobalMCPToolProvider,
  loadFromFile,
  type MCPToolProvider,
  type SignalWithContext,
} from "@atlas/fsm-engine";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import * as path from "@std/path";
import { z } from "zod";
import type {
  ITempestContextManager,
  ITempestMemoryManager,
  ITempestMessageManager,
  IWorkspace,
  IWorkspaceArtifact,
  IWorkspaceSession,
  SessionSummary,
} from "../types/core.ts";
import { MessageUser } from "../types/core.ts";
import { buildAgentPrompt, validateAgentOutput } from "./agent-helpers.ts";
import { SupervisionLevel } from "./supervision-levels.ts";

// WorkspaceRuntime signal type - plain payload without full IAtlasScope implementation
interface WorkspaceRuntimeSignal {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  timestamp: Date;
  provider?: { id: string; name: string };
}

// Zod schema for AgentResult artifact data validation
const AgentResultArtifactSchema = z.object({
  agentId: z.string(),
  task: z.string(),
  input: z.unknown(),
  output: z.unknown(),
  reasoning: z.string().optional(),
  error: z.string().optional(),
  duration: z.number(),
  timestamp: z.string(),
  toolCalls: z.array(z.any()).optional(),
  toolResults: z.array(z.any()).optional(),
});

// Zod schema for AgentSnapshot document data validation
const AgentSnapshotDataSchema = z.object({
  agentId: z.string().default("fsm-agent"),
  task: z.string().default("FSM action"),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  reasoning: z.string().optional(),
  toolCalls: z.array(z.any()).optional(),
  toolResults: z.array(z.any()).optional(),
  artifacts: z
    .array(z.object({ id: z.string(), type: z.string(), summary: z.string() }))
    .optional(),
  duration: z.number().optional(),
  timestamp: z.string().optional(),
  error: z.string().optional(),
});

// Stub factory functions for minimal IAtlasScope manager implementations
function createStubContextManager(): ITempestContextManager {
  return { add: () => {}, remove: () => {}, search: () => [], size: () => 0 };
}

function createStubMemoryManager(): ITempestMemoryManager {
  return {};
}

function createStubMessageManager(): ITempestMessageManager {
  return {
    history: [],
    newMessage: () => ({
      id: crypto.randomUUID(),
      promptUser: MessageUser.SYSTEM,
      message: "",
      timestamp: new Date(),
    }),
    editMessage: () => {},
    getHistory: () => [],
  };
}

interface WorkspaceRuntimeOptions {
  lazy?: boolean;
  workspacePath?: string;
  mcpServerPool?: GlobalMCPServerPool;
  daemonUrl?: string;
  onSessionFinished?: (data: {
    workspaceId: string;
    sessionId: string;
    status: "completed" | "failed";
    finishedAt: string;
    summary?: string;
  }) => void | Promise<void>;
}

interface FSMJob {
  name: string;
  fsmPath: string;
  engine?: FSMEngine; // Direct FSMEngine reference
  documentStore?: FileSystemDocumentStore; // Per-job document store
  signals: string[]; // Signal IDs this FSM handles
  fsmDefinition?: unknown; // Inline FSM definition from workspace.yml
}

interface ActiveSession {
  id: string;
  jobName: string;
  signalId: string;
  session: IWorkspaceSession;
  startedAt: Date;
  waitForCompletion(): Promise<SessionSummary>; // Convenience method to avoid .session.waitForCompletion()
}

interface SessionResult {
  id: string;
  workspaceId: string;
  status: "active" | "completed" | "failed";
  startedAt: Date;
  completedAt?: Date;
  artifacts: IWorkspaceArtifact[];
  error?: Error;
}

/**
 * WorkspaceRuntime coordinates multiple FSM executions (jobs) within a workspace.
 *
 * Architecture:
 * - Each job = one FSM definition (from config or file)
 * - Each signal processing = one FSM execution (session)
 * - Direct FSMEngine integration (no wrapper layer)
 */
export class WorkspaceRuntime {
  private workspace: IWorkspace;
  private config: MergedConfig;
  private options: WorkspaceRuntimeOptions;
  private initialized = false;

  // Shared resources
  private orchestrator: AgentOrchestrator;

  // Job tracking (each job has its own FSMEngine and DocumentStore)
  private jobs = new Map<string, FSMJob>();

  // Session tracking
  private sessions = new Map<string, ActiveSession>();
  private sessionResults = new Map<string, SessionResult>();
  private sessionCompletionEmitter = new EventEmitter();

  constructor(workspace: IWorkspace, config: MergedConfig, options: WorkspaceRuntimeOptions = {}) {
    this.workspace = workspace;
    this.config = config;
    this.options = options;

    // Create shared AgentOrchestrator (can handle concurrent executions)
    const agentsServerUrl = options.daemonUrl || "http://localhost:8080";
    this.orchestrator = new AgentOrchestrator(
      {
        agentsServerUrl: `${agentsServerUrl}/agents`,
        mcpServerPool: options.mcpServerPool,
        daemonUrl: options.daemonUrl,
        requestTimeoutMs: 900000,
      },
      logger.child({ component: "AgentOrchestrator", workspaceId: workspace.id }),
    );
  }

  /**
   * Get workspace ID
   */
  get workspaceId(): string {
    return this.workspace.id;
  }

  /**
   * Initialize the runtime - discover and load all FSM definitions
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.debug("Runtime already initialized", { workspaceId: this.workspace.id });
      return;
    }

    logger.info("Initializing multi-FSM workspace runtime", { workspaceId: this.workspace.id });

    const workspacePath = this.options.workspacePath || `.atlas/workspaces/${this.workspace.id}`;

    // Load jobs from config (inline FSM definitions in workspace.yml)
    const configJobs = this.config.workspace.jobs || {};

    for (const [jobName, jobSpec] of Object.entries(configJobs)) {
      // Only process jobs with FSM definitions
      if (!jobSpec.fsm) {
        logger.debug("Skipping non-FSM job", { jobName });
        continue;
      }

      // Extract signals from triggers
      const signals = (jobSpec.triggers || []).map((t) => t.signal).filter(Boolean);

      // Store job with inline FSM (will be initialized on first use)
      this.jobs.set(jobName, {
        name: jobName,
        fsmPath: "", // Empty for inline FSM
        signals,
        fsmDefinition: jobSpec.fsm,
      });

      logger.debug("Registered inline FSM job from config", {
        jobName,
        signals,
        triggerCount: jobSpec.triggers?.length || 0,
      });
    }

    // Also discover standalone FSM files in workspace directory
    const fsmFiles = await this.discoverFSMFiles(workspacePath);

    logger.info("Discovered standalone FSM files", {
      workspaceId: this.workspace.id,
      count: fsmFiles.length,
      files: fsmFiles,
    });

    // Load each standalone FSM as a job
    for (const fsmFile of fsmFiles) {
      const jobName = path.basename(fsmFile, ".fsm.yaml");

      // Skip if already registered from config
      if (this.jobs.has(jobName)) {
        logger.debug("Skipping duplicate job from file (already in config)", { jobName });
        continue;
      }

      // For standalone FSMs, assume they handle all signals
      const signals = Object.keys(this.config.workspace.signals || {});

      this.jobs.set(jobName, { name: jobName, fsmPath: fsmFile, signals });

      logger.debug("Registered standalone FSM job", { jobName, fsmPath: fsmFile, signals });
    }

    this.initialized = true;

    logger.info("Runtime initialized", {
      workspaceId: this.workspace.id,
      jobCount: this.jobs.size,
      jobs: Array.from(this.jobs.keys()),
    });
  }

  /**
   * Discover all FSM files in workspace directory
   */
  private async discoverFSMFiles(workspacePath: string): Promise<string[]> {
    const fsmFiles: string[] = [];

    try {
      // Check for main workspace FSM
      const mainFSM = path.join(workspacePath, "workspace.fsm.yaml");
      try {
        await Deno.stat(mainFSM);
        fsmFiles.push(mainFSM);
      } catch {
        // No main FSM
      }

      // TODO: Scan for other FSM files (*.fsm.yaml)
      // For now, only support single workspace.fsm.yaml
    } catch (error) {
      logger.warn("Failed to discover FSM files", {
        workspacePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return fsmFiles;
  }

  /**
   * Initialize a job's FSM engine (lazy initialization)
   */
  private async initializeJobEngine(job: FSMJob): Promise<void> {
    if (job.engine) {
      return; // Already initialized
    }

    logger.info("Initializing FSM engine for job", {
      jobName: job.name,
      workspaceId: this.workspace.id,
    });

    // Create per-job document store
    const stateStoragePath = path.join(getAtlasHome(), "workspaces");
    job.documentStore = new FileSystemDocumentStore({ basePath: stateStoragePath });

    // Create agent executor callback for this job
    const agentExecutor: AgentExecutor = (agentId, context, signal) =>
      this.executeAgent(agentId, context, job, signal);

    // Create MCP tool provider if workspace has MCP servers configured
    let mcpToolProvider: MCPToolProvider | undefined;
    const mcpServerConfigs = this.config.workspace.tools?.mcp?.servers || {};

    if (Object.keys(mcpServerConfigs).length > 0 && this.options.mcpServerPool) {
      mcpToolProvider = new GlobalMCPToolProvider(
        this.options.mcpServerPool,
        this.workspace.id,
        mcpServerConfigs,
        logger.child({ component: "MCPToolProvider", workspaceId: this.workspace.id }),
      );

      logger.debug("Created MCP tool provider for FSM", {
        workspaceId: this.workspace.id,
        jobName: job.name,
        serverCount: Object.keys(mcpServerConfigs).length,
        serverIds: Object.keys(mcpServerConfigs),
      });
    }

    const scope = { workspaceId: this.workspace.id };
    const engineOptions = {
      documentStore: job.documentStore,
      scope,
      llmProvider: new AtlasLLMProviderAdapter("claude-sonnet-4-5"),
      agentExecutor,
      mcpToolProvider,
    };

    // Load engine from inline definition or file
    if (job.fsmDefinition) {
      // Inline FSM definition from workspace.yml
      logger.debug("Loading FSM from inline definition", {
        workspaceId: this.workspace.id,
        jobName: job.name,
      });

      // Validate and parse with Zod schema
      const definition = FSMDefinitionSchema.parse(job.fsmDefinition);

      job.engine = createEngine(definition, engineOptions);
      await job.engine.initialize();
    } else {
      // Load from file
      const configPath =
        this.options.workspacePath || path.join(getAtlasHome(), "workspaces", this.workspace.id);
      const fsmPath = job.fsmPath || path.join(configPath, "workspace.fsm.yaml");

      logger.debug("Loading FSM from file", { workspaceId: this.workspace.id, fsmPath });

      job.engine = await loadFromFile(fsmPath, engineOptions);
    }

    logger.info("FSM engine initialized for job", {
      jobName: job.name,
      workspaceId: this.workspace.id,
      initialState: job.engine.state,
      documentCount: job.engine.documents.length,
    });
  }

  /**
   * Process a signal - find matching FSM and execute
   */
  async processSignal(
    signal: WorkspaceRuntimeSignal,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
  ): Promise<IWorkspaceSession> {
    await this.ensureInitialized();

    logger.info("Processing signal", {
      workspaceId: this.workspace.id,
      signalId: signal.id,
      jobCount: this.jobs.size,
    });

    // Find job(s) that handle this signal
    const matchingJobs = Array.from(this.jobs.values()).filter((job) =>
      job.signals.includes(signal.id),
    );

    if (matchingJobs.length === 0) {
      throw new Error(
        `No FSM job handles signal '${signal.id}' in workspace '${this.workspace.id}'`,
      );
    }

    // For now, use first matching job
    // TODO: Support multiple jobs handling same signal
    const job = matchingJobs[0];
    if (!job) {
      throw new Error(`No job found after filtering - this should not happen`);
    }

    logger.debug("Found matching job for signal", { signalId: signal.id, jobName: job.name });

    // Initialize job engine if not already created
    await this.initializeJobEngine(job);

    // Process signal through job's FSM engine
    const sessionResult = await this.processSignalForJob(job, signal, onStreamEvent);

    // Store session result for completion tracking
    this.sessionResults.set(sessionResult.id, sessionResult);

    // Create workspace session with waitForCompletion
    const workspaceSession = this.toWorkspaceSession(sessionResult, job);

    // Track session
    const activeSession: ActiveSession = {
      id: sessionResult.id,
      jobName: job.name,
      signalId: signal.id,
      session: workspaceSession,
      startedAt: new Date(),
      waitForCompletion: () => workspaceSession.waitForCompletion(),
    };
    this.sessions.set(sessionResult.id, activeSession);

    // Persist session to history storage BEFORE cleanup
    if (sessionResult.status !== "active") {
      await this.persistSessionToHistory(sessionResult, job, signal);
    }

    // Emit completion event for waitForCompletion() listeners
    if (sessionResult.status !== "active") {
      this.sessionCompletionEmitter.emit(`session:${sessionResult.id}`, sessionResult);
    }

    // Call onSessionFinished callback if provided
    if (this.options.onSessionFinished && sessionResult.status !== "active") {
      const status: "completed" | "failed" =
        sessionResult.status === "completed" ? "completed" : "failed";
      await this.options.onSessionFinished({
        workspaceId: this.workspace.id,
        sessionId: sessionResult.id,
        status,
        finishedAt: new Date().toISOString(),
        summary: `Session ${sessionResult.id}: ${sessionResult.status}`,
      });

      // Remove completed session
      this.sessions.delete(sessionResult.id);
      // Clean up session result after callback
      this.sessionResults.delete(sessionResult.id);
    }

    return activeSession.session;
  }

  /**
   * Process a signal for a specific job (FSM execution)
   */
  private async processSignalForJob(
    job: FSMJob,
    signal: WorkspaceRuntimeSignal,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
  ): Promise<SessionResult> {
    if (!job.engine) {
      throw new Error(`Job ${job.name} engine not initialized`);
    }

    // Check if this signal is a trigger signal for the job
    const isTriggerSignal = this.isTriggerSignal(signal.id);

    if (isTriggerSignal) {
      // Trigger signal starts fresh execution - clear persisted state and documents
      logger.info("Trigger signal detected - clearing persisted state for fresh execution", {
        signalId: signal.id,
        workspaceId: this.workspace.id,
        jobName: job.name,
      });
      await this.clearPersistedStateFiles(job);

      // Reset engine to initial state
      await job.engine.reset();

      logger.debug("Engine reset to initial state", {
        workspaceId: this.workspace.id,
        jobName: job.name,
        initialState: job.engine.state,
      });
    } else {
      // Continuation signal - FSM state preserved for resume
      logger.debug("Continuation signal - state preserved", {
        signalId: signal.id,
        currentState: job.engine.state,
      });
    }

    const sessionId = crypto.randomUUID();
    const session: SessionResult = {
      id: sessionId,
      workspaceId: this.workspace.id,
      status: "active",
      startedAt: new Date(),
      artifacts: [],
    };

    logger.info("Processing signal via FSM", {
      sessionId: session.id,
      signalType: signal.id,
      currentState: job.engine.state,
      isTriggerSignal,
      jobName: job.name,
    });

    try {
      // Process signal through FSM with callback context
      await job.engine.signal(
        { type: signal.id, data: signal.data || {} },
        onStreamEvent
          ? {
              sessionId: session.id,
              workspaceId: this.workspace.id,
              // Wrap callback: FSMEvent types are valid AtlasUIMessageChunk types
              // TypeScript can't prove the discriminated union compatibility, but
              // at runtime FSMEvent is guaranteed to be a valid data event chunk
              onEvent: (event) => {
                onStreamEvent(event as unknown as AtlasUIMessageChunk);
              },
            }
          : undefined,
      );

      // Extract artifacts from FSM documents
      session.artifacts = this.extractArtifacts(job.engine.documents);
      session.status = "completed";
      session.completedAt = new Date();

      logger.info("Signal processed successfully", {
        sessionId: session.id,
        finalState: job.engine.state,
        artifactCount: session.artifacts.length,
        jobName: job.name,
      });
    } catch (error) {
      session.status = "failed";
      session.completedAt = new Date();
      session.error = error instanceof Error ? error : new Error(String(error));

      logger.error("Signal processing failed", {
        sessionId: session.id,
        error: session.error.message,
        currentState: job.engine.state,
        jobName: job.name,
      });
    } finally {
      // Emit session-finish event for stream rotation and completion tracking
      if (onStreamEvent) {
        try {
          await onStreamEvent({
            type: "data-session-finish",
            data: { sessionId: session.id, workspaceId: this.workspace.id, status: session.status },
          });
        } catch (emitError) {
          logger.error("Failed to emit session-finish event", {
            sessionId: session.id,
            error: emitError,
          });
        }
      }
    }

    return session;
  }

  /**
   * Agent executor callback for FSM agent actions
   * Integrates FSMEngine with AgentOrchestrator
   */
  private async executeAgent(
    agentId: string,
    fsmContext: Context,
    job: FSMJob,
    signal: SignalWithContext,
  ): Promise<AgentResult> {
    logger.debug("Executing agent via orchestrator", {
      agentId,
      documentCount: fsmContext.documents.length,
      state: fsmContext.state,
      jobName: job.name,
      hasSignalContext: !!signal._context,
    });

    // Look up agent config first to get the configured prompt
    const agentConfig = this.config.workspace.agents?.[agentId];

    // Extract agent prompt from config based on agent type
    let agentPrompt = "";
    if (agentConfig) {
      if (agentConfig.type === "llm" && agentConfig.config.prompt) {
        agentPrompt = agentConfig.config.prompt;
      } else if (agentConfig.type === "atlas" && agentConfig.prompt) {
        agentPrompt = agentConfig.prompt;
      } else if (agentConfig.type === "system" && agentConfig.config?.prompt) {
        agentPrompt = agentConfig.config.prompt;
      }
    }

    // Build context (facts, documents, signal data)
    const context = buildAgentPrompt(
      agentId,
      fsmContext,
      signal, // Use actual signal instead of synthetic one
    );

    // Combine agent prompt with context
    // Agent prompt comes first, then context
    const prompt = agentPrompt ? `${agentPrompt}\n\n${context}` : context;

    // Extract streamId from conversation-context document if present
    const conversationContext = fsmContext.documents.find(
      (doc) => doc.id === "conversation-context",
    );
    const streamId =
      typeof conversationContext?.data?.streamId === "string"
        ? conversationContext.data.streamId
        : undefined;

    // Execute agent via orchestrator
    const result = await this.orchestrator.executeAgent(agentId, prompt, {
      sessionId: signal._context?.sessionId || crypto.randomUUID(), // Use signal's sessionId or generate new
      workspaceId: signal._context?.workspaceId || this.workspace.id,
      streamId, // Pass streamId for conversation agent streaming support
      // Wrap callback: orchestrator sends AtlasUIMessageChunk, signal callback expects FSMEvent
      // TypeScript can't prove discriminated union compatibility, but at runtime
      // all agent events are valid AtlasUIMessageChunk types that pass through
      onStreamEvent: signal._context?.onEvent
        ? (chunk) => {
            const callback = signal._context?.onEvent;
            if (callback) {
              callback(chunk as unknown as import("@atlas/fsm-engine").FSMEvent);
            }
          }
        : undefined,
      additionalContext: { documents: fsmContext.documents },
    });
    // Map "atlas" config type to "sdk" for consistency with function parameter
    const agentType = agentConfig?.type === "atlas" ? "sdk" : agentConfig?.type;

    // Validate agent output (hallucination detection only runs for LLM agents)
    await validateAgentOutput(result, fsmContext, undefined, SupervisionLevel.STANDARD, agentType);

    logger.debug("Agent execution completed", { agentId, success: !result.error });

    return result;
  }

  /**
   * Extract artifacts from FSM documents
   */
  private extractArtifacts(
    documents: { id: string; type: string; data: Record<string, unknown> }[],
  ): IWorkspaceArtifact[] {
    // Extract documents that represent artifacts
    const artifactTypes = [
      "workspace-plan",
      "analysis-result",
      "review-result",
      "report",
      "summary",
      "agent-result",
      "AgentResult",
      "LLMResult",
    ];

    return documents
      .filter((d) => artifactTypes.includes(d.type))
      .map((d) => ({
        id: d.id,
        type: d.type,
        data: d.data,
        createdAt: new Date(),
        createdBy: "fsm-engine",
      }));
  }

  /**
   * Create SessionSummary from SessionResult
   */
  private createSessionSummary(sessionResult: SessionResult, job: FSMJob): SessionSummary {
    const duration = sessionResult.completedAt
      ? sessionResult.completedAt.getTime() - sessionResult.startedAt.getTime()
      : 0;

    // Extract agent results from artifacts and normalize to agent-sdk format
    const results: AgentResult[] = sessionResult.artifacts
      .filter((artifact) => artifact.type === "agent-result")
      .map((artifact) => {
        const parseResult = AgentResultArtifactSchema.safeParse(artifact.data);

        if (!parseResult.success) {
          logger.warn("Invalid agent result artifact", {
            artifactId: artifact.id,
            error: parseResult.error,
          });
          return {
            agentId: "unknown",
            task: "",
            input: undefined,
            output: undefined,
            duration: 0,
            timestamp: new Date().toISOString(),
          };
        }

        return parseResult.data;
      });

    // Map FSM states to "phases" - count unique state transitions
    const stateTransitions =
      job.engine?.documents.filter(
        (doc) => doc.type === "state-transition" || doc.type === "fsm-state",
      ) || [];

    const totalPhases = stateTransitions.length || 1;
    const completedPhases =
      sessionResult.status === "completed" ? totalPhases : Math.max(0, totalPhases - 1);

    // Count agent executions (success = no error)
    const totalAgents = results.length;
    const executedAgents = results.filter((r) => !r.error).length;

    return {
      sessionId: sessionResult.id,
      workspaceId: sessionResult.workspaceId,
      status: sessionResult.status,
      totalPhases,
      totalAgents,
      completedPhases,
      executedAgents,
      duration,
      reasoning: sessionResult.error
        ? `Failed: ${sessionResult.error.message}`
        : "Completed successfully",
      results,
    };
  }

  /**
   * Convert SessionResult to IWorkspaceSession
   */
  private toWorkspaceSession(session: SessionResult, job: FSMJob): IWorkspaceSession {
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      status: session.status,
      signals: {
        triggers: [],
        callback: {
          onSuccess: () => {},
          onError: () => {},
          onComplete: () => {},
          execute: () => {},
          validate: () => true,
        },
      },
      start: () => Promise.resolve(),
      cancel: () => {},
      cleanup: () => {},
      progress: () => {
        if (session.status === "completed") return 100;
        if (session.status === "failed") return 0;
        return 50; // Active sessions are 50% by default
      },
      summarize: () => `Session ${session.id}: ${session.status}`,
      getArtifacts: () => session.artifacts,
      waitForCompletion: (): Promise<SessionSummary> => {
        // If already completed, return immediately
        const currentResult = this.sessionResults.get(session.id);
        if (currentResult && currentResult.status !== "active") {
          return Promise.resolve(this.createSessionSummary(currentResult, job));
        }

        // Otherwise, wait for completion event
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Session ${session.id} timed out after 15 minutes`));
          }, 900000); // 15 minute timeout

          this.sessionCompletionEmitter.once(`session:${session.id}`, (result: SessionResult) => {
            clearTimeout(timeout);
            resolve(this.createSessionSummary(result, job));
          });
        });
      },
      // IAtlasScope methods (minimal implementation)
      supervisor: undefined,
      context: createStubContextManager(),
      memory: createStubMemoryManager(),
      messages: createStubMessageManager(),
      prompts: { system: "", user: "" },
      gates: [],
      newConversation: () => createStubMessageManager(),
      getConversation: () => createStubMessageManager(),
      archiveConversation: () => {},
      deleteConversation: () => {},
      parentScopeId: undefined,
    };
  }

  /**
   * Check if a signal is a trigger signal
   * Trigger signals start fresh executions, while other signals resume from persisted state
   */
  private isTriggerSignal(signalId: string): boolean {
    const jobs = this.config.workspace.jobs;
    if (!jobs) return false;

    // Find job that has this signal as a trigger
    for (const job of Object.values(jobs)) {
      const triggers = job.triggers;
      if (triggers?.some((t) => t.signal === signalId)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Clear persisted state and document files for fresh execution
   */
  private async clearPersistedStateFiles(job: FSMJob): Promise<void> {
    if (!job.engine || !job.documentStore) {
      throw new Error("Cannot clear state - engine not initialized");
    }

    const scope = { workspaceId: this.workspace.id };
    // Use the engine's FSM definition ID
    const fsmId =
      job.engine.toYAML().match(/^id:\s*(.+)$/m)?.[1] || job.name || "atlas-conversation";

    // Clear persisted state file
    await job.documentStore.saveState(scope, fsmId, null);

    // Clear any persisted document files
    const existingDocIds = await job.documentStore.list(scope, fsmId);
    for (const docId of existingDocIds) {
      await job.documentStore.delete(scope, fsmId, docId);
    }

    logger.debug("Cleared persisted state files for fresh execution", {
      workspaceId: this.workspace.id,
      jobName: job.name,
      fsmId,
      clearedDocCount: existingDocIds.length,
    });
  }

  /**
   * Trigger a signal by name with optional payload
   */
  async triggerSignal(signalName: string, payload?: Record<string, unknown>): Promise<void> {
    const signal: WorkspaceRuntimeSignal = {
      id: signalName,
      type: signalName,
      data: payload || {},
      timestamp: new Date(),
    };

    await this.processSignal(signal);
  }

  /**
   * Trigger a signal and return the session
   */
  async triggerSignalWithSession(
    signalName: string,
    payload?: Record<string, unknown>,
    _streamId?: string,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
  ): Promise<IWorkspaceSession> {
    const signal: WorkspaceRuntimeSignal = {
      id: signalName,
      type: signalName,
      data: payload || {},
      timestamp: new Date(),
    };

    return await this.processSignal(signal, onStreamEvent);
  }

  /**
   * Execute a job directly by name (bypasses signal routing)
   * Always treats execution as a trigger signal (fresh execution, clears state)
   */
  async executeJobDirectly(
    jobName: string,
    params: { payload?: Record<string, unknown>; streamId?: string },
  ): Promise<IWorkspaceSession> {
    await this.ensureInitialized();

    logger.info("Executing job directly", {
      workspaceId: this.workspace.id,
      jobName,
      hasPayload: !!params.payload,
    });

    // Find job by name
    const job = this.jobs.get(jobName);
    if (!job) {
      throw new Error(
        `Job '${jobName}' not found in workspace '${this.workspace.id}'. Available jobs: ${Array.from(
          this.jobs.keys(),
        ).join(", ")}`,
      );
    }

    // Initialize job engine if not already created
    await this.initializeJobEngine(job);

    // Create synthetic trigger signal with payload
    const signal: WorkspaceRuntimeSignal = {
      id: `job:${jobName}`,
      type: `job:${jobName}`,
      data: params.payload || {},
      timestamp: new Date(),
    };

    // Process as trigger signal (clears state, fresh execution)
    // Note: onStreamEvent not passed here as this is a direct job execution
    // without an active stream callback context
    const sessionResult = await this.processSignalForJob(job, signal, undefined);

    // Store session result for completion tracking
    this.sessionResults.set(sessionResult.id, sessionResult);

    // Create workspace session with waitForCompletion
    const workspaceSession = this.toWorkspaceSession(sessionResult, job);

    // Track session
    const activeSession: ActiveSession = {
      id: sessionResult.id,
      jobName: job.name,
      signalId: signal.id,
      session: workspaceSession,
      startedAt: new Date(),
      waitForCompletion: () => workspaceSession.waitForCompletion(),
    };
    this.sessions.set(sessionResult.id, activeSession);

    // Persist session to history storage BEFORE cleanup
    if (sessionResult.status !== "active") {
      await this.persistSessionToHistory(sessionResult, job, signal);
    }

    // Emit completion event for waitForCompletion() listeners
    if (sessionResult.status !== "active") {
      this.sessionCompletionEmitter.emit(`session:${sessionResult.id}`, sessionResult);
    }

    // Call onSessionFinished callback if provided
    if (this.options.onSessionFinished && sessionResult.status !== "active") {
      const status: "completed" | "failed" =
        sessionResult.status === "completed" ? "completed" : "failed";
      await this.options.onSessionFinished({
        workspaceId: this.workspace.id,
        sessionId: sessionResult.id,
        status,
        finishedAt: new Date().toISOString(),
        summary: `Session ${sessionResult.id}: ${sessionResult.status}`,
      });

      // Remove completed session
      this.sessions.delete(sessionResult.id);
      // Clean up session result after callback
      this.sessionResults.delete(sessionResult.id);
    }

    logger.info("Job execution completed", {
      workspaceId: this.workspace.id,
      jobName,
      sessionId: sessionResult.id,
      status: sessionResult.status,
    });

    return activeSession.session;
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down workspace runtime", { workspaceId: this.workspace.id });

    // Shutdown all FSM engines
    for (const job of this.jobs.values()) {
      if (job.engine) {
        job.engine.stop();
      }
    }

    await this.orchestrator.shutdown();

    this.sessions.clear();
    this.jobs.clear();
    this.initialized = false;
  }

  /**
   * List all jobs (FSM definitions) in this workspace
   */
  listJobs(): Array<{ name: string; description?: string }> {
    return Array.from(this.jobs.values()).map((job) => ({
      name: job.name,
      description: `FSM workflow at ${job.fsmPath}`,
    }));
  }

  /**
   * Get all sessions
   */
  getSessions(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * List all sessions
   */
  listSessions(): Array<{ id: string; jobName: string; status: string; startedAt: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      jobName: s.jobName,
      status: s.session.status,
      startedAt: s.startedAt.toISOString(),
    }));
  }

  /**
   * Get a specific session by ID
   */
  getSession(sessionId: string): IWorkspaceSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * Cancel a session
   */
  cancelSession(sessionId: string): void {
    const activeSession = this.sessions.get(sessionId);
    if (!activeSession) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Cancel the session
    activeSession.session.cancel();
    this.sessions.delete(sessionId);

    logger.info("Session cancelled", { sessionId, workspaceId: this.workspace.id });
  }

  /**
   * List all signals defined in workspace
   */
  listSignals(): Array<{ id: string; description?: string; provider: string }> {
    const signals = this.config.workspace.signals || {};
    return Object.entries(signals).map(([id, config]) => ({
      id,
      description: config.description,
      provider: config.provider,
    }));
  }

  /**
   * List all agents defined in workspace
   */
  listAgents(): Array<{ id: string; type: string; description?: string }> {
    const agents = this.config.workspace.agents || {};
    return Object.entries(agents).map(([id, config]) => ({
      id,
      type: config.type,
      description: config.description,
    }));
  }

  /**
   * Describe a specific agent
   */
  describeAgent(
    agentId: string,
  ): { id: string; type: string; description?: string; config: unknown } | undefined {
    const agents = this.config.workspace.agents || {};
    const config = agents[agentId];
    if (!config) return undefined;

    return { id: agentId, type: config.type, description: config.description, config };
  }

  /**
   * Check if there are active sessions for a signal
   */
  hasActiveSessionsForSignal(signalId: string): boolean {
    return Array.from(this.sessions.values()).some((s) => s.signalId === signalId);
  }

  /**
   * Get current FSM state for a job
   */
  getState(jobName?: string): string {
    if (!jobName) {
      // Return state of first job
      const firstJob = Array.from(this.jobs.values())[0];
      return firstJob?.engine?.state || "uninitialized";
    }

    const job = this.jobs.get(jobName);
    return job?.engine?.state || "uninitialized";
  }

  /**
   * Get the agent orchestrator for a job
   * Used by daemon to check for active agent executions
   */
  getOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
  }

  /**
   * Get the provider type for a signal (http, schedule, slack, etc.)
   */
  getSignalProvider(signalId: string): string | undefined {
    const signals = this.config?.workspace?.signals || {};
    return signals[signalId]?.provider;
  }

  /**
   * Ensure runtime is initialized (lazy initialization helper)
   */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * Get workspace config
   */
  getConfig(): MergedConfig {
    return this.config;
  }

  /**
   * Get workspace
   */
  getWorkspace(): IWorkspace {
    return this.workspace;
  }

  /**
   * Get agent orchestrator (alias)
   */
  getAgentOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
  }

  /**
   * Truncate large string fields in data to prevent storage bloat
   */
  private truncateLargeFields<T>(data: T, maxLength = 10240): T {
    if (typeof data === "string") {
      if (data.length > maxLength) {
        return `${data.substring(0, maxLength)}... [truncated]` as T;
      }
      return data;
    }

    if (Array.isArray(data)) {
      return data.map((item) => this.truncateLargeFields(item, maxLength)) as T;
    }

    if (data && typeof data === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(data)) {
        result[key] = this.truncateLargeFields(value, maxLength);
      }
      return result as T;
    }

    return data;
  }

  /**
   * Create AgentSnapshot from FSM document data
   */
  private createAgentSnapshot(doc: {
    id: string;
    type: string;
    data: Record<string, unknown>;
  }): AgentSnapshot {
    const parsed = AgentSnapshotDataSchema.parse(doc.data);

    return {
      agentId: parsed.agentId,
      task: parsed.task,
      inputData: { structured: parsed.input ?? {} },
      outputText: typeof parsed.output === "string" ? parsed.output : undefined,
      structuredOutput: typeof parsed.output !== "string" ? parsed.output : undefined,
      reasoning: parsed.reasoning,
      toolCalls: parsed.toolCalls,
      toolResults: parsed.toolResults,
      artifacts: parsed.artifacts,
      result: {
        agentId: parsed.agentId,
        task: parsed.task,
        input: parsed.input,
        output: parsed.output,
        reasoning: parsed.reasoning,
        error: parsed.error,
        duration: parsed.duration ?? 0,
        timestamp: parsed.timestamp ?? new Date().toISOString(),
        toolCalls: parsed.toolCalls,
        toolResults: parsed.toolResults,
      },
    };
  }

  /**
   * Convert FSM documents to session history events
   */
  private async convertFSMDocumentsToEvents(
    sessionResult: SessionResult,
    job: FSMJob,
  ): Promise<void> {
    if (!job.engine) return;

    const documents = job.engine.documents;

    for (const doc of documents) {
      // Skip internal FSM documents
      if (doc.id === "conversation-context") continue;

      // Truncate large fields before storing (preserves Record type)
      const truncatedData = this.truncateLargeFields(doc.data);

      // Determine if this looks like an agent result
      const isAgentResult = ["agent-result", "AgentResult", "LLMResult"].includes(doc.type);

      if (isAgentResult) {
        // Convert to agent-output event
        const executionId = crypto.randomUUID();
        const agentId =
          typeof truncatedData.agentId === "string" ? truncatedData.agentId : "unknown";
        await SessionHistoryStorage.appendSessionEvent({
          sessionId: sessionResult.id,
          emittedBy: "workspace-runtime",
          event: {
            type: "agent-output",
            context: { agentId, executionId },
            data: {
              agentId,
              executionId,
              snapshot: this.createAgentSnapshot({ ...doc, data: truncatedData }),
            },
          },
        });
      } else {
        // Convert to generic supervisor-action event
        await SessionHistoryStorage.appendSessionEvent({
          sessionId: sessionResult.id,
          emittedBy: "workspace-runtime",
          event: {
            type: "supervisor-action",
            context: { metadata: { documentId: doc.id, documentType: doc.type } },
            data: {
              action: "fsm-document-created",
              details: { documentId: doc.id, documentType: doc.type, data: truncatedData },
            },
          },
        });
      }
    }
  }

  /**
   * Persist session to history storage
   */
  private async persistSessionToHistory(
    sessionResult: SessionResult,
    job: FSMJob,
    signal: WorkspaceRuntimeSignal,
  ): Promise<void> {
    try {
      // Transform signal to SessionHistorySignal format
      const historySignal = {
        id: signal.id,
        provider: {
          id: signal.provider?.id || signal.id,
          name: signal.provider?.name || signal.id,
        },
        workspaceId: this.workspace.id,
      };

      // Get available agents list
      const availableAgents = this.listAgents().map((a) => a.id);

      // Map WorkspaceRuntime status to ReasoningResultStatus
      const historyStatus =
        sessionResult.status === "completed"
          ? ReasoningResultStatus.COMPLETED
          : ReasoningResultStatus.FAILED;

      // Create session record
      const createResult = await SessionHistoryStorage.createSessionRecord({
        sessionId: sessionResult.id,
        workspaceId: this.workspace.id,
        status: historyStatus,
        signal: historySignal,
        signalPayload: signal.data,
        jobSpecificationId: job.name,
        availableAgents,
        streamId: undefined, // FSM runtime doesn't have streamId
        artifactIds: sessionResult.artifacts.map((a) => a.id),
        summary: `FSM ${job.name}: ${sessionResult.status}`,
      });

      if (!createResult.ok) {
        logger.error("Failed to create session record", {
          error: createResult.error,
          sessionId: sessionResult.id,
        });
        return;
      }

      // Append session-start event
      await SessionHistoryStorage.appendSessionEvent({
        sessionId: sessionResult.id,
        emittedBy: "workspace-runtime",
        event: {
          type: "session-start",
          context: {
            metadata: {
              jobName: job.name,
              fsmId: job.engine?.toYAML().match(/^id:\s*(.+)$/m)?.[1],
            },
          },
          data: { status: historyStatus, message: `Started FSM job: ${job.name}` },
        },
      });

      // Convert FSM documents to events
      await this.convertFSMDocumentsToEvents(sessionResult, job);

      // Append session-finish event
      const durationMs =
        sessionResult.completedAt && sessionResult.startedAt
          ? sessionResult.completedAt.getTime() - sessionResult.startedAt.getTime()
          : 0;

      await SessionHistoryStorage.appendSessionEvent({
        sessionId: sessionResult.id,
        emittedBy: "workspace-runtime",
        event: {
          type: "session-finish",
          context: { metadata: { finalState: job.engine?.state } },
          data: {
            status: historyStatus,
            durationMs,
            failureReason: sessionResult.error?.message,
            summary: `FSM execution ${sessionResult.status}`,
          },
        },
      });

      // Mark session complete
      await SessionHistoryStorage.markSessionComplete(
        sessionResult.id,
        historyStatus,
        (sessionResult.completedAt || new Date()).toISOString(),
        {
          durationMs,
          failureReason: sessionResult.error?.message,
          summary: `FSM ${job.name}: ${sessionResult.status}`,
        },
      );

      logger.info("Session persisted to history", {
        sessionId: sessionResult.id,
        workspaceId: this.workspace.id,
        jobName: job.name,
      });
    } catch (error) {
      // Log error but don't throw - persistence failure shouldn't break runtime
      logger.error("Failed to persist session to history", {
        error: stringifyError(error),
        sessionId: sessionResult.id,
        workspaceId: this.workspace.id,
      });
    }
  }
}
