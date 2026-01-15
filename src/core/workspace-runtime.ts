/**
 * WorkspaceRuntime - Multi-FSM coordinator with direct FSMEngine integration
 *
 * Manages multiple FSM definitions (jobs) and sessions within a workspace.
 * Each FSM represents a workflow, and each session is one FSM execution.
 */

import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import type { AgentResult, AtlasUIMessageChunk } from "@atlas/agent-sdk";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
import type { MergedConfig } from "@atlas/config";
import {
  AgentOrchestrator,
  type GlobalMCPServerPool,
  mapFsmEventToSessionEvent,
  ReasoningResultStatus,
  SessionHistoryStorage,
  UserConfigurationError,
} from "@atlas/core";
import { FileSystemDocumentStore } from "@atlas/document-store";
import {
  type AgentExecutor,
  AtlasLLMProviderAdapter,
  type Context,
  createEngine,
  FSMDefinitionSchema,
  type FSMEngine,
  type FSMEvent,
  GlobalMCPToolProvider,
  loadFromFile,
  type MCPToolProvider,
  type SignalWithContext,
} from "@atlas/fsm-engine";
import { createFSMOutputValidator, SupervisionLevel } from "@atlas/hallucination";
import { type GenerateSessionTitleInput, generateSessionTitle } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
import * as path from "@std/path";
import { z } from "zod";
import type {
  ITempestContextManager,
  ITempestMemoryManager,
  ITempestMessageManager,
  IWorkspaceArtifact,
  IWorkspaceSession,
  SessionSummary,
} from "../types/core.ts";
import { MessageUser } from "../types/core.ts";
import { buildAgentPrompt, validateAgentOutput } from "./agent-helpers.ts";

// Re-export for backward compatibility (was previously defined locally)
export type { SessionHistoryEventPayload } from "@atlas/core";

/**
 * Classify an error to determine session status.
 * UserConfigurationError (OAuth not connected, missing env vars) → "skipped"
 * All other errors → "failed"
 *
 * @internal Exported for testing
 */
export function classifySessionError(error: unknown): "skipped" | "failed" {
  return error instanceof UserConfigurationError ? "skipped" : "failed";
}

// WorkspaceRuntime signal type - plain payload without full IAtlasScope implementation
interface WorkspaceRuntimeSignal {
  id: string;
  type: string;
  data?: Record<string, unknown>;
  timestamp: Date;
  provider?: { id: string; name: string };
}

/** Minimal workspace info needed by WorkspaceRuntimeInit (internal use only) */
interface WorkspaceRuntimeInit {
  id: string;
  members?: { userId?: string };
}

/**
 * Convert FSMEvent to AtlasUIMessageChunk for streaming
 *
 * FSMEvent types (data-fsm-state-transition, data-fsm-action-execution) are
 * structurally compatible with AtlasUIMessageChunk data events. This function
 * performs explicit property mapping to satisfy TypeScript without unsafe casts.
 *
 * @returns AtlasUIMessageChunk or null if event is not an FSM event
 */
function fsmEventToStreamChunk(event: FSMEvent): AtlasUIMessageChunk | null {
  if (event.type === "data-fsm-state-transition") {
    return {
      type: "data-fsm-state-transition",
      data: {
        sessionId: event.data.sessionId,
        workspaceId: event.data.workspaceId,
        jobName: event.data.jobName,
        fromState: event.data.fromState,
        toState: event.data.toState,
        triggeringSignal: event.data.triggeringSignal,
        timestamp: event.data.timestamp,
      },
    };
  }
  if (event.type === "data-fsm-action-execution") {
    return {
      type: "data-fsm-action-execution",
      data: {
        sessionId: event.data.sessionId,
        workspaceId: event.data.workspaceId,
        jobName: event.data.jobName,
        actionType: event.data.actionType,
        actionId: event.data.actionId,
        state: event.data.state,
        status: event.data.status,
        durationMs: event.data.durationMs,
        error: event.data.error,
        timestamp: event.data.timestamp,
        inputSnapshot: event.data.inputSnapshot,
      },
    };
  }
  return null;
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
    /**
     * Session status:
     * - "completed": Finished successfully
     * - "failed": Platform/system error
     * - "skipped": User configuration issue (OAuth not connected, missing env vars)
     */
    status: "completed" | "failed" | "skipped";
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
  /** Human-readable description from workspace config */
  description?: string;
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
  /**
   * Session status:
   * - "active": Currently running
   * - "completed": Finished successfully
   * - "failed": Platform/system error
   * - "skipped": User configuration issue (OAuth not connected, missing env vars)
   */
  status: "active" | "completed" | "failed" | "skipped";
  startedAt: Date;
  completedAt?: Date;
  artifacts: IWorkspaceArtifact[];
  error?: Error;
  /** User ID from signal data, used for analytics */
  userId?: string;
  /** Captured FSM events (state transitions and action executions) for batch persistence */
  collectedFsmEvents?: FSMEvent[];
}

