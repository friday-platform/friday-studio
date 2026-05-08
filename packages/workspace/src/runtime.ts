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
  repairToolCall,
  type StoreMountBinding,
  type ToolCall,
  type ToolResult,
} from "@atlas/agent-sdk";
import {
  type DelegationBudget,
  expandAgentActions,
  type GlobalSkillRefConfig,
  type InlineSkillConfig,
  type MergedConfig,
  parseDuration,
  parseSkillRef,
  resolveRuntimeAgentId,
  validateSignalPayload,
} from "@atlas/config";
import {
  AgentOrchestrator,
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
  type SessionAISummary,
  SessionHistoryStorage,
  type SessionStreamEvent,
  type SessionSummary as SessionSummaryV2,
  UserConfigurationError,
  WorkspaceSessionStatus,
  type WorkspaceSessionStatusType,
  wrapPlatformToolsWithScope,
} from "@atlas/core";
import { buildValidateDecisionConfig } from "@atlas/core/agent-context/validate-decision";
import { getSystemAgentType, UserAdapter } from "@atlas/core/agent-loader";
import type { ArtifactLifecycle } from "@atlas/core/artifacts";
import { ArtifactStorage } from "@atlas/core/artifacts/storage";
import { resolveEnvValues } from "@atlas/core/mcp-registry/credential-resolver";
import { applyPlatformEnv } from "@atlas/core/mcp-registry/discovery";
import { mcpServersRegistry } from "@atlas/core/mcp-registry/registry-consolidated";
import { type DocumentStore, getDocumentStore } from "@atlas/document-store";
import {
  type Action,
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
  interpolatePromptPlaceholders,
  type LLMAction,
  type SignalWithContext,
  validateFSMStructure,
} from "@atlas/fsm-engine";
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
 * Await a promise but reject as soon as `signal` aborts, even when the
 * underlying promise never settles. The orphaned promise keeps running — the
 * caller accepts whatever side-effects it produces.
 *
 * Why this exists: `engine.signal()` awaits agent work that can include
 * `fetch()` calls which don't pipe the AbortSignal through. Without this
 * race, a single non-cooperative call wedges the await forever, leaks the
 * `activeAbortControllers` entry, and blocks `cascade-stream`'s in-flight
 * slot — at which point the skipped-duplicate guard rejects every
 * subsequent trigger of the same signal until the daemon restarts.
 */
function awaitWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(asAbortError(signal.reason));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(asAbortError(signal.reason));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Phase 8 — per-field merge of two delegation-budget blocks. Job-level
 * override wins per field; unset fields fall through to workspace-level.
 * Returns `undefined` when both inputs are absent so the caller can skip
 * passing the option to FSMEngineOptions and let `createDelegateTool`'s
 * built-in defaults apply (back-compat: no `delegation:` block ⇒ no
 * change in behavior vs. pre-Phase-8 hardcoded constants).
 *
 * Exported for unit-test parity with the runtime path.
 */
export function mergeDelegationBudgets(
  workspace: DelegationBudget | undefined,
  job: DelegationBudget | undefined,
): DelegationBudget | undefined {
  if (!workspace && !job) return undefined;
  const merged: DelegationBudget = {};
  // Walk the union of keys so the output preserves only fields explicitly
  // set somewhere — never synthesize defaults here (that's the delegate's
  // job, where they're encoded once next to the runtime that consumes them).
  const keys = new Set<keyof DelegationBudget>([
    ...((workspace ? Object.keys(workspace) : []) as Array<keyof DelegationBudget>),
    ...((job ? Object.keys(job) : []) as Array<keyof DelegationBudget>),
  ]);
  for (const key of keys) {
    const jobVal = job?.[key];
    const wsVal = workspace?.[key];
    const value = jobVal !== undefined ? jobVal : wsVal;
    if (value !== undefined) {
      // Type-cast individual assignment — DelegationBudget is a union of
      // optional fields with mixed numeric / nullable shapes.
      (merged as Record<string, unknown>)[key] = value;
    }
  }
  return merged;
}

function asAbortError(reason: unknown): Error {
  if (reason instanceof Error && reason.name === "AbortError") return reason;
  const err = new Error(
    reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "Aborted",
  );
  err.name = "AbortError";
  return err;
}

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
  /**
   * Parent session id when this signal was fired from inside another
   * session (chat-spawned-job, signal-trigger-from-FSM). Forwarded to
   * `SessionSummary.parentSessionId` at finalization. Phase 11
   * provenance for crystallization. Absent for root sessions.
   */
  parentSessionId?: string;
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
  /**
   * C2 — overwrite the persisted summary after finalize. Called by the
   * detached `generateSessionSummary` flow once the LLM-generated aiSummary
   * is ready. Optional so test stubs that don't care about post-finalize
   * updates can omit it.
   */
  updateSummary?(summary: SessionSummaryV2): Promise<void>;
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
  /**
   * B7 (melodic-strolling-seal-pt2) — judge agent runner injected by the
   * daemon. The daemon owns the system-agent registry (workspace can't
   * import `@atlas/system` without a layering violation) and supplies a
   * function that delegates to `judgeAgent.execute(...)` (or the override
   * named in `validate.agent`). When unset, FSM external-validation
   * branches synthesize an advisory verdict so actions still emit.
   */
  runJudge?: import("@atlas/fsm-engine").JudgeAgentRunner;
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
  /**
   * Phase 8 — per-job delegation override. Merged per-field over the
   * workspace-level `delegation:` block at engine-construction time
   * (job wins; unset fields fall through). Carried on the job record so
   * the merge is local to `createJobEngine` and stays out of the
   * signal-routing path.
   */
  delegationOverride?: import("@atlas/config").DelegationBudget;
  /**
   * Phase 12.C / Phase 1.C — per-job permissions from `JobSpecification.permissions`.
   * Forwarded into FSMEngine options so `request_tool_access` can resolve
   * the effective `dangerouslySkipAllowlist` at LLM-call time. Optional;
   * undefined = "no per-job override; fall through to workspace + daemon".
   *
   * `timeoutMs` is the parsed `JobSpecification.config.timeout` in
   * milliseconds. Forwarded into FSMEngine options as `jobTimeoutMs` so
   * scope-injected elicitation tools (`request_tool_access`) can derive
   * `expiresAt = now + jobTimeoutMs` per the user-resolved Phase 12 policy
   * ("tied to job timeout"). Undefined when no timeout configured;
   * elicitation tools fall back to their built-in default.
   */
  permissions?: import("@atlas/config").PermissionsConfig;
  /** Parsed `jobSpec.config.timeout` in milliseconds. See doc above. */
  timeoutMs?: number;
  /**
   * Phase B5 — per-job validation override from
   * `JobSpecification.validation`. Forwarded into FSMEngineOptions so
   * the engine resolves action-level `validate:` against this and the
   * workspace-level default. Optional; undefined = "no per-job
   * override; fall through to workspace then to "auto" classifier".
   */
  validation?: import("@atlas/config").ValidationDefaults;
}

/**
 * Parse a job-config duration into milliseconds. Tolerates a malformed
 * value with a warn-log so one typo doesn't block the entire workspace
 * from loading. Returns undefined on parse failure (caller treats
 * undefined as "no per-job timeout configured" — engine falls back to
 * its built-in default).
 */
function parseJobTimeoutMs(jobName: string, value: string): number | undefined {
  try {
    return parseDuration(value);
  } catch (err) {
    logger.warn("Invalid job timeout — ignoring", { jobName, value, error: stringifyError(err) });
    return undefined;
  }
}

