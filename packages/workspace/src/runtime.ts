/** Multi-FSM coordinator: manages jobs and sessions within a workspace. */

import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import process from "node:process";
import type { ActivityStorageAdapter } from "@atlas/activity";
import { generateSessionActivityTitle } from "@atlas/activity/title-generator";
import { kebabToSentenceCase } from "@atlas/activity/titles";
import {
  type AgentMemoryContext,
  type AgentResult,
  type AgentSkill,
  type AtlasUIMessageChunk,
  buildResolvedWorkspaceMemory,
  type CorpusMountBinding,
  GLOBAL_WORKSPACE_ID,
  type LinkCredentialRef,
  type MCPServerConfig,
  type MemoryAdapter,
  type NarrativeCorpus,
  type ResolvedWorkspaceMemory,
} from "@atlas/agent-sdk";
import { createAnalyticsClient, EventNames } from "@atlas/analytics";
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
  mapActionToStepComplete,
  mapActionToStepStart,
  mapFsmEventToSessionEvent,
  mapStateSkippedToStepSkipped,
  ReasoningResultStatus,
  SessionHistoryStorage,
  type SessionStreamEvent,
  type SessionSummary as SessionSummaryV2,
  UserConfigurationError,
  WorkspaceSessionStatus,
  type WorkspaceSessionStatusType,
} from "@atlas/core";
import { UserAdapter } from "@atlas/core/agent-loader";
import { ArtifactStorage } from "@atlas/core/artifacts/storage";
import { resolveEnvValues } from "@atlas/core/mcp-registry/credential-resolver";
import { FileSystemDocumentStore } from "@atlas/document-store";
import {
  type AgentAction,
  type AgentExecutor,
  AtlasLLMProviderAdapter,
  buildWorkspaceMeta,
  type Context,
  createEngine,
  type FSMActionExecutionEvent,
  FSMDefinitionSchema,
  type FSMEngine,
  type FSMEvent,
  type FSMStateSkippedEvent,
  type SignalWithContext,
  validateFSMStructure,
} from "@atlas/fsm-engine";
import { createFSMOutputValidator, SupervisionLevel } from "@atlas/hallucination";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import {
  type GenerateSessionTitleInput,
  generateSessionTitle,
  type PlatformModels,
} from "@atlas/llm";
import { logger } from "@atlas/logger";
import { createMCPTools } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import { publishDirtyDrafts } from "@atlas/resources";
import { extractArchiveContents, SkillStorage, validateSkillReferences } from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import { getAtlasHome } from "@atlas/utils/paths.server";
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
import { createBashTool } from "./bash-tool.ts";
import { CodeAgentExecutor } from "./code-agent-executor.ts";
import type { MemoryMount } from "./config-schema.ts";
import { compileExecutionToFsm, ExecutionCompileError } from "./execution-to-fsm.ts";
import { assertGlobalWriteAllowed, isGlobalWriteAttempt } from "./global-scope-guard.ts";
import {
  type ImproverAgentInput,
  type ImproverAgentResult,
  runImprovementLoop,
} from "./improvement-loop.ts";
import { MountSourceNotFoundError } from "./mount-errors.ts";
import { mountRegistry } from "./mount-registry.ts";
import { MountedCorpusBinding } from "./mounted-corpus-binding.ts";
import { interpolateConfig, resolveWorkspaceVariables } from "./variable-interpolation.ts";

/**
 * Classify an error to determine session status.
 * UserConfigurationError (OAuth not connected, missing env vars) → "skipped"
 * All other errors → "failed"
 *
 * @internal Exported for testing
 */