const analytics = createAnalyticsClient();

/**
 * WorkspaceRuntime coordinates multiple FSM executions (jobs) within a workspace.
 *
 * Architecture:
 * - Each job = one FSM definition (from config or file)
 * - Each signal processing = one FSM execution (session)
 * - Direct FSMEngine integration (no wrapper layer)
 */
export class WorkspaceRuntime {
  private workspace: WorkspaceRuntimeInit;
  private config: MergedConfig;
  private options: WorkspaceRuntimeOptions;
  private initialized = false;
  private createdByUserId?: string;

  // Shared resources
  private orchestrator: AgentOrchestrator;

  // Job tracking (each job has its own FSMEngine and DocumentStore)
  private jobs = new Map<string, FSMJob>();

  // Session tracking
  private sessions = new Map<string, ActiveSession>();
  private sessionResults = new Map<string, SessionResult>();
  private sessionCompletionEmitter = new EventEmitter();

  // Track emitted jobs to prevent duplicate analytics events on hot-reload
  private emittedJobs = new Set<string>();

  /** Emit job.defined analytics event (once per job, prevents duplicates on hot-reload) */
  private emitJobDefined(jobName: string): void {
    if (this.createdByUserId && !this.emittedJobs.has(jobName)) {
      this.emittedJobs.add(jobName);
      analytics.emit({
        eventName: EventNames.JOB_DEFINED,
        userId: this.createdByUserId,
        workspaceId: this.workspace.id,
        jobName,
      });
    }
  }

