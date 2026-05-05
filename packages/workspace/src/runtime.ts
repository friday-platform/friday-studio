/** Multi-FSM coordinator: manages jobs and sessions within a workspace. */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import process from "node:process";
import {
  type AgentMemoryContext,
  type AgentResult,
  type AgentSkill,
  type AtlasUIMessageChunk,
  buildResolvedWorkspaceMemory,
  GLOBAL_WORKSPACE_ID,
  type LinkCredentialRef,
  type MCPServerConfig,
  type MemoryAdapter,
  type NarrativeStore,
  PLATFORM_TOOL_NAMES,
  type ResolvedWorkspaceMemory,
  type StoreMountBinding,
} from "@atlas/agent-sdk";
import {
  expandAgentActions,
  type GlobalSkillRefConfig,
  type InlineSkillConfig,
  type MergedConfig,
  parseSkillRef,
  resolveRuntimeAgentId,
  validateSignalPayload,
} from "@atlas/config";
import {
  AgentOrchestrator,
  type AgentResultData,
  buildSessionView,
  type EphemeralChunk,
  extractPlannedSteps,
  hasUnusableCredentialCause,
  isAgentAction,
  LLM_AGENT_ALLOWED_PLATFORM_TOOLS,
  mapActionToStepComplete,
  mapActionToStepStart,
  mapFsmEventToSessionEvent,
  mapStateSkippedToStepSkipped,
  mapValidationAttemptToStepValidation,
  ReasoningResultStatus,
  SessionHistoryStorage,
  type SessionStreamEvent,
  type SessionSummary as SessionSummaryV2,
  UserConfigurationError,
  WorkspaceSessionStatus,
  type WorkspaceSessionStatusType,
  wrapPlatformToolsWithScope,
} from "@atlas/core";
import { UserAdapter } from "@atlas/core/agent-loader";
import { ArtifactStorage } from "@atlas/core/artifacts/storage";
import { resolveEnvValues } from "@atlas/core/mcp-registry/credential-resolver";
import { applyPlatformEnv } from "@atlas/core/mcp-registry/discovery";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { type DocumentStore, getDocumentStore } from "@atlas/document-store";
import {
  type AgentAction,
  type AgentExecutor,
  AtlasLLMProviderAdapter,
  buildWorkspaceMeta,
  type Context,
  createEngine,
  type FSMActionExecutionEvent,
  type FSMBroadcastNotifier,
  type FSMDefinition,
  FSMDefinitionSchema,
  type Document as FSMDocument,
  type FSMEngine,
  type FSMEvent,
  type FSMStateSkippedEvent,
  type SignalWithContext,
  validateFSMStructure,
} from "@atlas/fsm-engine";
import { createFSMOutputValidator, SupervisionLevel } from "@atlas/hallucination";
import {
  type GenerateSessionTitleInput,
  generateSessionTitle,
  type PlatformModels,
} from "@atlas/llm";
import { logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import { extractArchiveContents, SkillStorage, validateSkillReferences } from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { withOtelSpan } from "@atlas/utils/telemetry.server";
import { parse as parseYAML } from "@std/yaml";
import { z } from "zod";
import {
  buildAgentPrompt,
  buildFinalAgentPrompt,
  extractAgentConfig,
  extractAgentConfigPrompt,
  validateAgentOutput,
} from "../../../apps/atlasd/src/agent-helpers.ts";
import { generateSessionSummary } from "../../../apps/atlasd/src/session-summarizer.ts";
import type {
  ITempestContextManager,
  ITempestMessageManager,
  IWorkspaceArtifact,
  IWorkspaceSession,
  SessionSummary,
} from "../../../apps/atlasd/src/types/core.ts";
import { MessageUser } from "../../../apps/atlasd/src/types/core.ts";
import {
  mountContextKey,
  setMountContext,
  takeMountContext,
} from "../../core/src/mount-context-registry.ts";
import type { CodeAgentExecutorOptions } from "./agent-executor-utils.ts";
import { createBashTool } from "./bash-tool.ts";
import type { MemoryMount } from "./config-schema.ts";
import { compileExecutionToFsm, ExecutionCompileError } from "./execution-to-fsm.ts";
import { assertGlobalWriteAllowed, isGlobalWriteAttempt } from "./global-scope-guard.ts";
import { MountSourceNotFoundError } from "./mount-errors.ts";
import { mountRegistry } from "./mount-registry.ts";
import { MountedStoreBinding } from "./mounted-store-binding.ts";
import { interpolateConfig, resolveWorkspaceVariables } from "./variable-interpolation.ts";

/**
 * Classify an error to determine session status.
 * UserConfigurationError (OAuth not connected, missing env vars) → "skipped"
 * All other errors → "failed"
 *
 * @internal Exported for testing
 */
export function classifySessionError(error: unknown): WorkspaceSessionStatusType {
  if (error instanceof UserConfigurationError) {
    return WorkspaceSessionStatus.SKIPPED;
  }
  // Deleted/expired credentials are user configuration issues, not platform bugs.
  // Classify as "skipped" to prevent false production failure alerts.
  if (hasUnusableCredentialCause(error)) return WorkspaceSessionStatus.SKIPPED;
  // User-initiated cancellation via AbortController. DOMException with
  // name="AbortError" is the standard shape; the session was interrupted
  // deliberately, not a platform failure.
  if (error instanceof Error && error.name === "AbortError") {
    return WorkspaceSessionStatus.CANCELLED;
  }
  return WorkspaceSessionStatus.FAILED;
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
  name?: string;
  members?: { userId?: string };
}

/**
 * Convert FSMEvent to AtlasUIMessageChunk for streaming
 *
 * Exhaustive over the FSMEvent union — `data-fsm-state-transition` and
 * `data-fsm-action-execution` map to AtlasUIMessageChunk data events. The
 * remaining variants (tool-call/tool-result/state-skipped/validation-attempt)
 * ride the `sessionStream` pipeline instead, so this function returns `null`
 * for them. The `never` tail forces a compile error if a new FSMEvent variant
 * is added without an explicit case here.
 */
function fsmEventToStreamChunk(event: FSMEvent): AtlasUIMessageChunk | null {
  switch (event.type) {
    case "data-fsm-state-transition":
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
    case "data-fsm-action-execution":
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
    case "data-fsm-tool-call":
    case "data-fsm-tool-result":
    case "data-fsm-state-skipped":
    case "data-fsm-validation-attempt":
      return null;
    default: {
      const _exhaustive: never = event;
      return _exhaustive;
    }
  }
}

// Stub factory functions for minimal IAtlasScope manager implementations
function createStubContextManager(): ITempestContextManager {
  return { add: () => {}, remove: () => {}, search: () => [], size: () => 0 };
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

/** Minimal interface for session event stream (avoids atlasd import) */
interface SessionStream {
  emit(event: SessionStreamEvent): void;
  emitEphemeral(chunk: EphemeralChunk): void;
  finalize(summary: SessionSummaryV2): Promise<void>;
  getBufferedEvents(): SessionStreamEvent[];
}

interface WorkspaceRuntimeOptions {
  lazy?: boolean;
  workspacePath?: string;
  daemonUrl?: string;
  /** Factory to create a session event stream (injected by daemon via registry) */
  createSessionStream?: (sessionId: string) => SessionStream;
  onSessionFinished?: (data: {
    workspaceId: string;
    sessionId: string;
    status: WorkspaceSessionStatusType;
    finishedAt: string;
    summary?: string;
  }) => void | Promise<void>;
  /**
   * Fires once per session right after the session view is built but before
   * teardown. Provides the last completed agent block's output, the inbound
   * `streamId`, and the `jobName`. Source platform (when relevant for
   * downstream side-effects like broadcasting) is recoverable from the
   * `streamId` prefix — chat thread IDs are canonically `<platform>:...`.
   * Errors thrown here are caught and logged; they do not affect session
   * status.
   */
  onSessionComplete?: (data: {
    workspaceId: string;
    sessionId: string;
    streamId: string | undefined;
    status: WorkspaceSessionStatusType;
    finalOutput: string | undefined;
    jobName: string;
  }) => Promise<void>;
  /** Memory adapter for bootstrap injection (feature-flagged via FRIDAY_MEMORY_BOOTSTRAP) */
  memoryAdapter?: MemoryAdapter;
  /** Parsed memory.mounts from workspace config — resolved at initialize time */
  memoryMounts?: MemoryMount[];
  /** Kernel workspace ID — only this workspace may hold rw mounts against _global */
  kernelWorkspaceId?: string;
  /** Platform model resolver — required for session summarization and other platform LLM calls */
  platformModels: PlatformModels;
  /** Injectable agent executor. Injected by daemon as ProcessAgentExecutor (NATS). */
  agentExecutor?: {
    execute(
      agentPath: string,
      prompt: string,
      options: CodeAgentExecutorOptions,
    ): Promise<AgentResult>;
  };
  /**
   * Outbound chat broadcaster. Forwarded into FSMEngineOptions so `notification`
   * actions can fan messages out across configured chat communicators. Daemon
   * wraps `ChatSdkNotifier` + `broadcastDestinations` and supplies it here.
   */
  broadcastNotifier?: FSMBroadcastNotifier;
}

/**
 * Job definition. Engines are not shared: every signal that matches a job
 * spawns its own `FSMEngine` via `createJobEngine`, runs to completion, and
 * exits. Cross-signal coordination (serialize, dedup, singleton) is handled
 * by the trigger source or the message broker — not by the runtime.
 */
interface FSMJob {
  name: string;
  fsmPath: string;
  signals: string[];
  fsmDefinition?: unknown;
  /** Human-readable description from workspace config */
  description?: string;
  /** Max LLM tool-calling steps for FSM actions */
  maxSteps?: number;
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
  status: WorkspaceSessionStatusType;
  startedAt: Date;
  completedAt?: Date;
  artifacts: IWorkspaceArtifact[];
  error?: Error;
  /** User ID from signal data */
  userId?: string;
  /** Captured FSM events (state transitions and action executions) for batch persistence */
  collectedFsmEvents?: FSMEvent[];
  /** Snapshot of the per-signal engine's documents at completion. */
  engineDocuments?: FSMDocument[];
  finalState?: string;
}

/**
 * Pull a printable string out of an agent block's `output: unknown`. Agents
 * emit a few different shapes — a plain string, `{ text }`, or a wrapped
 * `{ data: { text } }` — and `String({...})` would land "[object Object]" on
 * the consumer. JSON-stringify is the last resort for unknown shapes.
 */
export function extractTextFromAgentOutput(output: unknown): string | undefined {
  if (output === undefined || output === null) return undefined;
  if (typeof output === "string") return output;
  if (typeof output !== "object") return String(output);

  const o = output as Record<string, unknown>;
  // Direct fields first (some agents emit the text at the top level).
  for (const key of ["text", "response", "result", "output", "content", "message"]) {
    if (typeof o[key] === "string") return o[key] as string;
  }
  // Then walk one level into `data` (the FSM-document shape).
  if (typeof o.data === "object" && o.data !== null) {
    const inner = o.data as Record<string, unknown>;
    for (const key of ["text", "response", "result", "output", "content", "message"]) {
      if (typeof inner[key] === "string") return inner[key] as string;
    }
  }
  // Last resort: stringify the whole thing (better than dropping the broadcast).
  try {
    return JSON.stringify(output);
  } catch {
    return undefined;
  }
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
  private workspace: WorkspaceRuntimeInit;
  private config: MergedConfig;
  private options: WorkspaceRuntimeOptions;
  private initialized = false;

  // Shared resources
  private orchestrator: AgentOrchestrator;
  private userAdapter = new UserAdapter(path.join(getFridayHome(), "agents"));

  // Job tracking (each job has its own FSMEngine and DocumentStore)
  private jobs = new Map<string, FSMJob>();

  // Session tracking
  private sessions = new Map<string, ActiveSession>();
  private sessionResults = new Map<string, SessionResult>();
  /**
   * FSM document snapshots captured at `handleSessionCompletion`, keyed by
   * sessionId. The live `sessions` map is cleared before the signal endpoint
   * returns, but synchronous callers (`triggerWorkspaceSignal` in atlas-daemon)
   * still need to read the final output docs afterward. The map is bounded
   * naturally by the runtime's lifecycle — daemon idle eviction at 5min
   * tears down the runtime and frees the map. The bounded-by-runtime
   * guarantee is sufficient for the single-host model. Cross-worker
   * access in a future per-worker model needs to read from the
   * persistent session-history store instead.
   */
  private completedSessionDocuments = new Map<
    string,
    Array<{ id: string; type: string; data: Record<string, unknown> }>
  >();
  private sessionCompletionEmitter = new EventEmitter();

  /**
   * AbortController per in-flight session. Populated in processSignalForJob
   * at session start, removed in its finally block. `sessions` only gets a
   * terminal entry after finalizeSession runs, so cancellation needs its own
   * map covering the "currently executing" window. `cancelSession` aborts
   * the controller; downstream (FSM engine, agent orchestrator) already
   * observes the signal because it threads through `processSignal`'s
   * abortSignal parameter.
   */
  private activeAbortControllers = new Map<string, AbortController>();

  /**
   * Engine registry keyed by sessionId. Populated in `processSignalForJob`
   * for the duration of one signal's execution; cleared in the finally block.
   * Lets external callers (e.g. HTTP endpoints querying mid-flight FSM docs)
   * find the engine for a given sessionId without closure access.
   */
  private sessionEngines = new Map<string, FSMEngine>();

  // Agent result side-channel: sessionId → (sideChannelKey → AgentResultData)
  // Populated by executeAgent, consumed by onEvent callback for step:complete events
  private agentResultSideChannel = new Map<string, Map<string, AgentResultData>>();

  // Resolved store mount bindings, keyed by mount name
  private mountBindings = new Map<string, MountedStoreBinding>();

  // Fully-resolved memory surface (own + mounts + global access), built after initialize()
  private _resolvedMemory: ResolvedWorkspaceMemory | undefined;

  /** Tracks jobs we've already warned about to avoid log spam on hot-reload. */
  private warnedJobs = new Set<string>();

  /**
   * D.1: surface two classes of drift between `jobs.*.skills` in YAML and
   * the skill_assignments table:
   *
   *   1. A ref doesn't match any skill in the catalog — declarative intent
   *      mentions a skill that doesn't exist. Probably a typo or a skill
   *      that needs installing.
   *   2. The ref exists in the catalog but there's no `(skillId, ws, jobName)`
   *      row — YAML declared intent but the scoping API hasn't been used
   *      to create the assignment. Useful when someone hand-edits YAML
   *      and expects it to take effect without going through the UI/CLI.
   *
   * Declarative-only: warnings don't block job registration or auto-create
   * assignments. Fires once per (workspace, job) per runtime lifetime.
   */
  private async warnOnDeclarativeJobSkills(jobName: string, refs: string[]): Promise<void> {
    const key = `${this.workspace.id}/${jobName}`;
    if (this.warnedJobs.has(key)) return;
    this.warnedJobs.add(key);

    try {
      const [catalogResult, assignedResult] = await Promise.all([
        SkillStorage.list(undefined, undefined, true),
        SkillStorage.listAssignmentsForJob(this.workspace.id, jobName),
      ]);

      const catalog = catalogResult.ok ? catalogResult.data : [];
      const assignedRefs = new Set(
        (assignedResult.ok ? assignedResult.data : []).map((s) => `@${s.namespace}/${s.name}`),
      );
      const catalogRefs = new Set(
        catalog
          .filter((s) => s.name !== null && s.name !== "")
          .map((s) => `@${s.namespace}/${s.name}`),
      );

      const unresolved = refs.filter((r) => !catalogRefs.has(r));
      const missingAssignments = refs.filter((r) => catalogRefs.has(r) && !assignedRefs.has(r));

      for (const ref of unresolved) {
        logger.warn("jobs.*.skills ref not in catalog", {
          workspaceId: this.workspace.id,
          jobName,
          ref,
          hint: "Declarative only; no assignment will be created. Install the skill or remove the ref.",
        });
      }

      if (missingAssignments.length > 0) {
        logger.warn("jobs.*.skills declares refs with no matching assignments", {
          workspaceId: this.workspace.id,
          jobName,
          declared: refs.length,
          unassigned: missingAssignments.length,
          refs: missingAssignments,
          hint: "Use the Job Skills UI (/platform/:ws/jobs/:jobName) or the scoping API to create the assignments.",
        });
      }
    } catch (error) {
      logger.debug("Failed to run declarative skills audit", {
        workspaceId: this.workspace.id,
        jobName,
        error: stringifyError(error),
      });
    }
  }

  constructor(
    workspace: WorkspaceRuntimeInit,
    config: MergedConfig,
    options: WorkspaceRuntimeOptions,
  ) {
    this.workspace = workspace;
    this.config = config;
    this.options = options;

    // Create shared AgentOrchestrator (can handle concurrent executions)
    const agentsServerUrl = options.daemonUrl || "http://localhost:8080";
    this.orchestrator = new AgentOrchestrator(
      {
        agentsServerUrl: `${agentsServerUrl}/agents`,
        daemonUrl: options.daemonUrl,
        requestTimeoutMs: 900000,
      },
      logger.child({ component: "AgentOrchestrator", workspaceId: workspace.id }),
    );
  }

  get workspaceId(): string {
    return this.workspace.id;
  }

  get resolvedMemory(): ResolvedWorkspaceMemory | undefined {
    return this._resolvedMemory;
  }

  /** Discover and load all FSM definitions. */
  async initialize(): Promise<void> {
    if (this.initialized) {
      logger.debug("Runtime already initialized", { workspaceId: this.workspace.id });
      return;
    }

    logger.info("Initializing multi-FSM workspace runtime", { workspaceId: this.workspace.id });

    const workspacePath =
      this.options.workspacePath || path.join(getFridayHome(), "workspaces", this.workspace.id);

    // Resolve workspace variables and interpolate config placeholders ({{repo_root}}, etc.)
    const wsVars = await resolveWorkspaceVariables(
      workspacePath,
      this.workspace.id,
      this.options.daemonUrl,
    );
    if (wsVars) {
      this.config = { ...this.config, workspace: interpolateConfig(this.config.workspace, wsVars) };
      if (this.config.atlas) {
        this.config = { ...this.config, atlas: interpolateConfig(this.config.atlas, wsVars) };
      }
    }

    const configJobs = this.config.workspace.jobs || {};

    // Reserved signal name validation — "chat" is system-owned
    const configSignals = this.config.workspace.signals || {};
    if (configSignals.chat) {
      throw new Error(
        `Workspace "${this.workspace.id}" defines a "chat" signal, but "chat" is reserved for workspace direct chat. Rename your signal.`,
      );
    }

    // Skip chat injection for the kernel system workspace
    const SKIP_CHAT_INJECTION = new Set(["system"]);

    if (!SKIP_CHAT_INJECTION.has(this.workspace.id)) {
      // Auto-inject chat signal + handle-chat job for workspace direct chat
      // Signal payload (chatId, userId, streamId) is available to the agent via signal.data directly.
      const chatFSM = {
        id: `${this.workspace.id}-chat`,
        initial: "idle",
        states: {
          idle: { on: { chat: { target: "processing" } } },
          processing: {
            entry: [
              { type: "agent", agentId: "workspace-chat", outputTo: "chat-result" },
              { type: "emit", event: "chat_complete" },
            ],
            on: { chat_complete: { target: "idle" } },
          },
        },
      };

      this.jobs.set("handle-chat", {
        name: "handle-chat",
        fsmPath: "",
        signals: ["chat"],
        fsmDefinition: chatFSM,
        description: "Direct chat with workspace",
      });

      logger.debug("Auto-injected handle-chat job for workspace direct chat", {
        workspaceId: this.workspace.id,
      });
    }

    for (const [jobName, jobSpec] of Object.entries(configJobs)) {
      // Resolve the FSM definition: hand-authored `fsm:` takes precedence;
      // otherwise compile the simpler `execution.sequential` shape into an
      // equivalent FSM at load time. Without this fallback the runtime used
      // to silently skip non-FSM jobs, which caused signal dispatch to 404
      // even though the chat agent saw the job via the config API.
      let fsmDefinition = jobSpec.fsm;
      if (!fsmDefinition && jobSpec.execution) {
        try {
          fsmDefinition = compileExecutionToFsm(jobName, jobSpec);
          logger.info("Compiled execution.sequential to FSM", {
            jobName,
            agents: jobSpec.execution.agents.length,
          });
        } catch (error) {
          if (error instanceof ExecutionCompileError) {
            logger.warn("Could not compile execution block to FSM — skipping job", {
              jobName,
              reason: error.message,
            });
            continue;
          }
          throw error;
        }
      }
      if (!fsmDefinition) {
        logger.debug("Skipping job with neither fsm nor execution", { jobName });
        continue;
      }

      const signals = (jobSpec.triggers || []).map((t) => t.signal).filter(Boolean);

      this.jobs.set(jobName, {
        name: jobName,
        fsmPath: "", // Empty for inline FSM
        signals,
        fsmDefinition,
        description: jobSpec.description,
        maxSteps: jobSpec.config?.max_steps,
      });

      // D.1: declarative `jobs.*.skills` field — warn when refs don't match
      // the catalog or when zero matching DB rows exist (no scoping API
      // sync). Best-effort; failures don't block job registration.
      if (jobSpec.skills && jobSpec.skills.length > 0) {
        void this.warnOnDeclarativeJobSkills(jobName, jobSpec.skills);
      }

      logger.debug("Registered inline FSM job from config", {
        jobName,
        signals,
        triggerCount: jobSpec.triggers?.length || 0,
      });
    }

    const fsmFiles = await this.discoverFSMFiles(workspacePath);

    logger.info("Discovered standalone FSM files", {
      workspaceId: this.workspace.id,
      count: fsmFiles.length,
      files: fsmFiles,
    });

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

    // Resolve memory mounts — fail loud if any source store is missing
    if (this.options.memoryMounts && this.options.memoryMounts.length > 0) {
      await this.resolveMounts(this.options.memoryMounts);
    }

    this._resolvedMemory = buildResolvedWorkspaceMemory({
      workspaceId: this.workspace.id,
      ownEntries: this.config.workspace.memory?.own ?? [],
      mountDeclarations: this.options.memoryMounts ?? [],
      kernelWorkspaceId: this.options.kernelWorkspaceId,
    });

    this.initialized = true;

    logger.info("Runtime initialized", {
      workspaceId: this.workspace.id,
      jobCount: this.jobs.size,
      jobs: Array.from(this.jobs.keys()),
      mountCount: this.mountBindings.size,
    });
  }

  private async resolveMounts(mounts: MemoryMount[]): Promise<void> {
    const adapter = this.options.memoryAdapter;
    if (!adapter) {
      throw new Error("memoryMounts requires memoryAdapter in WorkspaceRuntimeOptions");
    }

    // TODO(phase-1b): Enforce shareable validation before resolving each mount.
    // Currently any workspace can mount another workspace's store without the
    // source having declared it via memory.shareable.list / allowedWorkspaces.
    // When a getWorkspaceConfig(wsId) callback is available on
    // WorkspaceRuntimeOptions, verify the mounted store name is in
    // shareable.list and the consumer is in allowedWorkspaces (or absent = all).
    // If no shareable block exists on the source, allow the mount (backward-compat).
    // See: design memo for memory-three-scope-model task.

    for (const mount of mounts) {
      const sourceId = mount.source;
      const sourceParts = sourceId.split("/");
      const sourceWsId = sourceParts[0];
      const storeKind = sourceParts[1];
      const memoryName = sourceParts[2];

      if (!sourceWsId || !storeKind || !memoryName) {
        throw new MountSourceNotFoundError(
          sourceId,
          `Mount '${mount.name}': invalid source format '${mount.source}' — ` +
            `expected '{workspaceId}/{kind}/{memoryName}'`,
        );
      }

      if (storeKind !== "narrative") {
        throw new MountSourceNotFoundError(
          sourceId,
          `Mount '${mount.name}': only narrative memories are supported for mounts, got '${storeKind}'`,
        );
      }

      if (isGlobalWriteAttempt(sourceWsId, mount.mode)) {
        assertGlobalWriteAllowed(this.workspace.id, this.options.kernelWorkspaceId);
      }

      mountRegistry.registerSource(sourceId, () => adapter.store(sourceWsId, memoryName));
      mountRegistry.addConsumer(sourceId, this.workspace.id);

      let resolvedStore: NarrativeStore;
      try {
        resolvedStore = await adapter.store(sourceWsId, memoryName);
      } catch {
        throw new MountSourceNotFoundError(
          sourceId,
          `Mount '${mount.name}': source memory '${mount.source}' not found — ` +
            `check memory.mounts[].source in workspace config`,
        );
      }

      const binding = new MountedStoreBinding({
        name: mount.name,
        source: mount.source,
        mode: mount.mode,
        scope: mount.scope,
        scopeTarget: mount.scopeTarget,
        read: (filter) => resolvedStore.read(filter),
        append: (entry) => resolvedStore.append(entry),
      });

      this.mountBindings.set(mount.name, binding);

      logger.debug("Resolved mount binding", {
        workspaceId: this.workspace.id,
        mount: mount.name,
        source: mount.source,
        mode: mount.mode,
        scope: mount.scope,
      });
    }
  }

  getMountsForAgent(agentId: string, jobName?: string): Record<string, StoreMountBinding> {
    const result: Record<string, StoreMountBinding> = {};
    for (const binding of this.mountBindings.values()) {
      switch (binding.scope) {
        case "workspace":
          result[binding.name] = binding;
          break;
        case "job":
          if (jobName && binding.scopeTarget === jobName) {
            result[binding.name] = binding;
          }
          break;
        case "agent":
          if (binding.scopeTarget === agentId) {
            result[binding.name] = binding;
          }
          break;
      }
    }
    return result;
  }

  private async discoverFSMFiles(workspacePath: string): Promise<string[]> {
    const fsmFiles: string[] = [];

    try {
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

  private async createJobEngine(
    job: FSMJob,
    sessionId: string,
  ): Promise<{ engine: FSMEngine; documentStore: DocumentStore }> {
    // Stateless model: every signal spawns a fresh engine bound to its
    // sessionId. The optional-sessionId branch was a relic of the deleted
    // "single-flight" path where one engine spanned multiple signals.
    // DocumentStore is the daemon-wired JetStream singleton (per-workspace
    // KV bucket internally; one connection shared across job engines).
    const documentStore = getDocumentStore();

    const agentExecutor: AgentExecutor = (action, context, signal, options) =>
      this.executeAgent(action, context, job, signal, options);

    const mcpServerConfigs = this.config.workspace.tools?.mcp?.servers || {};

    const scope = { workspaceId: this.workspace.id, workspaceName: this.workspace.name, sessionId };
    const platformModels = this.options.platformModels;
    if (!platformModels) {
      throw new Error(
        "WorkspaceRuntime requires platformModels to construct AtlasLLMProviderAdapter",
      );
    }
    const engineOptions = {
      documentStore,
      scope,
      llmProvider: new AtlasLLMProviderAdapter(platformModels.get("conversational"), {
        maxSteps: job.maxSteps,
      }),
      agentExecutor,
      mcpServerConfigs,
      validateOutput: createFSMOutputValidator(
        SupervisionLevel.STANDARD,
        this.options.platformModels,
      ),
      artifactStorage: ArtifactStorage,
      broadcastNotifier: this.options.broadcastNotifier,
    };

    let definition: FSMDefinition;
    if (job.fsmDefinition) {
      logger.debug("Loading FSM from inline definition", {
        workspaceId: this.workspace.id,
        jobName: job.name,
        sessionId,
      });

      // Inline FSMs in workspace.yml jobs don't include `id` — the job name is the identity.
      // Inject it before parsing so the engine has a document-store scope key.
      const parsed = FSMDefinitionSchema.parse(
        typeof job.fsmDefinition === "object" && job.fsmDefinition !== null
          ? { id: job.name, ...job.fsmDefinition }
          : job.fsmDefinition,
      );
      definition = expandAgentActions(parsed, this.config.workspace.agents ?? {});
    } else {
      const configPath =
        this.options.workspacePath || path.join(getFridayHome(), "workspaces", this.workspace.id);
      const fsmPath = job.fsmPath || path.join(configPath, "workspace.fsm.yaml");

      logger.debug("Loading FSM from file", { workspaceId: this.workspace.id, fsmPath });

      const yaml = await readFile(fsmPath, "utf-8");
      const raw = z.object({ fsm: FSMDefinitionSchema }).parse(parseYAML(yaml));

      definition = expandAgentActions(raw.fsm, this.config.workspace.agents ?? {});

      const validation = validateFSMStructure(definition);
      if (!validation.valid) {
        throw new Error(`FSM validation failed:\n${validation.errors.join("\n")}`);
      }
    }

    const engine = createEngine(definition, engineOptions);
    await engine.initialize();
    return { engine, documentStore };
  }

  /** Route a signal to its matching FSM job and execute. */
  async processSignal(
    signal: WorkspaceRuntimeSignal,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    abortSignal?: AbortSignal,
    skipStates?: string[],
  ): Promise<IWorkspaceSession> {
    await this.ensureInitialized();

    logger.info("Processing signal", {
      workspaceId: this.workspace.id,
      signalId: signal.id,
      jobCount: this.jobs.size,
    });

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

    const signalConfig = this.config.workspace.signals?.[signal.id];
    if (signalConfig) {
      const validation = validateSignalPayload(signalConfig, signal.data);
      if (!validation.success) {
        throw new Error(`Signal payload validation failed for '${signal.id}': ${validation.error}`);
      }
    }

    const sessionResult = await this.processSignalForJob(
      job,
      signal,
      onStreamEvent,
      abortSignal,
      skipStates,
    );
    return this.finalizeSession(sessionResult, job, signal);
  }

  private async processSignalForJob(
    job: FSMJob,
    signal: WorkspaceRuntimeSignal,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    abortSignal?: AbortSignal,
    skipStates?: string[],
  ): Promise<SessionResult> {
    const sessionId = crypto.randomUUID();

    // Every signal spawns a fresh engine, runs to completion, exits.
    // Per-session document scope `(workspaceId, jobName, sessionId)`.
    const { engine } = await this.createJobEngine(job, sessionId);
    this.sessionEngines.set(sessionId, engine);

    // Seed __meta into engine results so code actions can reference
    // workspace_path, repo_root, workspace_id, and platform_url via
    // context.results['__meta'] without hardcoding operator paths.
    const workspacePath =
      this.options.workspacePath ?? path.join(getFridayHome(), "workspaces", this.workspace.id);
    engine.seedResults({
      __meta: buildWorkspaceMeta({
        workspacePath,
        workspaceId: this.workspace.id,
        daemonUrl: this.options.daemonUrl,
      }),
    });

    // Per-session AbortController. Composes with any parent signal passed in
    // (so a canceled HTTP request still propagates) and is registered in
    // `activeAbortControllers` so `cancelSession()` can abort mid-execution.
    // Downstream (FSM engine `engine.signal({..., abortSignal})`) already
    // observes this — no additional wiring needed.
    const sessionAbortController = new AbortController();
    if (abortSignal) {
      if (abortSignal.aborted) {
        sessionAbortController.abort(abortSignal.reason);
      } else {
        abortSignal.addEventListener(
          "abort",
          () => sessionAbortController.abort(abortSignal.reason),
          { once: true },
        );
      }
    }
    this.activeAbortControllers.set(sessionId, sessionAbortController);
    const effectiveAbortSignal = sessionAbortController.signal;

    return withOtelSpan(
      "session.process",
      {
        "atlas.workspace.id": this.workspace.id,
        "atlas.session.id": sessionId,
        "atlas.signal.id": signal.id,
        "atlas.job.name": job.name,
      },
      async (otelSpan) => {
        const userId = typeof signal.data?.userId === "string" ? signal.data.userId : undefined;
        const session: SessionResult = {
          id: sessionId,
          workspaceId: this.workspace.id,
          status: WorkspaceSessionStatus.ACTIVE,
          startedAt: new Date(),
          artifacts: [],
          userId,
        };

        // Session history v2: create stream + side-channel for this session
        const sessionStream = this.options.createSessionStream?.(sessionId);
        const sideChannel = new Map<string, AgentResultData>();
        this.agentResultSideChannel.set(sessionId, sideChannel);
        let stepCounter = 0;
        /** Tracks the FSM state where a non-agent action (code/emit) failed, so we
         *  can attribute the error to the correct planned step in the catch block. */
        let failedActionStateId: string | undefined;

        logger.info("Processing signal via FSM", {
          sessionId: session.id,
          signalType: signal.id,
          currentState: engine.state,
          jobName: job.name,
        });

        const rawPlannedSteps = extractPlannedSteps(engine.definition);
        const plannedSteps =
          rawPlannedSteps.length > 0
            ? rawPlannedSteps.map((step) => ({
                agentName: step.agentName,
                stateId: step.stateId,
                task: this.config.workspace.agents?.[step.agentName]?.description ?? step.agentName,
                actionType: step.actionType,
              }))
            : undefined;

        sessionStream?.emit({
          type: "session:start",
          sessionId,
          workspaceId: this.workspace.id,
          jobName: job.name,
          task: typeof signal.data?.task === "string" ? signal.data.task : job.name,
          plannedSteps,
          timestamp: session.startedAt.toISOString(),
        });

        // Emit session-start to the client's SSE stream so the UI can display
        // the session ID (e.g. in the "Report issue" button). This only covers
        // live streaming — for persistence across page reloads, the conversation
        // agent also injects this part before saving to chat storage.
        if (onStreamEvent) {
          await onStreamEvent({ type: "data-session-start", data: { sessionId } });
        }

        // (activity subsystem deleted 2026-05-02 — was write-only with no
        // consumer reading the records. Source of truth for "what
        // happened in workspace X" is the SESSIONS JetStream stream.)

        try {
          await engine.signal(
            { type: signal.id, data: signal.data || {} },
            {
              sessionId: session.id,
              workspaceId: this.workspace.id,
              abortSignal: effectiveAbortSignal,
              skipStates,
              // FSM lifecycle events only (state transitions, action executions, tool calls/results)
              onEvent: (event) => {
                if (onStreamEvent) {
                  const fsmChunk = fsmEventToStreamChunk(event);
                  if (fsmChunk) {
                    onStreamEvent(fsmChunk);
                  }
                }

                if (
                  sessionStream &&
                  event.type === "data-fsm-action-execution" &&
                  isAgentAction(event as FSMActionExecutionEvent)
                ) {
                  const actionEvent = event as FSMActionExecutionEvent;
                  if (actionEvent.data.status === "started") {
                    stepCounter++;
                    sessionStream.emit(mapActionToStepStart(actionEvent, stepCounter));
                  } else if (
                    actionEvent.data.status === "completed" ||
                    actionEvent.data.status === "failed"
                  ) {
                    // LLM actions carry result data directly on the event (populated by FSM engine).
                    // Agent actions use the side-channel (populated by executeAgent callback).
                    let agentResult: AgentResultData | undefined;
                    if (actionEvent.data.llmResult) {
                      agentResult = actionEvent.data.llmResult;
                    } else {
                      // Side-channel key must use job.name (workspace-level key) to match
                      // what executeAgent stores — NOT actionEvent.data.jobName which is
                      // the FSM definition's id (may differ from the workspace job key).
                      const sideChannelKey = `${job.name}/${actionEvent.data.actionId}/${actionEvent.data.state}`;
                      agentResult = sideChannel.get(sideChannelKey);
                      sideChannel.delete(sideChannelKey);
                    }
                    sessionStream.emit(
                      mapActionToStepComplete(actionEvent, agentResult, stepCounter),
                    );
                  }
                }

                // Track the state where a non-agent action failed — the catch
                // block uses this to emit synthetic step events for the agent that
                // was queued behind the failing code action.
                if (
                  event.type === "data-fsm-action-execution" &&
                  !isAgentAction(event as FSMActionExecutionEvent)
                ) {
                  const actionEvent = event as FSMActionExecutionEvent;
                  if (actionEvent.data.status === "failed") {
                    failedActionStateId = actionEvent.data.state;
                  }
                }

                // Session history v2: map skipped states to step:skipped events
                if (sessionStream && event.type === "data-fsm-state-skipped") {
                  sessionStream.emit(mapStateSkippedToStepSkipped(event as FSMStateSkippedEvent));
                }

                // mapValidationAttemptToStepValidation returns null when the
                // source event is missing actionId — keeps the wire schema's
                // actionId required without emitting orphan UI pills.
                if (sessionStream && event.type === "data-fsm-validation-attempt") {
                  const stepEvent = mapValidationAttemptToStepValidation(event);
                  if (stepEvent) sessionStream.emit(stepEvent);
                }
              },
              // Agent UIMessageChunks (text, reasoning, tool-call, etc.) flow through
              // this separate channel, bypassing the FSMEvent-typed onEvent callback
              onStreamEvent: (chunk) => {
                onStreamEvent?.(chunk);
                sessionStream?.emitEphemeral({ stepNumber: stepCounter, chunk });
              },
            },
          );

          session.artifacts = this.extractArtifacts(engine.documents);
          session.completedAt = new Date();

          // A cancelled agent call currently returns a successful-looking
          // result (the orchestrator maps MCP "cancelled" → "completed" on
          // line ~177 of agent-orchestrator.ts). So success-path arrivals
          // still count as cancellations when the user hit Stop; check the
          // AbortController we composed up top and override the status.
          if (effectiveAbortSignal.aborted) {
            session.status = WorkspaceSessionStatus.CANCELLED;
          } else {
            session.status = WorkspaceSessionStatus.COMPLETED;
          }

          logger.info("Signal processed successfully", {
            sessionId: session.id,
            finalState: engine.state,
            artifactCount: session.artifacts.length,
            jobName: job.name,
            status: session.status,
          });
        } catch (error) {
          session.completedAt = new Date();
          session.error = error instanceof Error ? error : new Error(String(error));
          // Prefer the explicit cancel signal over error-name pattern matching —
          // a downstream `AbortError` isn't always what bubbles up from MCP.
          if (effectiveAbortSignal.aborted) {
            session.status = WorkspaceSessionStatus.CANCELLED;
          } else {
            session.status = classifySessionError(error);
          }

          if (otelSpan) {
            if (error instanceof Error) otelSpan.recordException(error);
            otelSpan.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: String(error) });
          }

          if (session.status === WorkspaceSessionStatus.SKIPPED) {
            logger.warn("Session skipped: user configuration issue", {
              sessionId: session.id,
              error: session.error.message,
              jobName: job.name,
            });
          } else {
            // `warn`, not `error`. Session-level domain failures (LLM API
            // rejection, tool error, FSM step failure) are captured in the
            // session record itself and surfaced again by the cascade
            // dispatcher's `Cascade session failed` warn line. Logging at
            // error here triggered duplicate alerts for the same event;
            // operators reading at error level should see infra-level
            // failures, not every workspace job that hit a domain error.
            logger.warn("Signal processing failed", {
              sessionId: session.id,
              error: session.error,
              currentState: engine.state,
              jobName: job.name,
            });
          }

          // Emit synthetic step:start + step:complete(failed) for the agent action
          // in the state that threw. Code actions run before agent actions in entry
          // sequences — when a code action throws, the agent never starts and its
          // block stays "pending", incorrectly swept to "skipped" by session:complete.
          // This attributes the error to the correct step.
          if (sessionStream && plannedSteps && failedActionStateId) {
            const failedStep = plannedSteps.find((s) => s.stateId === failedActionStateId);
            if (failedStep) {
              const now = new Date().toISOString();
              stepCounter++;
              sessionStream.emit({
                type: "step:start",
                sessionId,
                stepNumber: stepCounter,
                agentName: failedStep.agentName,
                stateId: failedStep.stateId,
                actionType: failedStep.actionType,
                task: failedStep.task,
                timestamp: now,
              });
              sessionStream.emit({
                type: "step:complete",
                sessionId,
                stepNumber: stepCounter,
                status: "failed",
                durationMs: 0,
                toolCalls: [],
                output: undefined,
                error: session.error?.message,
                timestamp: now,
              });
            }
          }

          // Emit error event so the client SSE stream receives it.
          // Without this, errors are swallowed — the .catch() in chat.ts never
          // fires because this function always resolves (never rejects).
          if (onStreamEvent) {
            try {
              await onStreamEvent({
                type: "data-error",
                data: { error: stringifyError(session.error), errorCause: session.error },
              });
            } catch (emitError) {
              logger.error("Failed to emit error event", {
                sessionId: session.id,
                error: emitError,
              });
            }
          }
        } finally {
          if (onStreamEvent) {
            try {
              await onStreamEvent({
                type: "data-session-finish",
                data: {
                  sessionId: session.id,
                  workspaceId: this.workspace.id,
                  status: session.status,
                },
              });
            } catch (emitError) {
              logger.error("Failed to emit session-finish event", {
                sessionId: session.id,
                error: emitError,
              });
            }
          }

          if (sessionStream) {
            const durationMs = session.completedAt
              ? session.completedAt.getTime() - session.startedAt.getTime()
              : 0;

            sessionStream.emit({
              type: "session:complete",
              sessionId,
              // `active` can only happen via an unreachable codepath (entry is
              // default-initialized); fall back to "completed" so the stream
              // never emits a half-open terminal event.
              status: session.status === "active" ? "completed" : session.status,
              durationMs,
              error: session.error?.message,
              timestamp: (session.completedAt ?? new Date()).toISOString(),
            });

            const view = buildSessionView(sessionStream.getBufferedEvents());

            // Only count actually-executed blocks in summary metrics
            const executedBlocks = view.agentBlocks.filter(
              (b) => b.status !== "skipped" && b.status !== "pending",
            );

            const platformModels = this.options.platformModels;
            // Skip AI summarization for code-only sessions (no agent blocks) —
            // nothing meaningful to summarize and it adds ~2s of LLM latency per invocation.
            const aiSummary =
              platformModels && executedBlocks.length > 0
                ? await generateSessionSummary(
                    view,
                    { platformModels },
                    job.description,
                    this.workspace.name,
                  )
                : undefined;
            if (aiSummary) {
              sessionStream.emit({
                type: "session:summary",
                timestamp: new Date().toISOString(),
                summary: aiSummary.summary,
                keyDetails: aiSummary.keyDetails,
              });
            }
            const summaryV2: SessionSummaryV2 = {
              sessionId,
              workspaceId: this.workspace.id,
              jobName: job.name,
              task: typeof signal.data?.task === "string" ? signal.data.task : job.name,
              status: view.status,
              startedAt: session.startedAt.toISOString(),
              completedAt: (session.completedAt ?? new Date()).toISOString(),
              durationMs,
              stepCount: executedBlocks.length,
              agentNames: executedBlocks.map((b) => b.agentName),
              error: session.error?.message,
              aiSummary,
            };

            await sessionStream.finalize(summaryV2).catch((err) => {
              logger.warn("Failed to finalize session stream", { sessionId, error: String(err) });
            });

            // Side-effect hook for the daemon to broadcast the final output
            // across chat communicators. Errors are isolated — a failed
            // broadcast must not affect session status.
            if (this.options.onSessionComplete) {
              // Prefer the AgentResult / *-result FSM document over agentBlock
              // output. The chat-handler job stores its reply in a `chat-result`
              // document (`{ type: "AgentResult", data: { text } }`) while the
              // raw agentBlock.output is a structured wrapper that stringifies
              // to "[object Object]". Doc lookup matches the same precedence
              // the session-finish event uses (line 2751).
              const resultDoc = engine.documents.find(
                (doc) => doc.type === "AgentResult" || doc.id.endsWith("-result"),
              );
              const finalOutput =
                extractTextFromAgentOutput(resultDoc?.data) ??
                extractTextFromAgentOutput(
                  [...executedBlocks].reverse().find((b) => b.output)?.output,
                );
              const inboundStreamId =
                typeof signal.data?.streamId === "string" ? signal.data.streamId : undefined;
              try {
                await this.options.onSessionComplete({
                  workspaceId: this.workspace.id,
                  sessionId,
                  streamId: inboundStreamId,
                  status: view.status,
                  finalOutput,
                  jobName: job.name,
                });
              } catch (hookError) {
                logger.warn("onSessionComplete hook failed", {
                  sessionId,
                  error: hookError instanceof Error ? hookError.message : String(hookError),
                });
              }
            }

            // (activity subsystem deleted 2026-05-02 — terminal-session
            // titles previously got recorded here. SESSIONS JetStream
            // stream is the source of truth for session lifecycle.)
          }

          session.engineDocuments = engine.documents;
          session.finalState = engine.state;
          this.agentResultSideChannel.delete(sessionId);
          this.activeAbortControllers.delete(sessionId);
          this.sessionEngines.delete(sessionId);
        }

        if (otelSpan) {
          otelSpan.setAttribute("atlas.session.status", session.status);
        }
        return session;
      }, // end withOtelSpan fn
    ); // end withOtelSpan
  }

  /**
   * Track session result, persist to history, emit completion, and clean up.
   * Shared finalization path for processSignal.
   */
  private async finalizeSession(
    sessionResult: SessionResult,
    job: FSMJob,
    signal: WorkspaceRuntimeSignal,
  ): Promise<IWorkspaceSession> {
    this.sessionResults.set(sessionResult.id, sessionResult);

    const workspaceSession = this.toWorkspaceSession(sessionResult);

    const activeSession: ActiveSession = {
      id: sessionResult.id,
      jobName: job.name,
      signalId: signal.id,
      session: workspaceSession,
      startedAt: new Date(),
      waitForCompletion: () => workspaceSession.waitForCompletion(),
    };
    this.sessions.set(sessionResult.id, activeSession);

    if (sessionResult.status !== WorkspaceSessionStatus.ACTIVE) {
      await this.persistSessionToHistory(sessionResult, job, signal);
    }

    if (sessionResult.status !== WorkspaceSessionStatus.ACTIVE) {
      this.sessionCompletionEmitter.emit(`session:${sessionResult.id}`, sessionResult);
    }

    // Call onSessionFinished callback and cleanup
    await this.handleSessionCompletion(sessionResult);

    return activeSession.session;
  }

  private async loadStandingOrders(): Promise<string> {
    const adapter = this.options.memoryAdapter;
    if (!adapter) return "";

    const STANDING_ORDERS_NAME = "standing-orders";
    const parts: string[] = [];

    try {
      const globalMemory = await adapter.store(GLOBAL_WORKSPACE_ID, STANDING_ORDERS_NAME);
      parts.push(await globalMemory.render());
    } catch {
      // Global level missing or unreadable — skip silently
    }

    try {
      const wsMemory = await adapter.store(this.workspace.id, STANDING_ORDERS_NAME);
      parts.push(await wsMemory.render());
    } catch {
      // Workspace level missing or unreadable — skip silently
    }

    for (const mount of this._resolvedMemory?.mounts ?? []) {
      if (mount.sourceStoreName === STANDING_ORDERS_NAME && mount.sourceStoreKind === "narrative") {
        try {
          const mountedMemory = await adapter.store(mount.sourceWorkspaceId, mount.sourceStoreName);
          parts.push(await mountedMemory.render());
        } catch {
          // Mounted level missing or unreadable — skip silently
        }
      }
    }

    return parts.filter(Boolean).join("\n\n");
  }

  /** Agent executor callback — bridges FSMEngine to AgentOrchestrator. */
  private async executeAgent(
    action: AgentAction,
    fsmContext: Context,
    job: FSMJob,
    signal: SignalWithContext,
    options?: { outputSchema?: Record<string, unknown> },
  ): Promise<AgentResult> {
    const agentId = action.agentId;

    logger.debug("Executing agent via orchestrator", {
      agentId,
      documentCount: fsmContext.documents.length,
      state: fsmContext.state,
      jobName: job.name,
      hasSignalContext: !!signal._context,
      hasActionPrompt: !!action.prompt,
    });

    const agentConfig = this.config.workspace.agents?.[agentId];

    const agentConfigPrompt = extractAgentConfigPrompt(agentConfig);
    const agentCustomConfig = extractAgentConfig(agentConfig);

    const context = await buildAgentPrompt(
      agentId,
      fsmContext,
      signal, // Use actual signal instead of synthetic one
      signal._context?.abortSignal,
      this.workspace.id,
      ArtifactStorage,
    );

    const prompt = buildFinalAgentPrompt(action.prompt, agentConfigPrompt, context);

    let standingOrdersBlock = "";
    if (process.env.FRIDAY_STANDING_ORDERS_BOOTSTRAP === "1" && this.options.memoryAdapter) {
      try {
        standingOrdersBlock = await this.loadStandingOrders();
      } catch (err) {
        logger.warn("Standing orders bootstrap failed, continuing without it", {
          agentId,
          workspaceId: this.workspace.id,
          error: stringifyError(err),
        });
      }
    }

    // Bootstrap memory injection (feature-flagged)
    let bootstrapBlock = "";
    if (process.env.FRIDAY_MEMORY_BOOTSTRAP === "1" && this.options.memoryAdapter) {
      try {
        bootstrapBlock = await this.options.memoryAdapter.bootstrap(this.workspace.id, agentId);
      } catch (err) {
        logger.warn("Memory bootstrap failed, continuing without it", {
          agentId,
          workspaceId: this.workspace.id,
          error: stringifyError(err),
        });
      }
    }

    const finalPrompt = [standingOrdersBlock, bootstrapBlock, prompt].filter(Boolean).join("\n\n");

    // Use streamId from signal data (e.g. chatId for conversations), fall back to sessionId
    const streamId =
      typeof signal.data?.streamId === "string" ? signal.data.streamId : signal._context?.sessionId;

    const datetime = signal.data?.datetime as
      | {
          timezone: string;
          timestamp: string;
          localDate: string;
          localTime: string;
          timezoneOffset: string;
          latitude?: string;
          longitude?: string;
        }
      | undefined;

    const rawFgIds = signal.data?.foregroundWorkspaceIds;
    const foregroundWorkspaceIds = Array.isArray(rawFgIds)
      ? rawFgIds.filter((id): id is string => typeof id === "string")
      : undefined;

    const sessionId = signal._context?.sessionId;
    if (!sessionId) {
      throw new Error(
        `Missing sessionId in signal context for agent '${agentId}' — ` +
          `caller of engine.signal() must provide context with sessionId`,
      );
    }

    const workspaceId = signal._context?.workspaceId;
    if (!workspaceId) {
      throw new Error(
        `Missing workspaceId in signal context for agent '${agentId}' — ` +
          `caller of engine.signal() must provide context with workspaceId`,
      );
    }

    const runtimeAgentId = resolveRuntimeAgentId(agentConfig, agentId);

    // Map config types to validateAgentOutput's expected parameter.
    // "atlas" and "user" agents map to "sdk"; default to "sdk" for unconfigured agents.
    const agentType: "llm" | "system" | "sdk" =
      agentConfig?.type === "llm" ? "llm" : agentConfig?.type === "system" ? "system" : "sdk";

    // Merge workspace agent config with prepare function's config.
    // Prepare config (from FSM `return { task, config }`) takes precedence
    // so workspace.yml prepare functions can pass data like workDir to agents.
    const prepareConfig = fsmContext.input?.config;
    const mergedConfig = prepareConfig
      ? { ...agentCustomConfig, ...prepareConfig }
      : agentCustomConfig;

    // Resolve memory mounts scoped to this agent
    const agentMounts = this.getMountsForAgent(agentId, job.name);
    const mountNames = Object.keys(agentMounts);
    const ctxKey = mountContextKey(sessionId, agentId);
    if (mountNames.length > 0) {
      logger.debug("Resolved mounts for agent", {
        agentId,
        jobName: job.name,
        mountCount: mountNames.length,
        mountNames,
      });
      const memoryContext: AgentMemoryContext = {
        mounts: agentMounts,
        adapter: this.options.memoryAdapter,
      };
      setMountContext(ctxKey, memoryContext);
    }

    // Execute agent via orchestrator or CodeAgentExecutor
    const result = await withOtelSpan(
      "agent.execute",
      {
        "atlas.agent.id": agentId,
        "atlas.agent.type": agentConfig?.type ?? "sdk",
        "atlas.workspace.id": workspaceId,
        "atlas.session.id": sessionId,
      },
      async (agentOtelSpan) => {
        // User agents bypass the MCP orchestrator — execute via ProcessAgentExecutor (NATS)
        const agentResult =
          agentConfig?.type === "user"
            ? await this.executeCodeAgent(agentConfig.agent, finalPrompt, {
                sessionId,
                workspaceId,
                streamId,
                onStreamEvent: signal._context?.onStreamEvent,
                config: mergedConfig,
                outputSchema: options?.outputSchema,
                datetime,
                agentEnv: agentConfig.env,
                foregroundWorkspaceIds,
                abortSignal: signal._context?.abortSignal,
              })
            : await this.orchestrator.executeAgent(runtimeAgentId, finalPrompt, {
                sessionId,
                workspaceId,
                streamId,
                datetime,
                memoryContextKey: mountNames.length > 0 ? ctxKey : undefined,
                foregroundWorkspaceIds,
                jobName: job.name,
                // Agent UIMessageChunks flow through the dedicated onStreamEvent channel,
                // keeping the FSM onEvent callback clean (FSMEvent types only)
                onStreamEvent: signal._context?.onStreamEvent,
                additionalContext: { documents: fsmContext.documents },
                config: mergedConfig,
                outputSchema: options?.outputSchema,
                // Propagate session cancellation to the agent MCP transport —
                // the orchestrator already listens for this on line ~296 and
                // sends `notifications/cancelled` to the agents server, so
                // DELETE /api/sessions/:id actually stops in-flight LLM work
                // instead of just detaching the client.
                abortSignal: signal._context?.abortSignal,
              });

        if (agentOtelSpan) {
          agentOtelSpan.setAttribute("atlas.agent.result.ok", agentResult.ok);
        }

        // Validate agent output (hallucination detection only runs for LLM agents)
        await validateAgentOutput(agentResult, fsmContext, agentType, this.options.platformModels);

        return agentResult;
      },
    );

    // Ensure mount context cleanup if it wasn't consumed by buildAgentContext
    takeMountContext(ctxKey);

    logger.debug("Agent execution completed", { agentId, ok: result.ok });

    const sideChannelSessionId = signal._context?.sessionId;
    if (sideChannelSessionId) {
      const sideChannel = this.agentResultSideChannel.get(sideChannelSessionId);
      if (sideChannel) {
        const key = `${job.name}/${action.agentId}/${fsmContext.state}`;
        const resultsByCallId = new Map(
          (result.ok ? result.toolResults : undefined)?.map((tr) => [tr.toolCallId, tr.output]) ??
            [],
        );
        const toolCalls =
          (result.ok ? result.toolCalls : undefined)?.map((tc) => ({
            toolName: tc.toolName,
            args: tc.input,
            ...(resultsByCallId.has(tc.toolCallId) && {
              result: resultsByCallId.get(tc.toolCallId),
            }),
          })) ?? [];
        // Structured output = args from the "complete" tool call (the actual result
        // stored in context.results). Falls back to result.data (LLM text) when no
        // complete tool call exists.
        const completeCall = toolCalls.find((tc) => tc.toolName === "complete");
        const agentResultData: AgentResultData = {
          toolCalls,
          reasoning: result.ok ? result.reasoning : undefined,
          output: completeCall?.args ?? (result.ok ? result.data : undefined),
          artifactRefs: result.ok ? result.artifactRefs : undefined,
        };
        sideChannel.set(key, agentResultData);
      }
    }

    return result;
  }

  /**
   * Execute a user agent via ProcessAgentExecutor (NATS subprocess protocol).
   * Creates ephemeral MCP connections for tool access, resolves the agent's
   * source location from UserAdapter, and dispatches to the NATS subprocess.
   */
  private async executeCodeAgent(
    userAgentId: string,
    prompt: string,
    opts: {
      sessionId: string;
      workspaceId: string;
      streamId?: string;
      onStreamEvent?: (event: AtlasUIMessageChunk) => void;
      config?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      datetime?: unknown;
      agentEnv?: Record<string, string | LinkCredentialRef>;
      foregroundWorkspaceIds?: string[];
      abortSignal?: AbortSignal;
    },
  ): Promise<AgentResult> {
    // Resolve agent source location from disk
    const agentSource = await this.userAdapter.loadAgent(userAgentId);
    const sourceLocation = path.join(
      agentSource.metadata.sourceLocation,
      agentSource.metadata.entrypoint ?? "agent.py",
    );

    // Resolve workspace skills when the agent opts in
    let resolvedSkills: AgentSkill[] | undefined;
    let skillsTempDir: string | undefined;

    if (agentSource.metadata.useWorkspaceSkills && this.config.workspace.skills) {
      const skillEntries = this.config.workspace.skills;
      const inlineSkills = skillEntries.filter((e): e is InlineSkillConfig => "inline" in e);
      const globalRefs = skillEntries.filter((e): e is GlobalSkillRefConfig => !("inline" in e));

      const allResolved: AgentSkill[] = inlineSkills.map((s) => ({
        name: s.name,
        description: s.description,
        instructions: s.instructions,
      }));

      if (globalRefs.length > 0) {
        const fetchResults = await Promise.allSettled(
          globalRefs.map(async (ref) => {
            const { namespace, name } = parseSkillRef(ref.name);
            const result = await SkillStorage.get(namespace, name, ref.version);
            if (!result.ok) {
              logger.warn("Failed to resolve global skill for code agent", {
                skill: ref.name,
                error: result.error,
              });
              return null;
            }
            if (!result.data) {
              logger.warn("Global skill not found for code agent", {
                skill: ref.name,
                version: ref.version,
              });
              return null;
            }
            const skill = result.data;

            let referenceFiles: Record<string, string> | undefined;
            if (skill.archive) {
              try {
                referenceFiles = await extractArchiveContents(new Uint8Array(skill.archive));
              } catch (e) {
                logger.warn("Failed to extract skill archive", {
                  skill: ref.name,
                  error: stringifyError(e),
                });
              }
            }

            const archiveFileList = referenceFiles ? Object.keys(referenceFiles) : [];
            const deadLinks = validateSkillReferences(skill.instructions, archiveFileList);
            if (deadLinks.length > 0) {
              logger.warn("Skill has dead file references", { skill: ref.name, deadLinks });
            }

            return {
              name: skill.name ?? name,
              description: skill.description,
              instructions: skill.instructions,
              referenceFiles,
            };
          }),
        );
        for (const fetchResult of fetchResults) {
          if (fetchResult.status === "fulfilled" && fetchResult.value) {
            allResolved.push(fetchResult.value);
          }
        }
      }

      if (allResolved.length > 0) {
        resolvedSkills = allResolved;

        // Write skills to existing workDir (FSM clone path) or create a temp dir.
        // FSM pipelines set config.workDir to the cloned repo — skills must coexist there
        // so the claude-code provider discovers them at {cwd}/.claude/skills/.
        const existingWorkDir =
          opts.config && typeof opts.config === "object"
            ? (opts.config as Record<string, unknown>).workDir
            : undefined;
        const skillsBaseDir =
          typeof existingWorkDir === "string"
            ? existingWorkDir
            : await mkdtemp(path.join(tmpdir(), "atlas-skills-"));
        if (typeof existingWorkDir !== "string") {
          skillsTempDir = skillsBaseDir; // Only track for cleanup if we created it
        }

        for (const skill of allResolved) {
          const skillDirPath = path.join(skillsBaseDir, ".claude", "skills", skill.name);
          await mkdir(skillDirPath, { recursive: true });

          if (skill.referenceFiles) {
            for (const [relPath, content] of Object.entries(skill.referenceFiles)) {
              const filePath = path.resolve(skillDirPath, relPath);
              if (!filePath.startsWith(`${skillDirPath}/`)) continue;
              await mkdir(path.dirname(filePath), { recursive: true });
              await writeFile(filePath, content);
            }
          }

          const resolvedInstructions = skill.instructions.replaceAll("$SKILL_DIR/", "");
          const safeDescription = JSON.stringify(skill.description);
          await writeFile(
            path.join(skillDirPath, "SKILL.md"),
            `---\nname: ${skill.name}\ndescription: ${safeDescription}\nuser-invocable: false\n---\n\n${resolvedInstructions}`,
          );
        }
        logger.info("Materialized workspace skills for code agent", {
          agentId: userAgentId,
          count: allResolved.length,
          names: allResolved.map((s) => s.name),
          baseDir: skillsBaseDir,
          ownedDir: skillsTempDir !== undefined,
        });
      }
    }

    // Create ephemeral MCP connections for platform tools + workspace tools
    const mcpConfigs: Record<string, MCPServerConfig> = {
      "atlas-platform": getAtlasPlatformServerConfig(),
    };
    const workspaceMcpServers = this.config.workspace.tools?.mcp?.servers;
    if (workspaceMcpServers) {
      for (const [id, config] of Object.entries(workspaceMcpServers)) {
        if (id !== "atlas-platform") {
          const registryEntry = mcpServersRegistry.servers[id];
          mcpConfigs[id] = registryEntry?.platformEnv
            ? applyPlatformEnv(config, registryEntry.platformEnv)
            : config;
        }
      }
    }

    // Agent-declared MCP servers take precedence over workspace configs
    if (agentSource.metadata.mcp) {
      for (const [id, config] of Object.entries(agentSource.metadata.mcp)) {
        const registryEntry = mcpServersRegistry.servers[id];
        mcpConfigs[id] = registryEntry?.platformEnv
          ? applyPlatformEnv(config, registryEntry.platformEnv)
          : config;
      }
    }

    const { tools: rawMcpTools, dispose } = await createMCPTools(mcpConfigs, logger);

    // Filter platform tools to LLM_AGENT_ALLOWED — same surface workspace LLM
    // agents see (memory, artifacts, state, fs, csv, bash, webfetch,
    // workspace_signal_trigger, convert_task_to_workspace). Workspace-management
    // tools (workspace_delete, session_describe, etc.) stay blocked.
    // External MCP server tools pass through unfiltered.
    const filteredTools: typeof rawMcpTools = {};
    for (const [name, tool] of Object.entries(rawMcpTools)) {
      if (!PLATFORM_TOOL_NAMES.has(name) || LLM_AGENT_ALLOWED_PLATFORM_TOOLS.has(name)) {
        filteredTools[name] = tool;
      }
    }
    // Wrap allowlisted scope-injected tools (memory/artifacts/state/webfetch)
    // so workspaceId/workspaceName flow from the runtime scope. Tools that
    // aren't in SCOPE_INJECTED_PLATFORM_TOOLS pass through untouched (e.g.
    // csv, fs_*, bash from atlas-platform).
    const mcpTools = wrapPlatformToolsWithScope(filteredTools, {
      workspaceId: opts.workspaceId,
      workspaceName: this.workspace.name,
    });

    // Inject built-in bash tool so code agents can shell out (overrides
    // atlas-platform's bash entry — local bash has different privilege scope).
    mcpTools.bash = createBashTool();

    // Inject workDir for claude-code agents that discover skills from disk
    let agentConfig = opts.config;
    if (resolvedSkills && skillsTempDir) {
      const existingWorkDir =
        agentConfig && typeof agentConfig === "object"
          ? (agentConfig as Record<string, unknown>).workDir
          : undefined;
      if (!existingWorkDir) {
        agentConfig = { ...agentConfig, workDir: skillsTempDir };
      }
    }

    const executor = this.options.agentExecutor;
    if (!executor) {
      throw new Error("No agentExecutor configured — ProcessAgentExecutor required");
    }
    try {
      return await executor.execute(sourceLocation, prompt, {
        env: opts.agentEnv
          ? await resolveEnvValues(opts.agentEnv, logger)
          : Object.fromEntries(
              Object.entries(process.env).filter(
                (e): e is [string, string] => typeof e[1] === "string",
              ),
            ),
        logger: logger.child({ component: "CodeAgent", agentId: userAgentId }),
        streamEmitter: opts.onStreamEvent
          ? {
              emit: (event) =>
                opts.onStreamEvent?.({ type: event.type, data: event.data } as AtlasUIMessageChunk),
            }
          : undefined,
        mcpToolCall: async (name, args) => {
          const tool = mcpTools[name];
          if (!tool?.execute) throw new Error(`Unknown tool: ${name}`);
          return await tool.execute(args, { toolCallId: crypto.randomUUID(), messages: [] });
        },
        mcpListTools: () =>
          Promise.resolve(
            Object.entries(mcpTools).map(([name, tool]) => ({
              name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema,
            })),
          ),
        sessionContext: {
          id: opts.sessionId,
          workspaceId: opts.workspaceId,
          datetime: opts.datetime,
        },
        agentConfig,
        agentLlmConfig: agentSource.metadata.llm,
        outputSchema: opts.outputSchema,
        skills: resolvedSkills?.map((s) => ({
          name: s.name,
          description: s.description,
          instructions: s.instructions,
        })),
        abortSignal: opts.abortSignal,
      });
    } finally {
      await dispose();
      if (skillsTempDir) {
        await rm(skillsTempDir, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  private extractArtifacts(
    documents: { id: string; type: string; data: Record<string, unknown> }[],
  ): IWorkspaceArtifact[] {
    const artifactTypes = [
      "workspace-plan",
      "analysis-result",
      "review-result",
      "report",
      "summary",
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

  private createSessionSummary(sessionResult: SessionResult): SessionSummary {
    const duration = sessionResult.completedAt
      ? sessionResult.completedAt.getTime() - sessionResult.startedAt.getTime()
      : 0;

    const stateTransitions =
      sessionResult.engineDocuments?.filter(
        (doc) => doc.type === "state-transition" || doc.type === "fsm-state",
      ) || [];

    const totalPhases = stateTransitions.length || 1;
    const completedPhases =
      sessionResult.status === WorkspaceSessionStatus.COMPLETED
        ? totalPhases
        : Math.max(0, totalPhases - 1);

    return {
      sessionId: sessionResult.id,
      workspaceId: sessionResult.workspaceId,
      status: sessionResult.status,
      totalPhases,
      completedPhases,
      duration,
      reasoning: sessionResult.error
        ? `Failed: ${sessionResult.error.message}`
        : "Completed successfully",
    };
  }

  private toWorkspaceSession(session: SessionResult): IWorkspaceSession {
    return {
      id: session.id,
      workspaceId: session.workspaceId,
      status: session.status,
      error: session.error?.message,
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
        if (session.status === WorkspaceSessionStatus.COMPLETED) return 100;
        if (session.status === WorkspaceSessionStatus.FAILED) return 0;
        return 50; // Active sessions are 50% by default
      },
      summarize: () => `Session ${session.id}: ${session.status}`,
      getArtifacts: () => session.artifacts,
      waitForCompletion: (): Promise<SessionSummary> => {
        // If already completed, return immediately
        const currentResult = this.sessionResults.get(session.id);
        if (currentResult && currentResult.status !== WorkspaceSessionStatus.ACTIVE) {
          return Promise.resolve(this.createSessionSummary(currentResult));
        }

        // Otherwise, wait for completion event
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error(`Session ${session.id} timed out after 15 minutes`));
          }, 900000); // 15 minute timeout

          this.sessionCompletionEmitter.once(`session:${session.id}`, (result: SessionResult) => {
            clearTimeout(timeout);
            resolve(this.createSessionSummary(result));
          });
        });
      },
      // IAtlasScope methods (minimal implementation)
      supervisor: undefined,
      context: createStubContextManager(),
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

  async triggerSignal(signalName: string, payload?: Record<string, unknown>): Promise<void> {
    const signal: WorkspaceRuntimeSignal = {
      id: signalName,
      type: signalName,
      data: payload || {},
      timestamp: new Date(),
    };

    await this.processSignal(signal);
  }

  async triggerSignalWithSession(
    signalName: string,
    payload?: Record<string, unknown>,
    streamId?: string,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    skipStates?: string[],
    abortSignal?: AbortSignal,
  ): Promise<IWorkspaceSession> {
    // Top-level `streamId` arg wins over any payload.streamId. The runtime
    // reads the merged value via `signal.data.streamId` (see processSignalForJob
    // ~line 1595 where streamId is derived). Both surfaces stay supported so
    // existing callers (chat-SDK, job-tools forwarding) keep working.
    const data: Record<string, unknown> = payload ? { ...payload } : {};
    if (streamId !== undefined) {
      data.streamId = streamId;
    }
    const signal: WorkspaceRuntimeSignal = {
      id: signalName,
      type: signalName,
      data,
      timestamp: new Date(),
    };

    return await this.processSignal(signal, onStreamEvent, abortSignal, skipStates);
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down workspace runtime", { workspaceId: this.workspace.id });

    // Engines are per-signal — running ones receive the abort via
    // activeAbortControllers; the engines themselves get GC'd when their
    // signal completes. Nothing to stop here at the job level.
    for (const controller of this.activeAbortControllers.values()) {
      controller.abort("workspace runtime shutting down");
    }

    await this.orchestrator.shutdown();

    this.sessions.clear();
    this.sessionResults.clear();
    this.completedSessionDocuments.clear();
    this.activeAbortControllers.clear();
    this.jobs.clear();
    this.mountBindings.clear();
    mountRegistry.clear();
    this.initialized = false;
  }

  /**
   * List all jobs (FSM definitions) in this workspace.
   * Falls back to config when runtime hasn't been initialized yet (lazy mode).
   */
  listJobs(): Array<{
    name: string;
    description?: string;
    signals?: string[];
    fsmDefinition?: unknown;
  }> {
    if (this.jobs.size > 0) {
      return Array.from(this.jobs.values()).map((job) => ({
        name: job.name,
        description: job.description ?? `FSM workflow at ${job.fsmPath}`,
        signals: job.signals,
        fsmDefinition: job.fsmDefinition,
      }));
    }

    // Before initialization, read directly from config
    const configJobs = this.config.workspace?.jobs || {};
    return Object.entries(configJobs).map(([name, job]) => ({
      name,
      description: job.description,
    }));
  }

  getSessions(): ActiveSession[] {
    return Array.from(this.sessions.values());
  }

  listSessions(): Array<{ id: string; jobName: string; status: string; startedAt: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      jobName: s.jobName,
      status: s.session.status,
      startedAt: s.startedAt.toISOString(),
    }));
  }

  getSession(sessionId: string): IWorkspaceSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  /**
   * Return the FSM engine's final documents for a session, filtered to the
   * ones a caller is likely to care about: agent / LLM action `outputTo`
   * results and document-typed docs declared in the workspace. Excludes
   * FSM bookkeeping documents (state transitions, chat-context, etc).
   *
   * Exists so synchronous callers of `triggerWorkspaceSignal` (notably the
   * workspace-chat job tool) can surface the actual agent output to whoever
   * invoked the job. Without this, the job tool returns `{success, sessionId,
   * status}` and the agent output evaporates between the FSM and the caller.
   */
  getSessionFsmDocuments(
    sessionId: string,
  ): Array<{ id: string; type: string; data: Record<string, unknown> }> {
    // Post-completion: `handleSessionCompletion` has already cleared the
    // live `sessions` map and snapshotted the docs here. The synchronous
    // signal endpoint hits this path.
    const cached = this.completedSessionDocuments.get(sessionId);
    if (cached) return cached;

    // Pre-completion: still live — read from the per-signal engine.
    const engine = this.sessionEngines.get(sessionId);
    if (!engine) return [];

    // FSM plumbing documents that are noise for most callers. Everything
    // else is passed through — the caller's job to pick fields it cares
    // about. Keeps this method useful for multiple consumers.
    const plumbingTypes = new Set([
      "state-transition",
      "fsm-state",
      "ChatContext",
      "signal-payload",
    ]);
    return engine.documents.filter((d) => !plumbingTypes.has(d.type));
  }

  /**
   * Abort an in-flight session. Throws when the session isn't active (already
   * finished, or never existed). The abort propagates through the FSM engine's
   * abortSignal to running agent calls, and the resulting AbortError is
   * classified as "cancelled" by classifySessionError so history records a
   * user cancellation rather than a platform failure.
   */
  cancelSession(sessionId: string): void {
    const controller = this.activeAbortControllers.get(sessionId);
    if (!controller) {
      throw new Error(`Session ${sessionId} is not active (already finished or unknown)`);
    }

    // Use a named AbortError so classifySessionError routes this to CANCELLED.
    const reason = new Error("Session cancelled by user");
    reason.name = "AbortError";
    controller.abort(reason);

    logger.info("Session cancel requested", { sessionId, workspaceId: this.workspace.id });
  }

  /**
   * Whether the given session has an in-flight execution (i.e., can be cancelled).
   * The `sessions` map only holds *finalized* sessions, so callers routing a
   * DELETE to the right workspace should use this to find the active one.
   */
  hasActiveSession(sessionId: string): boolean {
    return this.activeAbortControllers.has(sessionId);
  }

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

  private async handleSessionCompletion(sessionResult: SessionResult): Promise<void> {
    const { status, userId } = sessionResult;
    if (status === WorkspaceSessionStatus.ACTIVE) return;

    logger.debug("handleSessionCompletion", {
      sessionId: sessionResult.id,
      status,
      userId: userId ?? "NOT_SET",
    });

    // Snapshot the job's FSM documents BEFORE `onSessionFinished` fires.
    // That callback (atlas-daemon's `destroyWorkspaceRuntime`) calls
    // `runtime.shutdown()`, which stops every job's engine and drops its
    // documents — after that, there is nothing to snapshot. And the live
    // `sessions` map is cleared a few lines down, so the signal endpoint's
    // subsequent `getSessionFsmDocuments(sessionId)` call would return `[]`
    // without this cache. Net effect of the bug: retrieval jobs run, save
    // their result doc, then the HTTP response is `output: []`.
    const active = this.sessions.get(sessionResult.id);
    if (active) {
      const plumbingTypes = new Set([
        "state-transition",
        "fsm-state",
        "ChatContext",
        "signal-payload",
      ]);
      const docs = (sessionResult.engineDocuments ?? []).filter((d) => !plumbingTypes.has(d.type));
      this.completedSessionDocuments.set(sessionResult.id, docs);
      // Bound the map so a long-running workspace doesn't accumulate doc
      // snapshots forever. FIFO eviction at 100 entries — well above the
      // synchronous HTTP-cascade window we care about, well below "leak".
      const COMPLETED_DOCS_CAP = 100;
      while (this.completedSessionDocuments.size > COMPLETED_DOCS_CAP) {
        const oldest = this.completedSessionDocuments.keys().next().value;
        if (oldest === undefined) break;
        this.completedSessionDocuments.delete(oldest);
      }
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

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  getConfig(): MergedConfig {
    return this.config;
  }

  getWorkspace(): WorkspaceRuntimeInit {
    return this.workspace;
  }

  getAgentOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
  }

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

  private async generateAndStoreTitle(
    sessionId: string,
    input: Omit<GenerateSessionTitleInput, "platformModels">,
  ): Promise<void> {
    const platformModels = this.options.platformModels;
    if (!platformModels) {
      logger.debug("Skipping session title generation: platformModels not configured", {
        sessionId,
      });
      return;
    }
    const title = await generateSessionTitle({ ...input, platformModels });
    const result = await SessionHistoryStorage.updateSessionTitle(sessionId, title);
    if (!result.ok) {
      logger.warn("Failed to store session title", { sessionId, error: result.error });
    }
  }

  private async persistSessionToHistory(
    sessionResult: SessionResult,
    job: FSMJob,
    signal: WorkspaceRuntimeSignal,
  ): Promise<void> {
    try {
      const historySignal = {
        id: signal.id,
        provider: {
          id: signal.provider?.id || signal.id,
          name: signal.provider?.name || signal.id,
        },
        workspaceId: this.workspace.id,
      };

      const availableAgents = this.listAgents().map((a) => a.id);

      const historyStatus =
        sessionResult.status === WorkspaceSessionStatus.COMPLETED
          ? ReasoningResultStatus.COMPLETED
          : ReasoningResultStatus.FAILED;

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
        summary: `${job.name}: ${sessionResult.status}`,
        jobDescription: job.description,
      });

      if (!createResult.ok) {
        logger.error("Failed to create session record", {
          error: createResult.error,
          sessionId: sessionResult.id,
        });
        return;
      }

      // Title generation is fire-and-forget — it doesn't need to be ready before the
      // HTTP response returns, and awaiting it adds ~300ms LLM latency to every session.
      const { status } = sessionResult;
      if (status !== WorkspaceSessionStatus.ACTIVE) {
        this.generateAndStoreTitle(sessionResult.id, {
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

      // For inline FSMs the id is the job name; we use that uniformly here
      // since per-signal engines don't expose a stable global identity.
      const fsmId = job.name;
      await SessionHistoryStorage.appendSessionEvent({
        sessionId: sessionResult.id,
        emittedBy: "workspace-runtime",
        event: {
          type: "session-start",
          context: { metadata: { jobName: job.name, fsmId } },
          data: { status: historyStatus, message: `Started FSM job: ${job.name}` },
        },
      });

      // Persist FSM events: use captured events if available, fallback to document conversion
      if (sessionResult.collectedFsmEvents && sessionResult.collectedFsmEvents.length > 0) {
        const sortedEvents = [...sessionResult.collectedFsmEvents].sort(
          (a, b) => a.data.timestamp - b.data.timestamp,
        );

        let successCount = 0;
        let failureCount = 0;

        for (const fsmEvent of sortedEvents) {
          try {
            const mappedEvent = mapFsmEventToSessionEvent(fsmEvent);
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
      // DUAL-WRITE: output is written to both the session-finish event (appendSessionEvent)
      // and the session metadata (markSessionComplete). These are independent file writes,
      // so if one fails mid-persist the two sources can diverge. Readers should prefer
      // the session-finish event as the authoritative source; metadata is a convenience copy.
      const output = sessionResult.engineDocuments
        ?.filter((doc) => doc.type === "result" || doc.id.endsWith("_result"))
        .map((doc) => ({ id: doc.id, data: doc.data }));

      const durationMs =
        sessionResult.completedAt && sessionResult.startedAt
          ? sessionResult.completedAt.getTime() - sessionResult.startedAt.getTime()
          : 0;

      await SessionHistoryStorage.appendSessionEvent({
        sessionId: sessionResult.id,
        emittedBy: "workspace-runtime",
        event: {
          type: "session-finish",
          context: { metadata: { finalState: sessionResult.finalState } },
          data: {
            status: historyStatus,
            durationMs,
            failureReason: sessionResult.error?.message,
            summary: `FSM execution ${sessionResult.status}`,
            output,
          },
        },
      });

      await SessionHistoryStorage.markSessionComplete(
        sessionResult.id,
        historyStatus,
        (sessionResult.completedAt || new Date()).toISOString(),
        {
          durationMs,
          failureReason: sessionResult.error?.message,
          summary: `${job.name}: ${sessionResult.status}`,
          output,
        },
      );

      logger.info("Session persisted to history", {
        sessionId: sessionResult.id,
        workspaceId: this.workspace.id,
        jobName: job.name,
      });
    } catch (error) {
      logger.error("Failed to persist session to history", {
        error: stringifyError(error),
        // Stack trace pinpoints the exact source of synchronous throws
        // inside this try (e.g. YAML serialization, schema parse) — without
        // it the caller only sees the message and can't tell which step
        // failed. Bug atlas-yset surfaced as "Cannot stringify undefined"
        // with no stack, leaving the actual call site invisible.
        stack: error instanceof Error ? error.stack : undefined,
        sessionId: sessionResult.id,
        workspaceId: this.workspace.id,
      });
    }
  }
}