export function classifySessionError(error: unknown): WorkspaceSessionStatusType {
  if (error instanceof UserConfigurationError) return WorkspaceSessionStatus.SKIPPED;
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
  /** Ledger storage adapter for versioned workspace resources (auto-publish) */
  resourceStorage?: ResourceStorageAdapter;
  /** Blueprint artifact ID — when set, enables the self-improvement loop on failures */
  blueprintArtifactId?: string;
  /** Callback to invoke the workspace-improver agent (injected by daemon) */
  invokeImprover?: (input: ImproverAgentInput) => Promise<ImproverAgentResult>;
  /** Snapshot: whether a pending revision exists at runtime creation time */
  hasPendingRevision?: boolean;
  /** Activity storage adapter for creating activity feed items */
  activityStorage?: ActivityStorageAdapter;
  /** Memory adapter for bootstrap injection (feature-flagged via ATLAS_MEMORY_BOOTSTRAP) */
  memoryAdapter?: MemoryAdapter;
  /** Parsed memory.mounts from workspace config — resolved at initialize time */
  memoryMounts?: MemoryMount[];
  /** Kernel workspace ID — only this workspace may hold rw mounts against _global */
  kernelWorkspaceId?: string;
  /** Platform model resolver — required for session summarization and other platform LLM calls */
  platformModels: PlatformModels;
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
  private improvementLoopFired = false;
  private createdByUserId?: string;

  // Shared resources
  private orchestrator: AgentOrchestrator;
  private codeAgentExecutor = new CodeAgentExecutor();
  private userAdapter = new UserAdapter(path.join(getAtlasHome(), "agents"));

  // Job tracking (each job has its own FSMEngine and DocumentStore)
  private jobs = new Map<string, FSMJob>();

  // Session tracking
  private sessions = new Map<string, ActiveSession>();
  private sessionResults = new Map<string, SessionResult>();
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

  // Agent result side-channel: sessionId → (sideChannelKey → AgentResultData)
  // Populated by executeAgent, consumed by onEvent callback for step:complete events
  private agentResultSideChannel = new Map<string, Map<string, AgentResultData>>();

  // Resolved corpus mount bindings, keyed by mount name
  private mountBindings = new Map<string, MountedCorpusBinding>();

  // Fully-resolved memory surface (own + mounts + global access), built after initialize()
  private _resolvedMemory: ResolvedWorkspaceMemory | undefined;

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
    this.createdByUserId = workspace.members?.userId;

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

    const workspacePath = this.options.workspacePath || `.atlas/workspaces/${this.workspace.id}`;

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
      const chatFSM = {
        id: `${this.workspace.id}-chat`,
        initial: "idle",
        documentTypes: {
          ChatContext: {
            type: "object",
            properties: {
              chatId: { type: "string" },
              userId: { type: "string" },
              streamId: { type: "string" },
            },
            required: ["userId"],
          },
        },
        states: {
          idle: {
            on: {
              chat: {
                target: "processing",
                actions: [{ type: "code", function: "storeChatContext" }],
              },
            },
          },
          processing: {
            entry: [
              { type: "agent", agentId: "workspace-chat", outputTo: "chat-result" },
              { type: "emit", event: "chat_complete" },
            ],
            on: { chat_complete: { target: "idle" } },
          },
        },
        functions: {
          storeChatContext: {
            type: "action",
            code: `export default function storeChatContext(context, event) {
  try {
    context.createDoc({
      id: 'chat-context',
      type: 'ChatContext',
      data: {
        chatId: event.data.chatId,
        userId: event.data.userId,
        streamId: event.data.streamId
      }
    });
  } catch {
    context.updateDoc('chat-context', {
      chatId: event.data.chatId,
      userId: event.data.userId,
      streamId: event.data.streamId
    });
  }
}`,
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

      this.emitJobDefined("handle-chat");

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

      this.emitJobDefined(jobName);

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

      this.emitJobDefined(jobName);

      logger.debug("Registered standalone FSM job", { jobName, fsmPath: fsmFile, signals });
    }

    // Resolve memory mounts — fail loud if any source corpus is missing
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
    // Currently any workspace can mount another workspace's corpus without the
    // source having declared it via memory.shareable.list / allowedWorkspaces.
    // When a getWorkspaceConfig(wsId) callback is available on
    // WorkspaceRuntimeOptions, verify the mounted corpus name is in
    // shareable.list and the consumer is in allowedWorkspaces (or absent = all).
    // If no shareable block exists on the source, allow the mount (backward-compat).
    // See: design memo for memory-three-scope-model task.

    for (const mount of mounts) {
      const sourceId = mount.source;
      const sourceParts = sourceId.split("/");
      const sourceWsId = sourceParts[0];
      const corpusKind = sourceParts[1];
      const memoryName = sourceParts[2];

      if (!sourceWsId || !corpusKind || !memoryName) {
        throw new MountSourceNotFoundError(
          sourceId,
          `Mount '${mount.name}': invalid source format '${mount.source}' — ` +
            `expected '{workspaceId}/{kind}/{memoryName}'`,
        );
      }

      if (corpusKind !== "narrative") {
        throw new MountSourceNotFoundError(
          sourceId,
          `Mount '${mount.name}': only narrative memories are supported for mounts, got '${corpusKind}'`,
        );
      }

      if (isGlobalWriteAttempt(sourceWsId, mount.mode)) {
        assertGlobalWriteAllowed(this.workspace.id, this.options.kernelWorkspaceId);
      }

      mountRegistry.registerSource(sourceId, () =>
        adapter.corpus(sourceWsId, memoryName, "narrative"),
      );
      mountRegistry.addConsumer(sourceId, this.workspace.id);

      let resolvedCorpus: NarrativeCorpus;
      try {
        resolvedCorpus = await adapter.corpus(sourceWsId, memoryName, "narrative");
      } catch {
        throw new MountSourceNotFoundError(
          sourceId,
          `Mount '${mount.name}': source memory '${mount.source}' not found — ` +
            `check memory.mounts[].source in workspace config`,
        );
      }

      const binding = new MountedCorpusBinding({
        name: mount.name,
        source: mount.source,
        mode: mount.mode,
        scope: mount.scope,
        scopeTarget: mount.scopeTarget,
        read: (filter) => resolvedCorpus.read(filter),
        append: (entry) => resolvedCorpus.append(entry),
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

  getMountsForAgent(agentId: string, jobName?: string): Record<string, CorpusMountBinding> {
    const result: Record<string, CorpusMountBinding> = {};
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

  /** Lazy-initialize a job's FSM engine. */
  private async initializeJobEngine(job: FSMJob): Promise<void> {
    if (job.engine) {
      return; // Already initialized
    }

    logger.info("Initializing FSM engine for job", {
      jobName: job.name,
      workspaceId: this.workspace.id,
    });

    const stateStoragePath = path.join(getAtlasHome(), "workspaces");
    job.documentStore = new FileSystemDocumentStore({ basePath: stateStoragePath });

    const agentExecutor: AgentExecutor = (action, context, signal, options) =>
      this.executeAgent(action, context, job, signal, options);

    const mcpServerConfigs = this.config.workspace.tools?.mcp?.servers || {};

    const scope = { workspaceId: this.workspace.id, workspaceName: this.workspace.name };
    const platformModels = this.options.platformModels;
    if (!platformModels) {
      throw new Error(
        "WorkspaceRuntime requires platformModels to construct AtlasLLMProviderAdapter",
      );
    }
    const engineOptions = {
      documentStore: job.documentStore,
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
      resourceAdapter: this.options.resourceStorage,
    };

    if (job.fsmDefinition) {
      logger.debug("Loading FSM from inline definition", {
        workspaceId: this.workspace.id,
        jobName: job.name,
      });

      const parsed = FSMDefinitionSchema.parse(job.fsmDefinition);
      const definition = expandAgentActions(parsed, this.config.workspace.agents ?? {});

      job.engine = createEngine(definition, engineOptions);
      await job.engine.initialize();
    } else {
      const configPath =
        this.options.workspacePath || path.join(getAtlasHome(), "workspaces", this.workspace.id);
      const fsmPath = job.fsmPath || path.join(configPath, "workspace.fsm.yaml");

      logger.debug("Loading FSM from file", { workspaceId: this.workspace.id, fsmPath });

      const yaml = await readFile(fsmPath, "utf-8");
      const raw = z.object({ fsm: FSMDefinitionSchema }).parse(parseYAML(yaml));

      const parsed = raw.fsm;
      const definition = expandAgentActions(parsed, this.config.workspace.agents ?? {});

      const validation = validateFSMStructure(definition);
      if (!validation.valid) {
        throw new Error(`FSM validation failed:\n${validation.errors.join("\n")}`);
      }

      job.engine = createEngine(definition, engineOptions);
      await job.engine.initialize();
    }

    logger.info("FSM engine initialized for job", {
      jobName: job.name,
      workspaceId: this.workspace.id,
      initialState: job.engine.state,
      documentCount: job.engine.documents.length,
    });
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

    await this.initializeJobEngine(job);
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
    if (!job.engine) {
      throw new Error(`Job ${job.name} engine not initialized`);
    }
    const engine = job.engine;

    const isTriggerSignal = this.isTriggerSignal(signal.id);

    if (isTriggerSignal) {
      logger.info("Trigger signal detected - clearing persisted state for fresh execution", {
        signalId: signal.id,
        workspaceId: this.workspace.id,
        jobName: job.name,
      });
      await this.clearPersistedState(job);

      await engine.reset();

      logger.debug("Engine reset to initial state", {
        workspaceId: this.workspace.id,
        jobName: job.name,
        initialState: engine.state,
      });
    } else {
      logger.debug("Continuation signal - state preserved", {
        signalId: signal.id,
        currentState: engine.state,
      });
    }

    // Seed __meta into engine results so code actions can reference
    // workspace_path, repo_root, workspace_id, and platform_url via
    // context.results['__meta'] without hardcoding operator paths.
    const workspacePath = this.options.workspacePath ?? `.atlas/workspaces/${this.workspace.id}`;
    engine.seedResults({
      __meta: buildWorkspaceMeta({
        workspacePath,
        workspaceId: this.workspace.id,
        daemonUrl: this.options.daemonUrl,
      }),
    });

    const sessionId = crypto.randomUUID();

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
        // Extract userId from signal data for analytics
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
          isTriggerSignal,
          jobName: job.name,
        });

        if (userId) {
          analytics.emit({
            eventName: EventNames.SESSION_STARTED,
            userId,
            workspaceId: this.workspace.id,
            sessionId: session.id,
            jobName: job.name,
          });
        }

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

        // Emit session-start to the client's SSE stream so the web-client can
        // display the session ID (e.g. in the "Report issue" button). This only
        // covers live streaming — for persistence across page reloads, the
        // conversation agent also injects this part before saving to chat storage.
        if (onStreamEvent) {
          await onStreamEvent({ type: "data-session-start", data: { sessionId } });
        }

        // Create "running" activity item (skip conversations)
        const isConversation =
          this.workspace.id === "friday-conversation" || job.name === "handle-chat";
        if (this.options.activityStorage && !isConversation) {
          if (!this.createdByUserId) {
            logger.warn("Skipping activity creation: workspace has no createdByUserId", {
              workspaceId: this.workspace.id,
              sessionId,
            });
          } else {
            try {
              const title = `${kebabToSentenceCase(job.name)} is running`;
              await this.options.activityStorage.create({
                type: "session",
                source: "agent",
                referenceId: sessionId,
                workspaceId: this.workspace.id,
                jobId: job.name,
                userId: this.createdByUserId,
                title,
              });
            } catch (err) {
              logger.warn("Failed to create running activity", { sessionId, error: String(err) });
            }
          }
        }

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
            logger.error("Signal processing failed", {
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
          // Auto-publish dirty resource drafts at session teardown (defensive catch-all)
          if (this.options.resourceStorage) {
            try {
              await publishDirtyDrafts(this.options.resourceStorage, this.workspace.id, {
                jobId: job.name,
                userId: this.createdByUserId,
                activityStorage: this.options.activityStorage,
                platformModels: this.options.platformModels,
              });
            } catch (publishError) {
              logger.warn("Auto-publish at session teardown failed", {
                sessionId: session.id,
                error: publishError instanceof Error ? publishError.message : String(publishError),
              });
            }
          }

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

            const platformModels = this.options.platformModels;
            const aiSummary = platformModels
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

            // Only count actually-executed blocks in summary metrics
            const executedBlocks = view.agentBlocks.filter(
              (b) => b.status !== "skipped" && b.status !== "pending",
            );
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

            // Replace "running" activity with final activity for terminal sessions
            if (
              this.options.activityStorage &&
              this.options.platformModels &&
              this.createdByUserId &&
              !isConversation &&
              (view.status === "completed" || view.status === "failed")
            ) {
              const titlePlatformModels = this.options.platformModels;
              // Delete the "running" activity first
              await this.options.activityStorage.deleteByReferenceId(sessionId).catch((err) => {
                logger.warn("Failed to delete running activity", { sessionId, error: String(err) });
              });

              try {
                // Extract final output from the last completed agent block
                const lastBlock = [...executedBlocks].reverse().find((b) => b.output);
                const finalOutput = lastBlock?.output ? String(lastBlock.output) : undefined;

                const title = await generateSessionActivityTitle({
                  platformModels: titlePlatformModels,
                  status: view.status,
                  jobName: job.name,
                  agentNames: executedBlocks.map((b) => b.agentName),
                  finalOutput,
                  error: session.error?.message,
                });
                await this.options.activityStorage.create({
                  type: "session",
                  source: "agent",
                  referenceId: sessionId,
                  workspaceId: this.workspace.id,
                  jobId: job.name,
                  userId: this.createdByUserId,
                  title,
                });
              } catch (err) {
                logger.warn("Failed to create session activity", { sessionId, error: String(err) });
              }
            }
          }

          this.agentResultSideChannel.delete(sessionId);
          this.activeAbortControllers.delete(sessionId);
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

    const workspaceSession = this.toWorkspaceSession(sessionResult, job);

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

    // Fire improvement loop for failed sessions (async, non-blocking)
    if (
      sessionResult.status === WorkspaceSessionStatus.FAILED &&
      this.options.blueprintArtifactId
    ) {
      this.fireImprovementLoop(sessionResult, job).catch((error) => {
        logger.error("Improvement loop fire-and-forget error", {
          sessionId: sessionResult.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
      const globalMemory = await adapter.corpus(
        GLOBAL_WORKSPACE_ID,
        STANDING_ORDERS_NAME,
        "narrative",
      );
      parts.push(await globalMemory.render());
    } catch {
      // Global level missing or unreadable — skip silently
    }

    try {
      const wsMemory = await adapter.corpus(this.workspace.id, STANDING_ORDERS_NAME, "narrative");
      parts.push(await wsMemory.render());
    } catch {
      // Workspace level missing or unreadable — skip silently
    }

    for (const mount of this._resolvedMemory?.mounts ?? []) {
      if (
        mount.sourceCorpusName === STANDING_ORDERS_NAME &&
        mount.sourceCorpusKind === "narrative"
      ) {
        try {
          const mountedMemory = await adapter.corpus(
            mount.sourceWorkspaceId,
            mount.sourceCorpusName,
            "narrative",
          );
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
      this.options.resourceStorage,
      this.workspace.id,
      ArtifactStorage,
    );

    const prompt = buildFinalAgentPrompt(action.prompt, agentConfigPrompt, context);

    let standingOrdersBlock = "";
    if (process.env.ATLAS_STANDING_ORDERS_BOOTSTRAP === "1" && this.options.memoryAdapter) {
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
    if (process.env.ATLAS_MEMORY_BOOTSTRAP === "1" && this.options.memoryAdapter) {
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
        // User (code) agents bypass the MCP orchestrator — execute directly via WASM
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

        // Auto-publish dirty resource drafts after agent turn completion
        if (this.options.resourceStorage && workspaceId) {
          await publishDirtyDrafts(this.options.resourceStorage, workspaceId);
        }

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
   * Execute a user (WASM code) agent via CodeAgentExecutor.
   * Creates ephemeral MCP connections for tool access, resolves the agent's
   * source location from UserAdapter, and runs the WASM module directly.
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
    },
  ): Promise<AgentResult> {
    // Resolve agent source location from disk
    const agentSource = await this.userAdapter.loadAgent(userAgentId);
    const sourceLocation = path.join(agentSource.metadata.sourceLocation, "agent-js");

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
          mcpConfigs[id] = config;
        }
      }
    }

    // Agent-declared MCP servers take precedence over workspace configs
    if (agentSource.metadata.mcp) {
      for (const [id, config] of Object.entries(agentSource.metadata.mcp)) {
        mcpConfigs[id] = config;
      }
    }

    const { tools: mcpTools, dispose } = await createMCPTools(mcpConfigs, logger);

    // Inject built-in bash tool so code agents can shell out
    mcpTools.bash = createBashTool();

    // Merge skills metadata into agent config when resolved
    let agentConfig = opts.config;
    if (resolvedSkills) {
      const existingWorkDir =
        agentConfig && typeof agentConfig === "object"
          ? (agentConfig as Record<string, unknown>).workDir
          : undefined;
      agentConfig = {
        ...agentConfig,
        skills: resolvedSkills.map((s) => ({ name: s.name, description: s.description })),
        // Only set workDir if we created a temp dir (don't overwrite FSM's clone path)
        ...(skillsTempDir && !existingWorkDir && { workDir: skillsTempDir }),
      };
    }

    try {
      return await this.codeAgentExecutor.execute(sourceLocation, prompt, {
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

  private createSessionSummary(sessionResult: SessionResult, job: FSMJob): SessionSummary {
    const duration = sessionResult.completedAt
      ? sessionResult.completedAt.getTime() - sessionResult.startedAt.getTime()
      : 0;

    const stateTransitions =
      job.engine?.documents.filter(
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

  private toWorkspaceSession(session: SessionResult, job: FSMJob): IWorkspaceSession {
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
   * Clear persisted FSM state for fresh execution.
   * Document cleanup is handled by engine.reset() → persistDocuments().
   */
  private async clearPersistedState(job: FSMJob): Promise<void> {
    if (!job.engine || !job.documentStore) {
      throw new Error("Cannot clear state - engine not initialized");
    }

    const scope = { workspaceId: this.workspace.id, workspaceName: this.workspace.name };
    const fsmId = job.engine.definition.id;

    // Clear persisted state file (no schema, null value — cannot fail validation)
    const clearResult = await job.documentStore.saveState(scope, fsmId, null);
    if (!clearResult.ok) {
      logger.warn("Failed to clear persisted state", { error: clearResult.error });
    }

    const existingDocIds = await job.documentStore.list(scope, fsmId);
    for (const docId of existingDocIds) {
      await job.documentStore.delete(scope, fsmId, docId);
    }

    logger.debug("Cleared persisted state for fresh execution", {
      workspaceId: this.workspace.id,
      jobName: job.name,
      fsmId,
    });
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
    _streamId?: string,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    skipStates?: string[],
  ): Promise<IWorkspaceSession> {
    const signal: WorkspaceRuntimeSignal = {
      id: signalName,
      type: signalName,
      data: payload || {},
      timestamp: new Date(),
    };

    return await this.processSignal(signal, onStreamEvent, undefined, skipStates);
  }

  /**
   * Shutdown the runtime
   */
  async shutdown(): Promise<void> {
    logger.info("Shutting down workspace runtime", { workspaceId: this.workspace.id });

    for (const job of this.jobs.values()) {
      if (job.engine) {
        job.engine.stop();
      }
    }

    await this.orchestrator.shutdown();

    this.sessions.clear();
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
    const active = this.sessions.get(sessionId);
    if (!active) return [];
    const job = this.jobs.get(active.jobName);
    if (!job?.engine) return [];

    // FSM plumbing documents that are noise for most callers. Everything
    // else is passed through — the caller's job to pick fields it cares
    // about. Keeps this method useful for multiple consumers.
    const plumbingTypes = new Set([
      "state-transition",
      "fsm-state",
      "ChatContext",
      "signal-payload",
    ]);
    return job.engine.documents.filter((d) => !plumbingTypes.has(d.type));
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
      const firstJob = Array.from(this.jobs.values())[0];
      return firstJob?.engine?.state || "uninitialized";
    }

    const job = this.jobs.get(jobName);
    return job?.engine?.state || "uninitialized";
  }

  getOrchestrator(): AgentOrchestrator {
    return this.orchestrator;
  }

  /**
   * Fire the self-improvement loop for a failed session.
   * Loads session timeline and delegates to the improvement pipeline.
   */
  private async fireImprovementLoop(sessionResult: SessionResult, job: FSMJob): Promise<void> {
    const blueprintArtifactId = this.options.blueprintArtifactId;
    const invokeImprover = this.options.invokeImprover;
    const platformModels = this.options.platformModels;
    if (!blueprintArtifactId || !invokeImprover || !platformModels) return;

    // Circuit breaker: skip if already fired or a pending revision existed at startup
    if (this.improvementLoopFired || this.options.hasPendingRevision) {
      logger.debug("Skipping improvement loop — already fired or pending revision exists", {
        workspaceId: this.workspace.id,
        sessionId: sessionResult.id,
      });
      return;
    }
    this.improvementLoopFired = true;

    // Load session timeline for transcript analysis
    const timelineResult = await SessionHistoryStorage.loadSessionTimeline(sessionResult.id);
    if (!timelineResult.ok || !timelineResult.data) {
      logger.warn("Could not load session timeline for improvement loop", {
        sessionId: sessionResult.id,
        error: timelineResult.ok ? "no timeline" : timelineResult.error,
      });
      return;
    }

    await runImprovementLoop({
      workspaceId: this.workspace.id,
      workspaceName: this.workspace.name ?? this.workspace.id,
      sessionId: sessionResult.id,
      jobName: job.name,
      errorMessage: sessionResult.error?.message ?? "Unknown error",
      blueprintArtifactId,
      timeline: timelineResult.data,
      platformModels,
      invokeImprover,
    });
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
      willEmitAnalytics: Boolean(
        userId &&
          (status === WorkspaceSessionStatus.COMPLETED || status === WorkspaceSessionStatus.FAILED),
      ),
    });

    if (
      userId &&
      (status === WorkspaceSessionStatus.COMPLETED || status === WorkspaceSessionStatus.FAILED)
    ) {
      const eventName =
        status === WorkspaceSessionStatus.COMPLETED
          ? EventNames.SESSION_COMPLETED
          : EventNames.SESSION_FAILED;
      const jobName = this.sessions.get(sessionResult.id)?.jobName;

      logger.debug("Emitting session analytics", {
        eventName,
        userId,
        sessionId: sessionResult.id,
        jobName,
      });
      analytics.emit({
        eventName,
        userId,
        workspaceId: sessionResult.workspaceId,
        sessionId: sessionResult.id,
        jobName,
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

      // Generate title before other writes to avoid race condition
      const { status } = sessionResult;
      if (status !== WorkspaceSessionStatus.ACTIVE) {
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
      const output = job.engine?.documents
        .filter((doc) => doc.type === "result" || doc.id.endsWith("_result"))
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
        sessionId: sessionResult.id,
        workspaceId: this.workspace.id,
      });
    }
  }
}