interface ActiveSession {
  id: string;
  jobName: string;
  signalId: string;
  session: IWorkspaceSession;
  startedAt: Date;
  waitForCompletion(): Promise<SessionSummary>; // Convenience method to avoid .session.waitForCompletion()
}

export interface WorkspaceSignalRunResult {
  session: IWorkspaceSession;
  output: Array<{ id: string; type: string; data: Record<string, unknown> }>;
  artifactIds: string[];
  summary: string;
}

/**
 * Reference to an FSM document that was persisted as a real artifact in
 * JetStream Object Store on session completion (Phase 2.B of the
 * fan-out-without-fan-in plan). Parent supervisors will eventually consume
 * this list instead of the full {@link IWorkspaceArtifact} payload — the
 * job-tool result shape change is a follow-on iteration.
 */
export interface SessionArtifactRef {
  /** FSM document id this artifact was synthesized from. */
  documentId: string;
  /** Artifact id assigned by {@link ArtifactStorage.create}. */
  artifactId: string;
  /** Artifact revision (always 1 for newly-created artifacts). */
  revision: number;
}

interface SessionResult {
  id: string;
  workspaceId: string;
  status: WorkspaceSessionStatusType;
  startedAt: Date;
  completedAt?: Date;
  artifacts: IWorkspaceArtifact[];
  /**
   * Persisted-artifact refs for non-plumbing FSM documents emitted during
   * the session. Additive — `artifacts` (the labeled in-memory list) is
   * preserved for existing consumers. Empty when artifact persistence
   * fails or no eligible documents were emitted.
   */
  artifactRefs: SessionArtifactRef[];
  /**
   * AI-generated session summary from `generateSessionSummary` (used for
   * `SessionSummary.aiSummary` finalization). Captured here so synchronous
   * callers — like the cascade dispatcher feeding the SSE `job-complete`
   * event — can surface the summary alongside `artifactRefs` without
   * re-reading the persisted summary stream. Phase 2.C of the fan-in fix.
   *
   * Undefined when the summarizer was skipped (no agent blocks) or
   * silently failed.
   */
  aiSummary?: SessionAISummary;
  error?: Error;
  /** User ID from signal data */
  userId?: string;
  /** Captured FSM events (state transitions and action executions) for batch persistence */
  collectedFsmEvents?: FSMEvent[];
  /** Snapshot of the per-signal engine's documents at completion. */
  engineDocuments?: FSMDocument[];
  /** FSM definition that produced this session; used to derive compact job results. */
  definition?: FSMDefinition;
  finalState?: string;
}

/**
 * FSM plumbing document types that never become artifacts. Exported so
 * tests can assert filter parity with {@link WorkspaceRuntime.getSessionFsmDocuments}.
 */
export const PLUMBING_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "state-transition",
  "fsm-state",
  "ChatContext",
  "signal-payload",
]);

/**
 * Walk the FSM definition once and build a `documentId → action` lookup.
 * Used so artifact persistence can pull the action-author's declared
 * `summary` (Phase 2 schema addition, commit `d61be0f`) instead of
 * synthesizing one from the document's `data`.
 *
 * Only `llm` and `agent` actions can declare `outputTo` + `summary`;
 * other action kinds (`emit`, `notification`) are skipped. When two
 * actions share the same `outputTo` document id (overwriting in a
 * later state), the last one wins — matches FSM runtime semantics
 * where successive writes replace prior data.
 */
export function buildDocumentActionIndex(
  definition: FSMDefinition,
): Map<string, LLMAction | AgentAction> {
  const index = new Map<string, LLMAction | AgentAction>();
  const visit = (actions: Action[] | undefined) => {
    if (!actions) return;
    for (const a of actions) {
      if ((a.type === "llm" || a.type === "agent") && a.outputTo) {
        index.set(a.outputTo, a);
      }
    }
  };
  for (const state of Object.values(definition.states)) {
    visit(state.entry);
    if (!state.on) continue;
    for (const transition of Object.values(state.on)) {
      const transitions = Array.isArray(transition) ? transition : [transition];
      for (const t of transitions) visit(t.actions);
    }
  }
  return index;
}

/**
 * Build a `documentId → fromTerminalState` lookup. A document is "from
 * a terminal state" if the action that emits it lives on a state whose
 * `type === "final"`. Phase 6 default policy uses this to pick
 * lifecycle: terminal-state outputs are durable (user-facing job
 * outputs), non-terminal outputs are ephemeral.
 *
 * When two actions in different states write to the same `outputTo`
 * document id, the runtime applies last-writer-wins — but for
 * lifecycle classification we err on the durable side: if any
 * contributing action is in a terminal state, the document is durable.
 * This is the conservative choice (durable beats ephemeral on
 * collision) and avoids deleting user-facing output a terminal state
 * happened to share an id with a transient one.
 */
export function buildDocumentTerminalIndex(definition: FSMDefinition): Set<string> {
  const terminal = new Set<string>();
  for (const state of Object.values(definition.states)) {
    if (state.type !== "final") continue;
    const visit = (actions: Action[] | undefined) => {
      if (!actions) return;
      for (const a of actions) {
        if ((a.type === "llm" || a.type === "agent") && a.outputTo) {
          terminal.add(a.outputTo);
        }
      }
    };
    visit(state.entry);
    if (!state.on) continue;
    for (const transition of Object.values(state.on)) {
      const transitions = Array.isArray(transition) ? transition : [transition];
      for (const t of transitions) visit(t.actions);
    }
  }
  return terminal;
}

/**
 * Synthesize a structural summary of a document's `data` (~300 chars).
 *
 * I3: prefer a structural fingerprint over raw JSON — supervisors answer
 * common queries (how many? what status?) from the summary alone, so
 * counts and scalar status fields up front beat truncated JSON. We
 * build a `key: value` digest of top-level fields:
 *
 *   - Arrays surface as `<key>: N items`.
 *   - Scalar leaves (string/number/boolean) surface verbatim, with
 *     long strings truncated to keep one field from hogging the budget.
 *   - Nested objects/null/undefined are skipped (too noisy at-a-glance).
 *
 * Falls back to the document type name if the data is empty or a
 * circular structure throws — preserves a non-empty summary so artifact
 * creation doesn't fail Zod validation (`summary.min(1)`).
 */