  constructor(
    workspace: WorkspaceRuntimeInit,
    config: MergedConfig,
    options: WorkspaceRuntimeOptions = {},
  ) {
    this.workspace = workspace;
    this.config = config;
    this.options = options;
    this.createdByUserId = workspace.members?.userId;

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
        description: jobSpec.description,
      });

      this.emitJobDefined(jobName);

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

      this.emitJobDefined(jobName);

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
        await stat(mainFSM);
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

    // Always create MCP tool provider when pool available
    // GlobalMCPToolProvider auto-includes atlas-platform for ambient tools (webfetch, artifacts)
    // even when workspace has no explicit MCP servers configured
    let mcpToolProvider: MCPToolProvider | undefined;
    const mcpServerConfigs = this.config.workspace.tools?.mcp?.servers || {};

    if (this.options.mcpServerPool) {
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
      validateOutput: createFSMOutputValidator(SupervisionLevel.STANDARD),
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
    abortSignal?: AbortSignal,
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
    const sessionResult = await this.processSignalForJob(job, signal, onStreamEvent, abortSignal);

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

    // Call onSessionFinished callback and cleanup
    await this.handleSessionCompletion(sessionResult);

    return activeSession.session;
  }

  /**
   * Process a signal for a specific job (FSM execution)
   */
  private async processSignalForJob(
    job: FSMJob,
    signal: WorkspaceRuntimeSignal,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    abortSignal?: AbortSignal,
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
    // Extract userId from signal data for analytics
    const userId = typeof signal.data?.userId === "string" ? signal.data.userId : undefined;
    const collectedFsmEvents: FSMEvent[] = [];
    const session: SessionResult = {
      id: sessionId,
      workspaceId: this.workspace.id,
      status: "active",
      startedAt: new Date(),
      artifacts: [],
      userId,
      collectedFsmEvents,
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
        {
          sessionId: session.id,
          workspaceId: this.workspace.id,
          abortSignal,
          // Handle streaming events from FSM actions and agent execution
          // Events may be:
          // 1. FSM events (data-fsm-*) - convert and forward, also capture for persistence
          // 2. Agent stream events (text, reasoning, tool-*, etc.) - forward directly
          onEvent: (event) => {
            if (onStreamEvent) {
              // Check if this is an FSM event that needs conversion
              const fsmChunk = fsmEventToStreamChunk(event);
              if (fsmChunk) {
                // FSM event - forward converted chunk
                onStreamEvent(fsmChunk);
              } else {
                // Non-FSM event (text, reasoning, etc.) - forward directly
                // These come from agent execution and are already AtlasUIMessageChunk format
                onStreamEvent(event as unknown as AtlasUIMessageChunk);
              }
            }

            // Capture FSM events for persistence (only actual FSM events)
            // Note: data-fsm-state-transition is no longer persisted
            if (
              event.type === "data-fsm-action-execution" ||
              event.type === "data-fsm-tool-call" ||
              event.type === "data-fsm-tool-result"
            ) {
              collectedFsmEvents.push(event);
            }
          },
        },
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
      session.completedAt = new Date();
      session.error = error instanceof Error ? error : new Error(String(error));
      session.status = classifySessionError(error);

      // Log appropriately based on error type
      if (session.status === "skipped") {
        logger.warn("Session skipped: user configuration issue", {
          sessionId: session.id,
          error: session.error.message,
          jobName: job.name,
        });
      } else {
        logger.error("Signal processing failed", {
          sessionId: session.id,
          error: session.error.message,
          currentState: job.engine.state,
          jobName: job.name,
        });
      }
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

    // Build context (facts, documents, signal data) with expanded artifacts
    const context = await buildAgentPrompt(
      agentId,
      fsmContext,
      signal, // Use actual signal instead of synthetic one
      signal._context?.abortSignal,
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

    // Extract datetime from signal data for session context
    const datetime = signal.data?.datetime as
      | {
          timezone: string;
          timestamp: string;
          localDate: string;
          localTime: string;
          timezoneOffset: string;
        }
      | undefined;

    // Execute agent via orchestrator
    const result = await this.orchestrator.executeAgent(agentId, prompt, {
      sessionId: signal._context?.sessionId || crypto.randomUUID(), // Use signal's sessionId or generate new
      workspaceId: signal._context?.workspaceId || this.workspace.id,
      streamId, // Pass streamId for conversation agent streaming support
      datetime, // Pass client datetime context
      // Forward ALL streaming events (text, reasoning, tool calls, FSM events, etc.)
      // The orchestrator emits AtlasUIMessageChunk which includes text streaming.
      // The signal._context.onEvent callback handles both:
      // 1. FSM events (data-fsm-*) - captured for session history persistence
      // 2. All other events (text, reasoning, etc.) - streamed to client
      // We cast to unknown first since FSMEvent is a subset of AtlasUIMessageChunk
      onStreamEvent: signal._context?.onEvent
        ? (chunk) => {
            const callback = signal._context?.onEvent;
            if (callback) {
              // Forward all chunks - the outer callback in processSignalForJob
              // handles routing FSM events to persistence and all events to the stream
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

    // Call onSessionFinished callback and cleanup
    await this.handleSessionCompletion(sessionResult);

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
   * Handle session completion: call callback, emit analytics, and cleanup tracking maps
   */
  private async handleSessionCompletion(sessionResult: SessionResult): Promise<void> {
    const { status, userId } = sessionResult;
    if (status === "active") return;

    logger.debug("handleSessionCompletion", {
      sessionId: sessionResult.id,
      status,
      userId: userId ?? "NOT_SET",
      willEmitAnalytics: Boolean(userId && (status === "completed" || status === "failed")),
    });

    // Emit analytics event for session completion (skip "skipped" status - it's a user config issue)
    if (userId && (status === "completed" || status === "failed")) {
      const eventName =
        status === "completed" ? EventNames.SESSION_COMPLETED : EventNames.SESSION_FAILED;
      logger.debug("Emitting session analytics", {
        eventName,
        userId,
        sessionId: sessionResult.id,
      });
      analytics.emit({
        eventName,
        userId,
        workspaceId: sessionResult.workspaceId,
        sessionId: sessionResult.id,
      });
    }

    if (this.options.onSessionFinished) {
      await this.options.onSessionFinished({
        workspaceId: this.workspace.id,
        sessionId: sessionResult.id,
        status,
        finishedAt: new Date().toISOString(),
        summary: `Session ${sessionResult.id}: ${status}`,
      });
    }

    this.sessions.delete(sessionResult.id);
    this.sessionResults.delete(sessionResult.id);
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
  getWorkspace(): WorkspaceRuntimeInit {
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
   * Generate and store a title for a session (fire-and-forget)
   */
  private async generateAndStoreTitle(
    sessionId: string,
    input: GenerateSessionTitleInput,
  ): Promise<void> {
    const title = await generateSessionTitle(input);
    const result = await SessionHistoryStorage.updateSessionTitle(sessionId, title);
    if (!result.ok) {
      logger.warn("Failed to store session title", { sessionId, error: result.error });
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
        jobDescription: job.description,
      });

      if (!createResult.ok) {
        logger.error("Failed to create session record", {
          error: createResult.error,
          sessionId: sessionResult.id,
        });
        return;
      }

      // Generate title before other writes to avoid race condition
      const { status } = sessionResult;
      if (status !== "active") {
        await this.generateAndStoreTitle(sessionResult.id, {
          signal: { type: signal.type, id: signal.id, data: signal.data },
          output: sessionResult.artifacts[0]?.data,
          status,
          jobName: job.name,
        }).catch((error) => {
          logger.warn("Title generation failed", {
            sessionId: sessionResult.id,
            error: stringifyError(error),
          });
        });
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

      // Persist FSM events: use captured events if available, fallback to document conversion
      if (sessionResult.collectedFsmEvents && sessionResult.collectedFsmEvents.length > 0) {
        // Sort events by timestamp for chronological order
        const sortedEvents = [...sessionResult.collectedFsmEvents].sort(
          (a, b) => a.data.timestamp - b.data.timestamp,
        );

        let successCount = 0;
        let failureCount = 0;

        for (const fsmEvent of sortedEvents) {
          try {
            const mappedEvent = mapFsmEventToSessionEvent(fsmEvent);
            // Preserve original FSM event timestamp instead of using persistence time
            const originalTimestamp = new Date(fsmEvent.data.timestamp).toISOString();
            await SessionHistoryStorage.appendSessionEvent({
              sessionId: sessionResult.id,
              emittedBy: "workspace-runtime",
              event: mappedEvent,
              emittedAt: originalTimestamp,
            });
            successCount++;
          } catch (eventError) {
            failureCount++;
            logger.debug("Failed to persist individual FSM event", {
              sessionId: sessionResult.id,
              eventType: fsmEvent.type,
              error: stringifyError(eventError),
            });
          }
        }

        // Log warning for partial failures
        if (failureCount > 0) {
          logger.warn("Partial failure persisting FSM events", {
            sessionId: sessionResult.id,
            successCount,
            failureCount,
            totalEvents: sortedEvents.length,
          });
        } else {
          logger.debug("All FSM events persisted successfully", {
            sessionId: sessionResult.id,
            eventCount: successCount,
          });
        }
      }
      // Note: Legacy fallback (convertFSMDocumentsToEvents) removed - old sessions
      // without collectedFsmEvents will simply have no step events

      // Extract output from FSM result documents
      const output = job.engine?.documents
        .filter((doc) => doc.type === "result" || doc.id.endsWith("_result"))
        .map((doc) => ({ id: doc.id, data: doc.data }));

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
            output,
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
          output,
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