export function synthesizeArtifactSummary(doc: FSMDocument): string {
  const MAX = 300;
  const parts: string[] = [];
  try {
    for (const [key, value] of Object.entries(doc.data ?? {})) {
      if (value === null || value === undefined) continue;
      if (Array.isArray(value)) {
        parts.push(`${key}: ${value.length} item${value.length === 1 ? "" : "s"}`);
      } else if (typeof value === "string") {
        const trimmed = value.length > 80 ? `${value.slice(0, 79)}…` : value;
        parts.push(`${key}: ${trimmed}`);
      } else if (typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key}: ${String(value)}`);
      }
      // Nested objects intentionally skipped — see comment above.
    }
  } catch {
    return `[${doc.type}]`;
  }
  if (parts.length > 0) {
    const joined = parts.join("; ");
    return joined.length > MAX ? `${joined.slice(0, MAX - 1)}…` : joined;
  }
  // No top-level scalar/array fields — fall back to truncated JSON for
  // at least *some* structural hint of the doc shape.
  let body: string;
  try {
    body = JSON.stringify(doc.data);
  } catch {
    return `[${doc.type}]`;
  }
  if (!body || body === "{}") return `[${doc.type}]`;
  return body.length > MAX ? `${body.slice(0, MAX - 1)}…` : body;
}

/**
 * Phase 2.C fallback when {@link generateSessionSummary} didn't produce a
 * summary AND no terminal-state document has a declared
 * (Phase 2.A) `summary`. Picks the last non-plumbing document and reuses
 * the artifact-summary truncation. Returns an empty string when there's
 * nothing summarizable — the caller decides what to do with that.
 */
export function synthesizeFallbackSummary(
  docs: Array<{ id: string; type: string; data: Record<string, unknown> }>,
): string {
  const last = [...docs].reverse().find((d) => !PLUMBING_DOCUMENT_TYPES.has(d.type));
  if (!last) return "";
  return synthesizeArtifactSummary(last);
}

/**
 * Identify the "terminal action" of an FSM — the last `llm`/`agent` entry
 * action whose output reaches the final state. Used by the C1 aiSummary
 * fast path to read a Phase 2.A `summary:` declaration without an LLM
 * round-trip.
 *
 * Walk order:
 *   1. The final state's own `entry` actions — most jobs put their last
 *      LLM/agent step here.
 *   2. If none, predecessor states (any state with a transition whose
 *      `target` is the final state) and pick the last LLM/agent entry
 *      action across them. Falls through to the transition's own
 *      `actions` array if the predecessor has none.
 *
 * Returns `undefined` when no LLM/agent action can be tied to the
 * terminal output (e.g. emit-only FSMs).
 */
export function findTerminalAction(definition: FSMDefinition): LLMAction | AgentAction | undefined {
  const states = definition.states;
  const finalStateIds = Object.entries(states)
    .filter(([, s]) => s.type === "final")
    .map(([id]) => id);
  if (finalStateIds.length === 0) return undefined;

  const lastLlmOrAgent = (actions: Action[] | undefined): LLMAction | AgentAction | undefined => {
    if (!actions) return undefined;
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (!a) continue;
      if (a.type === "llm" || a.type === "agent") return a;
    }
    return undefined;
  };

  // Tier 1 — final state's own entry actions.
  for (const id of finalStateIds) {
    const found = lastLlmOrAgent(states[id]?.entry);
    if (found) return found;
  }

  // Tier 2 — predecessor states whose transitions point to a final state.
  // Pick the last LLM/agent entry action of any such predecessor; fall
  // back to the transition's own `actions` if the predecessor has none.
  let fromTransitionActions: LLMAction | AgentAction | undefined;
  for (const state of Object.values(states)) {
    if (!state.on) continue;
    for (const transition of Object.values(state.on)) {
      const transitions = Array.isArray(transition) ? transition : [transition];
      for (const t of transitions) {
        if (!finalStateIds.includes(t.target)) continue;
        const fromEntry = lastLlmOrAgent(state.entry);
        if (fromEntry) return fromEntry;
        fromTransitionActions ??= lastLlmOrAgent(t.actions);
      }
    }
  }
  return fromTransitionActions;
}

/**
 * C1 helper — derive `keyDetails` for {@link SessionAISummary} from the
 * terminal action's structured output document. Walks the document's
 * top-level `data` fields:
 *
 *   - String / number / boolean leaves become entries; URL-shaped
 *     strings also populate the `url` field.
 *   - Arrays surface as a count entry (`"N items"`) — I3: lets the
 *     supervisor answer "how many?" from `keyDetails` without
 *     `artifacts_get`. Empty arrays included (`"0 items"`) so consumers
 *     can distinguish "no urgent" from "field missing".
 *   - Nested objects are skipped (too noisy for an at-a-glance summary).
 *
 * Capped at 5 to match the existing aiSummary norm.
 */
export function deriveKeyDetailsFromOutputDoc(
  doc: { data: Record<string, unknown> } | undefined,
): Array<{ label: string; value: string; url?: string }> {
  if (!doc?.data) return [];
  const entries: Array<{ label: string; value: string; url?: string }> = [];
  for (const [key, value] of Object.entries(doc.data)) {
    if (entries.length >= 5) break;
    if (value === null || value === undefined) continue;
    let stringValue: string;
    let urlValue: string | undefined;
    if (typeof value === "string") {
      stringValue = value;
      if (isUrlShaped(value)) urlValue = value;
    } else if (typeof value === "number" || typeof value === "boolean") {
      stringValue = String(value);
    } else if (Array.isArray(value)) {
      stringValue = `${value.length} item${value.length === 1 ? "" : "s"}`;
    } else {
      continue; // skip nested objects
    }
    const entry: { label: string; value: string; url?: string } = {
      label: humanizeFieldKey(key),
      value: stringValue,
    };
    if (urlValue) entry.url = urlValue;
    entries.push(entry);
  }
  return entries;
}

/**
 * Turn `processedCount` → "Processed Count", `total_emails` → "Total
 * Emails". Splits on snake_case underscores and camelCase boundaries,
 * then title-cases each word.
 */
export function humanizeFieldKey(key: string): string {
  return key
    .replace(/_+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/\s+/)
    .filter((w) => w.length > 0)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function isUrlShaped(s: string): boolean {
  return s.startsWith("http://") || s.startsWith("https://");
}

/**
 * C1 fast path — produce a SessionAISummary from the terminal action's
 * declared `summary:` (Phase 2.A) plus structured leaf fields of its
 * `outputTo` document, without an LLM call. Returns `undefined` when
 * no such terminal action is identified or its `summary:` is missing
 * — caller falls back to the LLM-generated path.
 */
export function buildFastPathAiSummary(
  definition: FSMDefinition,
  documents: FSMDocument[],
): SessionAISummary | undefined {
  const terminalAction = findTerminalAction(definition);
  if (!terminalAction) return undefined;
  const declared = terminalAction.summary?.trim();
  if (!declared) return undefined;
  const outputDoc = terminalAction.outputTo
    ? documents.find((d) => d.id === terminalAction.outputTo)
    : undefined;
  return { summary: declared, keyDetails: deriveKeyDetailsFromOutputDoc(outputDoc) };
}

/**
 * C2 synchronous-fallback aiSummary — used when the C1 fast path produced
 * nothing (no terminal action, or no declared `summary:`) but we still
 * need *some* aiSummary to return immediately on SSE `job-complete`
 * instead of waiting ~1-2s for `generateSessionSummary` to finish.
 *
 * Source preference for `summary` text:
 *   1. Terminal action's declared `summary:` (same lookup as the C1 path —
 *      lets actions without an `outputTo` still hit a fast answer).
 *   2. Truncated `JSON.stringify` of the terminal-state document's data,
 *      via {@link synthesizeFallbackSummary}. ~300 chars.
 *
 * `keyDetails` comes from {@link deriveKeyDetailsFromOutputDoc} when an
 * `outputTo` doc is present; otherwise `[]`. The polished LLM summary
 * (when generation completes out-of-band) overwrites this entry.
 */
export function buildSynchronousFallbackAiSummary(
  definition: FSMDefinition,
  documents: FSMDocument[],
): SessionAISummary {
  const terminalAction = findTerminalAction(definition);
  const declared = terminalAction?.summary?.trim();
  const outputDoc = terminalAction?.outputTo
    ? documents.find((d) => d.id === terminalAction.outputTo)
    : undefined;
  const summary =
    declared && declared.length > 0
      ? declared
      : synthesizeFallbackSummary(documents.filter((d) => !PLUMBING_DOCUMENT_TYPES.has(d.type)));
  return { summary, keyDetails: deriveKeyDetailsFromOutputDoc(outputDoc) };
}

export function buildSessionJobResult(args: {
  artifactRefs: SessionArtifactRef[];
  aiSummary?: SessionAISummary;
  definition?: FSMDefinition;
  documents: Array<{ id: string; type: string; data: Record<string, unknown> }>;
}): { artifactIds: string[]; summary: string } {
  const artifactIds = args.artifactRefs.map((r) => r.artifactId);

  if (args.aiSummary?.summary) {
    return { artifactIds, summary: args.aiSummary.summary };
  }

  if (!args.definition) {
    return { artifactIds, summary: synthesizeFallbackSummary(args.documents) };
  }

  const terminalIds = buildDocumentTerminalIndex(args.definition);
  const actionIndex = buildDocumentActionIndex(args.definition);
  for (const doc of args.documents) {
    if (!terminalIds.has(doc.id)) continue;
    const declared = actionIndex.get(doc.id)?.summary;
    if (declared && declared.length > 0) {
      return { artifactIds, summary: declared };
    }
    return { artifactIds, summary: synthesizeArtifactSummary(doc) };
  }

  return { artifactIds, summary: synthesizeFallbackSummary(args.documents) };
}

/**
 * Persist non-plumbing FSM documents as real artifacts in JetStream
 * Object Store. Phase 2.B of the fan-out-without-fan-in plan — the
 * data-layer half of the universal ref-return change. Failures log a
 * warning and continue; the session document store remains the source
 * of truth. Artifact `source` is tagged "fsm-engine:..." so the
 * runtime cleanup pass can correlate artifacts back to their session.
 *
 * Phase 6: each persisted artifact gets a `lifecycle`:
 * - `lifecycleOverride === "ephemeral"` → ephemeral, session-bound
 * - `lifecycleOverride === "durable"` → durable
 * - Otherwise: terminal-state outputs durable; non-terminal outputs
 *   ephemeral, bound to `sessionId` (when provided).
 *
 * `sessionId` is required to materialize an `ephemeral` lifecycle. If
 * absent, ephemeral defaults to durable on persist (back-compat for
 * callers that haven't been threaded yet).
 */
export async function persistFsmSessionArtifacts(args: {
  documents: FSMDocument[];
  definition: FSMDefinition;
  jobName: string;
  workspaceId: string;
  sessionId?: string;
  lifecycleOverride?: "ephemeral" | "durable";
}): Promise<SessionArtifactRef[]> {
  const { documents, definition, jobName, workspaceId, sessionId, lifecycleOverride } = args;
  const refs: SessionArtifactRef[] = [];
  const actionIndex = buildDocumentActionIndex(definition);
  const terminalDocuments = buildDocumentTerminalIndex(definition);

  for (const doc of documents) {
    if (PLUMBING_DOCUMENT_TYPES.has(doc.type)) continue;

    const action = actionIndex.get(doc.id);
    const authorSummary = action?.summary?.trim();
    const summary =
      authorSummary && authorSummary.length > 0 ? authorSummary : synthesizeArtifactSummary(doc);

    let content: string;
    try {
      content = JSON.stringify(doc.data, null, 2);
    } catch (err) {
      logger.warn("Skipping artifact persist: doc.data is not JSON-serializable", {
        documentId: doc.id,
        documentType: doc.type,
        error: stringifyError(err),
      });
      continue;
    }

    // Phase 6 lifecycle decision. Job override > terminal-state default.
    let lifecycle: ArtifactLifecycle;
    if (lifecycleOverride === "durable") {
      lifecycle = { kind: "durable" };
    } else if (lifecycleOverride === "ephemeral" && sessionId) {
      lifecycle = { kind: "ephemeral", boundTo: { scope: "session", sessionId } };
    } else if (terminalDocuments.has(doc.id) || !sessionId) {
      // Terminal-state outputs are durable user-facing results. We also
      // fall back to durable when no sessionId is available, since an
      // ephemeral entry without a binding can't be cleaned up safely.
      lifecycle = { kind: "durable" };
    } else {
      lifecycle = { kind: "ephemeral", boundTo: { scope: "session", sessionId } };
    }

    let result: Awaited<ReturnType<typeof ArtifactStorage.create>>;
    try {
      result = await ArtifactStorage.create({
        data: {
          type: "file",
          content,
          contentEncoding: "utf-8",
          originalName: `${doc.id}.json`,
          mimeType: "application/json",
        },
        title: `${doc.type}: ${doc.id}`,
        summary,
        workspaceId,
        source: `fsm-engine:${jobName}:${doc.id}`,
        lifecycle,
      });
    } catch (err) {
      // Defensive: ArtifactStorage.create returns a Result, but the
      // facade throws if the adapter wasn't initialized. Convert the
      // throw into a logged-and-continue failure so artifact
      // persistence never crashes the session.
      logger.warn("Artifact persist threw — skipping", {
        documentId: doc.id,
        documentType: doc.type,
        error: stringifyError(err),
      });
      continue;
    }

    if (!result.ok) {
      logger.warn("Failed to persist FSM document as artifact", {
        documentId: doc.id,
        documentType: doc.type,
        error: result.error,
      });
      continue;
    }

    refs.push({ documentId: doc.id, artifactId: result.data.id, revision: result.data.revision });
  }

  return refs;
}

/**
 * Phase 6.B — at session-complete, stamp `expiresAt` on each ephemeral
 * artifact bound to this session and `forget()` each ephemeral memory
 * entry bound to it.
 *
 * Replaces the Phase 6 synchronous-delete pass for artifacts. The
 * artifact sweeper (`apps/atlasd/src/sweepers/artifacts-sweeper.ts`)
 * walks `expiresAt`-past-now ephemeral artifacts on a timer and either
 * deletes them or promotes them to durable based on inbound reference
 * signals (memory_save text, aiSummary URL). The grace window between
 * `completedAt` and `expiresAt` is what gives those signals time to
 * land — the chat path's `memory_save` callbacks fire after
 * session-complete in some shapes.
 *
 * Memory entries keep the synchronous-forget behavior: notes are
 * supposed to be genuinely short-term, and there's no analogous
 * promotion-by-reference signal on the memory side (memory IS the
 * promotion signal for artifacts).
 *
 * Free function so tests can exercise it without spinning the full
 * runtime. Failures are non-fatal: an artifact missed here gets
 * picked up by the next sweep tick if its `expiresAt` is past.
 *
 * `graceMs` is the time window after `completedAt` before the artifact
 * becomes eligible for sweeping. Caller computes from job/workspace
 * config (`artifacts.default_grace`).
 */
export async function expireEphemeralForSession(args: {
  sessionId: string;
  jobName: string;
  workspaceId: string;
  completedAt: Date;
  graceMs: number;
  memoryAdapter?: MemoryAdapter;
  memoryStoreNames: string[];
}): Promise<void> {
  const { sessionId, jobName, workspaceId, completedAt, graceMs, memoryAdapter, memoryStoreNames } =
    args;

  const expiresAtIso = new Date(completedAt.getTime() + graceMs).toISOString();

  // 1) Stamp expiresAt on ephemeral artifacts bound to this session.
  //    The sweeper picks them up at/after `expiresAt`. Use
  //    `listBySession` so high-throughput jobs don't N²-scan every
  //    workspace artifact per completion. ArtifactSummary keeps
  //    `lifecycle` (omits only `data`), so no per-id refetch needed.
  try {
    const list = await ArtifactStorage.listBySession({ sessionId, includeData: false });
    if (list.ok) {
      for (const summary of list.data) {
        const lc = summary.lifecycle;
        if (
          lc?.kind === "ephemeral" &&
          lc.boundTo.scope === "session" &&
          lc.boundTo.sessionId === sessionId
        ) {
          const upd = await ArtifactStorage.updateLifecycle({
            id: summary.id,
            lifecycle: { ...lc, expiresAt: expiresAtIso },
          });
          if (!upd.ok) {
            logger.warn("Failed to stamp expiresAt on ephemeral artifact", {
              artifactId: summary.id,
              sessionId,
              error: upd.error,
            });
          }
        }
      }
    } else {
      logger.warn("listBySession failed during ephemeral stamp", { sessionId, error: list.error });
    }
  } catch (err) {
    logger.warn("Ephemeral artifact stamp threw", {
      sessionId,
      jobName,
      error: stringifyError(err),
    });
  }

  // 2) Ephemeral memory entries. Synchronous forget on session-
  //    complete — same behavior as Phase 6. Memory entries don't
  //    participate in the deferred-sweep model (notes are genuinely
  //    short-term; promotion-by-reference applies only to artifacts).
  if (memoryAdapter && memoryStoreNames.length > 0) {
    for (const name of memoryStoreNames) {
      try {
        const store = await memoryAdapter.store(workspaceId, name);
        const entries = await store.read();
        for (const entry of entries) {
          const lc = entry.lifecycle;
          if (
            lc?.kind === "ephemeral" &&
            lc.boundTo.scope === "session" &&
            lc.boundTo.sessionId === sessionId
          ) {
            await store.forget(entry.id);
          }
        }
      } catch (err) {
        logger.warn("Ephemeral memory cleanup failed for store", {
          sessionId,
          storeName: name,
          error: stringifyError(err),
        });
      }
    }
  }
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
   * Per-action artifacts persisted before the FSM drains, keyed by session.
   * These make refs available to downstream `inputFrom` actions in the same
   * run and are merged into the final job-tool result instead of being
   * re-persisted at session completion.
   */
  private midSessionArtifactRefs = new Map<string, SessionArtifactRef[]>();
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
        delegationOverride: jobSpec.delegation,
        ...(jobSpec.permissions && { permissions: jobSpec.permissions }),
        ...(jobSpec.validation && { validation: jobSpec.validation }),
        // Review N3 follow-up: parse `jobSpec.config.timeout` once at
        // registration so the engine path doesn't re-parse on every signal.
        // Becomes the source for FSMEngineOptions.jobTimeoutMs at engine
        // construction. parseDuration throws on malformed input; tolerated
        // with warn-log so a typo doesn't block the workspace from loading.
        ...(jobSpec.config?.timeout && {
          timeoutMs: parseJobTimeoutMs(jobName, jobSpec.config.timeout),
        }),
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

    // Apply registry-owned platformEnv (MCP_ENABLE_OAUTH21, dummy
    // GOOGLE_OAUTH_CLIENT_ID/SECRET, stateless mode) before handing configs
    // to the FSM engine. Without this, cron-triggered LLM actions spawn
    // workspace-mcp in native-OAuth mode and reject every bearer-authed
    // request — see registry-consolidated.ts:101-130 for the failure mode.
    // Same idiom as line 1869-1872 in executeCodeAgent.
    const rawMcpServers = this.config.workspace.tools?.mcp?.servers || {};
    const mcpServerConfigs: Record<string, MCPServerConfig> = {};
    for (const [id, config] of Object.entries(rawMcpServers)) {
      const registryEntry = mcpServersRegistry.servers[id];
      mcpServerConfigs[id] = registryEntry?.platformEnv
        ? applyPlatformEnv(config, registryEntry.platformEnv)
        : config;
    }

    const scope = { workspaceId: this.workspace.id, workspaceName: this.workspace.name, sessionId };
    const platformModels = this.options.platformModels;
    if (!platformModels) {
      throw new Error(
        "WorkspaceRuntime requires platformModels to construct AtlasLLMProviderAdapter",
      );
    }
    let definition!: FSMDefinition;

    const engineOptions = {
      documentStore,
      scope,
      llmProvider: new AtlasLLMProviderAdapter(platformModels.get("conversational"), {
        maxSteps: job.maxSteps,
      }),
      agentExecutor,
      mcpServerConfigs,
      // B7 (melodic-strolling-seal-pt2). External validation is a delegate
      // call to `@friday/judge-agent` (or the per-action override). The
      // daemon supplies the runner via `WorkspaceRuntimeOptions.runJudge`;
      // when unset, fsm-engine synthesizes an advisory verdict so actions
      // still emit on the no-judge path.
      ...(this.options.runJudge ? { runJudge: this.options.runJudge } : {}),
      artifactStorage: ArtifactStorage,
      broadcastNotifier: this.options.broadcastNotifier,
      // Phase 7 — wires the optional `delegate` tool for FSM type:llm
      // actions. `platformModels` and `repairToolCall` are mandatory for
      // the delegate child's streamText call; `delegationBudget` carries
      // the workspace-level depth cap (default 1, matching today's chat
      // hard cap). `linkSummary` is intentionally omitted today —
      // populating it would require a daemon-side fetch on every job
      // engine spawn; delegate tolerates the absence by surfacing a
      // clean error if the LLM passes `mcpServers` without one.
      platformModels,
      repairToolCall,
      // Phase 8 — per-field merge: workspace defaults, then job override
      // wins per field. `mergeDelegationBudgets` returns `undefined` when
      // both inputs are undefined, preserving back-compat (delegate falls
      // back to its built-in defaults inside `createDelegateTool`).
      delegationBudget: mergeDelegationBudgets(
        this.config.workspace.delegation,
        job.delegationOverride,
      ),
      // Phase 12.C / Phase 1.C — forward raw permissions (unresolved) so
      // `request_tool_access` can run `resolvePermissions` with the daemon
      // env floor at call time. Job > workspace > daemon precedence. The
      // engine also resolves these once at action-construction time and
      // surfaces the result through scope as `resolvedPermissions` (review
      // N2 single source of truth).
      ...(job.permissions && { jobPermissions: job.permissions }),
      ...(this.config.workspace.permissions && {
        workspacePermissions: this.config.workspace.permissions,
      }),
      // Phase B5 — workspace + per-job validation defaults. Resolved at
      // action-execution time inside `resolveValidateDecision` (action >
      // job > workspace > "auto" classifier). No merge here: the engine
      // itself walks the precedence chain, so unsetting one tier doesn't
      // require the other to clone.
      ...(this.config.workspace.validation && {
        workspaceValidation: this.config.workspace.validation,
      }),
      ...(job.validation && { jobValidation: job.validation }),
      // E2 (melodic-strolling-seal-pt2): resolve agent type for the FSM
      // classifier's user/atlas → skip rule. Workspace-config-declared
      // agents (`workspace.agents.<id>`) are the common case. Bundled
      // system agents like `workspace-chat` and `judge-agent` don't appear
      // in workspace config — they resolve through `SystemAgentAdapter`.
      // Without this fall-through, `case "agent"` on `workspace-chat`
      // produced `resolvedAgentType: undefined` → classifier hit
      // `default-self` instead of `non-llm-agent-type:atlas`.
      resolveAgentType: (agentId: string): "llm" | "user" | "atlas" | undefined => {
        const declared = this.config.workspace.agents?.[agentId]?.type;
        if (declared === "llm" || declared === "user" || declared === "atlas") {
          return declared;
        }
        // `type: "system"` workspace-config entries (legacy SystemAgentConfig)
        // are also fixed-prompt — same classifier semantics as "atlas".
        if (declared === "system") {
          return "atlas";
        }
        // Bundled system agents (workspace-chat, judge-agent) — see
        // `getSystemAgentType` in `@atlas/core/agent-loader`.
        const bundled = getSystemAgentType(agentId);
        if (bundled) return bundled;
        return undefined;
      },
      // Review N3 follow-up — surface job timeout so scope-injected
      // elicitation tools derive `expiresAt = now + jobTimeoutMs`. Parsed
      // once at job registration (see FSMJob.timeoutMs).
      ...(job.timeoutMs !== undefined && { jobTimeoutMs: job.timeoutMs }),
      persistFsmActionArtifact: async (input: {
        doc: FSMDocument;
        action: LLMAction | AgentAction;
        workspaceId: string;
        sessionId: string;
        fromTerminalState: boolean;
      }) => {
        if (!definition) return;
        await this.persistActionOutputAsRef(input, definition, job.name);
      },
    };

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

    const result = await this.processSignalWithJobResult(
      job,
      signal,
      onStreamEvent,
      abortSignal,
      skipStates,
    );
    return result.session;
  }

  private async processSignalWithJobResult(
    job: FSMJob,
    signal: WorkspaceRuntimeSignal,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    abortSignal?: AbortSignal,
    skipStates?: string[],
  ): Promise<WorkspaceSignalRunResult> {
    const sessionResult = await this.processSignalForJob(
      job,
      signal,
      onStreamEvent,
      abortSignal,
      skipStates,
    );
    const output = this.buildCompletedSignalOutput(sessionResult);
    const session = await this.finalizeSession(sessionResult, job, signal);
    return { session, ...output };
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
          artifactRefs: [],
          userId,
        };

        const sessionStream = this.options.createSessionStream?.(sessionId);
        let stepCounter = 0;
        /** Tracks the FSM state where a non-agent action (code/emit) failed, so we
         *  can attribute the error to the correct planned step in the catch block. */
        let failedActionStateId: string | undefined;
        /** Set true once we've finalized the session (cancellation path). The
         *  orphan `engine.signal` may keep firing onEvent/onStreamEvent
         *  callbacks for minutes after; this flag short-circuits them so late
         *  events don't land in JetStream after `session:complete` has been
         *  emitted. */
        let finalized = false;

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

        // Capture the engine.signal promise so we can race it against the
        // abort signal (see `awaitWithAbort`). If the engine is wedged on
        // non-cooperative work, the await rejects immediately on cancel,
        // releasing this session and the cascade-stream slot above it.
        const enginePromise = engine.signal(
          { type: signal.id, data: signal.data || {} },
          {
            sessionId: session.id,
            workspaceId: this.workspace.id,
            abortSignal: effectiveAbortSignal,
            skipStates,
            // FSM lifecycle events only (state transitions, action executions, tool calls/results)
            onEvent: (event) => {
              // Drop events from an orphaned engine.signal that's still
              // running after we cancelled and finalized the session.
              if (finalized) return;
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
                  sessionStream.emit(
                    mapActionToStepComplete(actionEvent, actionEvent.data.llmResult, stepCounter),
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
              if (finalized) return;
              onStreamEvent?.(chunk);
              sessionStream?.emitEphemeral({ stepNumber: stepCounter, chunk });
            },
          },
        );

        try {
          await awaitWithAbort(enginePromise, effectiveAbortSignal);

          session.artifacts = this.extractArtifacts(engine.documents);
          // Phase 2.B — persist eligible FSM documents as real artifacts so a
          // future job-tool result shape can return artifactIds + summary
          // instead of the full Document[] payload. Non-blocking: failures
          // log and are skipped, the in-memory `session.artifacts` list and
          // the document store remain authoritative.
          const midSessionRefs = this.midSessionArtifactRefs.get(session.id) ?? [];
          const alreadyPersistedDocIds = new Set(midSessionRefs.map((r) => r.documentId));
          const remainingDocuments = engine.documents.filter(
            (d) => !alreadyPersistedDocIds.has(d.id),
          );
          const completionRefs = await this.persistSessionArtifacts(
            remainingDocuments,
            engine.definition,
            job.name,
            session.id,
          );
          session.artifactRefs = [...midSessionRefs, ...completionRefs];
          this.midSessionArtifactRefs.delete(session.id);
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

          // Phase 6.B — stamp `expiresAt` on ephemeral artifacts (sweeper
          // picks them up later) and forget ephemeral memory entries
          // (synchronous, same as Phase 6). Fire-and-forget: failures
          // log a warning and are otherwise silent. The artifact
          // sweeper (`apps/atlasd/src/sweepers/artifacts-sweeper.ts`)
          // is the long-stop — it picks up any artifact past
          // `expiresAt` regardless of which run stamped it.
          this.expireEphemeralForSession(session.id, job.name, session.completedAt).catch((err) => {
            logger.warn("Ephemeral expire pass failed", {
              sessionId: session.id,
              jobName: job.name,
              error: stringifyError(err),
            });
          });

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
            // We bailed before engine.signal settled — attach a tail handler so
            // the orphan's eventual settlement doesn't surface as an
            // UnhandledPromiseRejection, and log when it actually unwinds so
            // operators can spot agents that ignore AbortSignal.
            enginePromise.then(
              () => {
                logger.info("Orphan engine.signal resolved after cancel", {
                  sessionId: session.id,
                });
              },
              (orphanErr) => {
                logger.info("Orphan engine.signal rejected after cancel", {
                  sessionId: session.id,
                  error: stringifyError(orphanErr),
                });
              },
            );
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

          const failedMidSessionRefs = this.midSessionArtifactRefs.get(session.id) ?? [];
          if (failedMidSessionRefs.length > 0) {
            const existingDocIds = new Set(session.artifactRefs.map((r) => r.documentId));
            session.artifactRefs = [
              ...session.artifactRefs,
              ...failedMidSessionRefs.filter((r) => !existingDocIds.has(r.documentId)),
            ];
            if (session.completedAt) {
              this.expireEphemeralForSession(session.id, job.name, session.completedAt).catch(
                (err) => {
                  logger.warn("Ephemeral expire pass failed after failed session", {
                    sessionId: session.id,
                    jobName: job.name,
                    error: stringifyError(err),
                  });
                },
              );
            }
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
          // Close the gate before emitting terminal events. From this point on
          // an orphaned engine.signal can't write to the session stream — its
          // callbacks short-circuit on `finalized`.
          finalized = true;
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
            // C1 fast path — when the terminal LLM/agent action declared a
            // Phase 2.A `summary:`, build SessionAISummary synchronously
            // without the ~1-2s LLM round-trip.
            const fastPathAiSummary = buildFastPathAiSummary(engine.definition, engine.documents);
            // C2 — when the fast path is unavailable (no declared summary)
            // we still want SSE `job-complete` to respond immediately. Build
            // a synchronous fallback aiSummary now and detach the LLM-
            // generated path; on resolution we update persisted KV and
            // emit a follow-up session:summary event.
            const eligibleForLlmSummary =
              !fastPathAiSummary && platformModels !== undefined && executedBlocks.length > 0;
            const synchronousFallback = fastPathAiSummary
              ? undefined
              : buildSynchronousFallbackAiSummary(engine.definition, engine.documents);
            // Suppress the synchronous emission when there's literally
            // nothing to say (no terminal action + no docs) AND we're going
            // to detach a real LLM call that will emit later. Avoids a
            // noisy empty-string `session:summary` followed by the polished
            // one a beat later.
            const synchronousFallbackHasContent = !!(
              synchronousFallback &&
              (synchronousFallback.summary.length > 0 || synchronousFallback.keyDetails.length > 0)
            );
            const aiSummary: SessionAISummary | undefined =
              fastPathAiSummary ??
              (synchronousFallbackHasContent ? synchronousFallback : undefined);
            if (aiSummary) {
              sessionStream.emit({
                type: "session:summary",
                timestamp: new Date().toISOString(),
                summary: aiSummary.summary,
                keyDetails: aiSummary.keyDetails,
              });
              // Phase 2.C — capture on the in-memory SessionResult so the
              // cascade dispatcher (which reads via getSessionAiSummary
              // post-completion) can forward `summary` on `job-complete`.
              session.aiSummary = aiSummary;
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
              // Phase 11 provenance: parent linkage when this session was
              // spawned from inside another (chat→job, signal-trigger-from-
              // FSM). Conditionally spread so root sessions stay free of the
              // field on the wire — keeps existing SESSION_METADATA entries
              // and round-trip schema parses unchanged.
              ...(signal.parentSessionId && { parentSessionId: signal.parentSessionId }),
            };

            await sessionStream.finalize(summaryV2).catch((err) => {
              logger.warn("Failed to finalize session stream", { sessionId, error: String(err) });
            });

            // C2 — detached LLM aiSummary generation. SSE `job-complete`
            // fired above with the synchronous fallback; the polished
            // summary writes to persisted session-history KV when the LLM
            // round-trip resolves. Activity page picks it up on next read;
            // live SSE subscribers see the follow-up `session:summary` event.
            if (eligibleForLlmSummary && platformModels) {
              const updateStream = sessionStream;
              const llmSummaryV2Base = summaryV2;
              void generateSessionSummary(
                view,
                { platformModels },
                job.description,
                this.workspace.name,
              )
                .then(async (llmSummary) => {
                  if (!llmSummary) return;
                  // 1. Emit a follow-up session:summary event for live SSE
                  //    subscribers (cascade-stream forwards arbitrary
                  //    session events; no allowlist update needed).
                  try {
                    updateStream.emit({
                      type: "session:summary",
                      timestamp: new Date().toISOString(),
                      summary: llmSummary.summary,
                      keyDetails: llmSummary.keyDetails,
                    });
                  } catch (emitErr) {
                    logger.warn("Failed to emit follow-up session:summary", {
                      sessionId,
                      error: String(emitErr),
                    });
                  }
                  // 2. Overwrite the persisted SessionSummary so Activity
                  //    page (listByWorkspace) reflects the polished aiSummary.
                  if (updateStream.updateSummary) {
                    await updateStream
                      .updateSummary({ ...llmSummaryV2Base, aiSummary: llmSummary })
                      .catch((err) => {
                        logger.warn("Failed to persist async aiSummary update", {
                          sessionId,
                          error: String(err),
                        });
                      });
                  }
                })
                .catch((err) => {
                  logger.warn("async aiSummary generation failed", {
                    sessionId,
                    error: String(err),
                  });
                });
            }

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
          session.definition = engine.definition;
          session.finalState = engine.state;
          this.midSessionArtifactRefs.delete(session.id);
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
    options?: {
      outputSchema?: Record<string, unknown>;
      validateDecision?: "skip" | "self" | "external";
      validateSkill?: string;
    },
  ): Promise<AgentResult> {
    // E1 (melodic-strolling-seal-pt2): when the FSM engine resolved an
    // `outputSchema` for this action (i.e. the action declared an
    // `outputType:`), thread that fact through `__atlas_validate` so the
    // orchestrator's prompt-assembly site (`convertLLMToAgent`) can skip
    // `record_validation` injection on the structured + self path.
    const hasOutputType = !!options?.outputSchema;
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

    // Resolve `{{inputs.x}}` / `{{config.x}}` / `{{signal.payload.x}}` against
    // the prepare-result payload before composing the final prompt. The LLM
    // action path does this in `buildContextPrompt`; agent actions skipped it,
    // so Friday workspaces (which exclusively use agent actions) saw literal
    // `{{inputs.description}}` and the agent fell back to whatever it could
    // glean from the appended `## Input` block instead. Interpolating here
    // makes the convention work uniformly across both action types.
    const prepareResult = fsmContext.input;
    const interpolatedActionPrompt = action.prompt
      ? interpolatePromptPlaceholders(action.prompt, prepareResult)
      : action.prompt;
    const interpolatedConfigPrompt = interpolatePromptPlaceholders(
      agentConfigPrompt,
      prepareResult,
    );
    const prompt = buildFinalAgentPrompt(
      interpolatedActionPrompt,
      interpolatedConfigPrompt,
      context,
    );

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
    const baseMergedConfig = prepareConfig
      ? { ...agentCustomConfig, ...prepareConfig }
      : agentCustomConfig;

    // B4 + B6 (melodic-strolling-seal-pt2): thread the resolved validation
    // decision under the reserved `__atlas_validate` key so the agent
    // orchestrator's prompt-assembly site (`convertLLMToAgent` in
    // `@atlas/core/agent-conversion/from-llm.ts`) can compose the
    // validating-llm-outputs skill body and inject the `record_validation`
    // platform tool when the strategy is `self`. The reserved key prevents
    // collisions with author-supplied `agents.<id>.config:` blocks.
    const mergedConfig = options?.validateDecision
      ? {
          ...baseMergedConfig,
          ...buildValidateDecisionConfig(
            options.validateDecision,
            options.validateSkill,
            hasOutputType,
          ),
        }
      : baseMergedConfig;

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
                actionId: agentId,
                jobTimeoutMs: job.timeoutMs,
                config: mergedConfig,
                outputSchema: options?.outputSchema,
                input: fsmContext.input,
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
                actionId: agentId,
                jobTimeoutMs: job.timeoutMs,
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
      actionId?: string;
      jobTimeoutMs?: number;
      config?: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
      input?: Record<string, unknown>;
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
      sessionId: opts.sessionId,
      ...(opts.actionId && { actionId: opts.actionId }),
      ...(opts.jobTimeoutMs !== undefined && { jobTimeoutMs: opts.jobTimeoutMs }),
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

    const observedToolCalls: ToolCall[] = [];
    const observedToolResults: ToolResult[] = [];

    try {
      const result = await executor.execute(sourceLocation, prompt, {
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
          const toolCallId = crypto.randomUUID();
          observedToolCalls.push({
            type: "tool-call",
            toolCallId,
            toolName: name,
            input: args,
          } as ToolCall);

          const tool = mcpTools[name];
          if (!tool?.execute) {
            const error = `Unknown tool: ${name}`;
            observedToolResults.push({
              type: "tool-result",
              toolCallId,
              toolName: name,
              output: { error },
            } as ToolResult);
            throw new Error(error);
          }

          try {
            const output = await tool.execute(args, { toolCallId, messages: [] });
            observedToolResults.push({
              type: "tool-result",
              toolCallId,
              toolName: name,
              output,
            } as ToolResult);
            return output;
          } catch (error) {
            observedToolResults.push({
              type: "tool-result",
              toolCallId,
              toolName: name,
              output: { error: stringifyError(error) },
            } as ToolResult);
            throw error;
          }
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
        input: opts.input,
        skills: resolvedSkills?.map((s) => ({
          name: s.name,
          description: s.description,
          instructions: s.instructions,
        })),
        abortSignal: opts.abortSignal,
      });

      if (observedToolCalls.length === 0 && observedToolResults.length === 0) {
        return result;
      }

      return {
        ...result,
        toolCalls: [...(result.toolCalls ?? []), ...observedToolCalls],
        toolResults: [...(result.toolResults ?? []), ...observedToolResults],
      };
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

  private async persistActionOutputAsRef(
    input: {
      doc: FSMDocument;
      action: LLMAction | AgentAction;
      workspaceId: string;
      sessionId: string;
      fromTerminalState: boolean;
    },
    definition: FSMDefinition,
    jobName: string,
  ): Promise<void> {
    if (PLUMBING_DOCUMENT_TYPES.has(input.doc.type)) return;
    if (!this.activeAbortControllers.has(input.sessionId)) return;

    let originalDoc: FSMDocument;
    try {
      originalDoc = {
        id: input.doc.id,
        type: input.doc.type,
        data: JSON.parse(JSON.stringify(input.doc.data)) as Record<string, unknown>,
      };
    } catch (err) {
      logger.warn("Skipping mid-session artifact persist: doc.data is not JSON-serializable", {
        documentId: input.doc.id,
        documentType: input.doc.type,
        error: stringifyError(err),
      });
      return;
    }

    const refs = await this.persistSessionArtifacts(
      [originalDoc],
      definition,
      jobName,
      input.sessionId,
    );
    const ref = refs[0];
    if (!ref) return;

    const summary = input.action.summary?.trim() || synthesizeArtifactSummary(originalDoc);
    const artifactRef = { id: ref.artifactId, type: originalDoc.type, summary };
    input.doc.data = { summary, artifactRefs: [artifactRef] };

    const existing = this.midSessionArtifactRefs.get(input.sessionId) ?? [];
    const withoutPriorForDoc = existing.filter((r) => r.documentId !== ref.documentId);
    withoutPriorForDoc.push(ref);
    this.midSessionArtifactRefs.set(input.sessionId, withoutPriorForDoc);
  }

  private persistSessionArtifacts(
    documents: FSMDocument[],
    definition: FSMDefinition,
    jobName: string,
    sessionId: string,
  ): Promise<SessionArtifactRef[]> {
    // Phase 6 — per-job ephemeral override, if declared in workspace.yml.
    const jobSpec = this.config.workspace.jobs?.[jobName];
    const ephemeralOverride = jobSpec?.artifacts?.ephemeral;
    const lifecycleOverride: "ephemeral" | "durable" | undefined =
      ephemeralOverride === true
        ? "ephemeral"
        : ephemeralOverride === false
          ? "durable"
          : undefined;

    return persistFsmSessionArtifacts({
      documents,
      definition,
      jobName,
      workspaceId: this.workspace.id,
      sessionId,
      lifecycleOverride,
    });
  }

  /**
   * Phase 6.B — at session-complete, stamp `expiresAt` on ephemeral
   * artifacts (sweeper picks them up later) and forget ephemeral
   * memory entries (synchronous, same as Phase 6). Called fire-and-
   * forget from the session-completion path; failures log and
   * continue. Lifecycle metadata is the source of truth — the sweeper
   * picks up anything missed.
   *
   * Grace window resolves job-spec → workspace-config → 24h fallback.
   * `parseDuration` from `@atlas/config` handles the format ("24h",
   * "1h", "30m" — see {@link DurationSchema}).
   */
  private expireEphemeralForSession(
    sessionId: string,
    jobName: string,
    completedAt: Date,
  ): Promise<void> {
    const jobSpec = this.config.workspace.jobs?.[jobName];
    const graceStr =
      jobSpec?.artifacts?.default_grace ?? this.config.workspace.artifacts?.default_grace ?? "24h";
    let graceMs: number;
    try {
      graceMs = parseDuration(graceStr);
    } catch {
      // Schema already validates DurationSchema, but if a future field
      // shape introduces an unparseable value, fall back to 24h
      // rather than skipping the stamp entirely.
      graceMs = 24 * 60 * 60 * 1000;
    }
    return expireEphemeralForSession({
      sessionId,
      jobName,
      workspaceId: this.workspace.id,
      completedAt,
      graceMs,
      memoryAdapter: this.options.memoryAdapter,
      memoryStoreNames: (this.config.workspace.memory?.own ?? []).map((m) => m.name),
    });
  }

  /**
   * Phase 6.B — exposes a promotion-by-reference scan context for the
   * artifacts sweeper. The sweeper lives in atlasd; runtime keeps the
   * authoritative memory-adapter binding and configured store names,
   * so it surfaces them through this accessor instead of the daemon
   * reaching into private fields. aiSummary reference scans are backed
   * by the daemon's durable session-history adapter, not by runtime
   * completion caches.
   */
  getPromotionScanContext(): {
    memoryAdapter?: MemoryAdapter;
    memoryStoreNames: string[];
    aiSummary?: () => Promise<Array<{ url?: string }>>;
  } {
    const ctx: {
      memoryAdapter?: MemoryAdapter;
      memoryStoreNames: string[];
      aiSummary?: () => Promise<Array<{ url?: string }>>;
    } = { memoryStoreNames: (this.config.workspace.memory?.own ?? []).map((m) => m.name) };
    if (this.options.memoryAdapter) ctx.memoryAdapter = this.options.memoryAdapter;
    return ctx;
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
    /**
     * Parent session id; threads through to
     * `SessionSummary.parentSessionId` so chat→job and similar parent
     * linkages are recoverable from session history. Phase 11 of the
     * fan-out-without-fan-in plan.
     */
    parentSessionId?: string,
  ): Promise<IWorkspaceSession> {
    const result = await this.triggerSignalWithResult(
      signalName,
      payload,
      streamId,
      onStreamEvent,
      skipStates,
      abortSignal,
      parentSessionId,
    );
    return result.session;
  }

  async triggerSignalWithResult(
    signalName: string,
    payload?: Record<string, unknown>,
    streamId?: string,
    onStreamEvent?: (chunk: AtlasUIMessageChunk) => void,
    skipStates?: string[],
    abortSignal?: AbortSignal,
    parentSessionId?: string,
  ): Promise<WorkspaceSignalRunResult> {
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
      parentSessionId,
    };

    await this.ensureInitialized();
    const matchingJobs = Array.from(this.jobs.values()).filter((job) =>
      job.signals.includes(signal.id),
    );
    const job = matchingJobs[0];
    if (!job) {
      throw new Error(
        `No FSM job handles signal '${signal.id}' in workspace '${this.workspace.id}'`,
      );
    }

    const signalConfig = this.config.workspace.signals?.[signal.id];
    if (signalConfig) {
      const validation = validateSignalPayload(signalConfig, signal.data);
      if (!validation.success) {
        throw new Error(`Signal payload validation failed for '${signal.id}': ${validation.error}`);
      }
    }

    return await this.processSignalWithJobResult(
      job,
      signal,
      onStreamEvent,
      abortSignal,
      skipStates,
    );
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
    this.midSessionArtifactRefs.clear();
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

  private buildCompletedSignalOutput(
    sessionResult: SessionResult,
  ): Omit<WorkspaceSignalRunResult, "session"> {
    const output = (sessionResult.engineDocuments ?? []).filter(
      (doc) => !PLUMBING_DOCUMENT_TYPES.has(doc.type),
    );
    const result = buildSessionJobResult({
      artifactRefs: sessionResult.artifactRefs,
      aiSummary: sessionResult.aiSummary,
      definition: sessionResult.definition,
      documents: output,
    });
    return { output, ...result };
  }

  /**
   * Return live FSM documents for an in-flight session. Completed signal
   * callers receive their final output directly from `triggerSignalWithResult`
   * instead of reading a post-completion runtime cache.
   */
  getSessionFsmDocuments(
    sessionId: string,
  ): Array<{ id: string; type: string; data: Record<string, unknown> }> {
    const engine = this.sessionEngines.get(sessionId);
    if (!engine) return [];
    return engine.documents.filter((d) => !PLUMBING_DOCUMENT_TYPES.has(d.type));
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
