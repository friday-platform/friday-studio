/**
 * FSMEngine - FSM execution engine using code-based guards and actions
 *
 * Executes FSMDefinition with TypeScript code for guards and actions.
 * Guards and actions are executed via dynamic import from code strings.
 */

import {
  type AgentResult as AgentSDKExecutionResult,
  type ArtifactRef,
  ArtifactRefSchema,
  type FailInput,
  FailInputSchema,
  PLATFORM_TOOL_NAMES,
} from "@atlas/agent-sdk";
import { extractToolCallInput, unstringifyNestedJson } from "@atlas/agent-sdk/vercel-helpers";
import type { MCPServerConfig } from "@atlas/config";
import {
  createErrorCause,
  hasUnusableCredentialCause,
  isAPIErrorCause,
  LinkCredentialExpiredError,
  LinkCredentialNotFoundError,
  LLM_AGENT_ALLOWED_PLATFORM_TOOLS,
  NoDefaultCredentialError,
  UserConfigurationError,
  wrapPlatformToolsWithScope,
} from "@atlas/core";
import type { ArtifactStorageAdapter } from "@atlas/core/artifacts";
import { resolveImageParts } from "@atlas/core/artifacts/images";
import { ValidationFailedError, type ValidationVerdict } from "@atlas/hallucination/verdict";
import { buildTemporalFacts } from "@atlas/llm";
import { logger } from "@atlas/logger";
import { createMCPTools, type MCPToolsResult } from "@atlas/mcp";
import { getAtlasPlatformServerConfig } from "@atlas/oapi-client";
import type { SkillSummary } from "@atlas/skills";
import {
  createLoadSkillTool,
  formatAvailableSkills,
  resolveVisibleSkills,
  SkillStorage,
} from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import { type Span as OtelSpan, withOtelSpan } from "@atlas/utils/telemetry.server";
import { type ImagePart, type ModelMessage, type Tool, tool } from "ai";
import { z } from "zod";
import type { DocumentScope, DocumentStore } from "../document-store/mod.ts";
import { expandArtifactRefsInInput } from "./artifact-expansion.ts";
import { FSMDocumentDataSchema } from "./document-schemas.ts";
import { hasDefinedSchema } from "./schema-utils.ts";
import * as serializer from "./serializer.ts";
import type {
  Action,
  AgentAction,
  AgentResult,
  Context,
  Document,
  EmittedEvent,
  FSMActionExecutionEvent,
  FSMBroadcastNotifier,
  FSMDefinition,
  FSMLLMOutput,
  LLMActionTrace,
  LLMProvider,
  OutputValidator,
  Signal,
  SignalWithContext,
  TransitionDefinition,
} from "./types.ts";

/**
 * Platform tools exposed to FSM LLM steps.
 *
 * Mirrors the allowlist used by `runtime.executeCodeAgent` and
 * `routes/agents/run.ts` so all three LLM-agent execution paths see the
 * same surface (fs_*, bash, csv, plus the scope-injected
 * subset for memory/artifacts/state/webfetch). Pre-fix this aliased
 * SCOPE_INJECTED_PLATFORM_TOOLS instead, which silently stripped
 * fs_write_file etc. from FSM LLM steps and broke the canonical
 * "write-file-then-artifacts_create" pattern documented in the
 * writing-to-memory skill. The wrap step below still uses the narrower
 * SCOPE_INJECTED set — only that subset needs workspace-id injection.
 */
const PLATFORM_TOOL_ALLOWLIST = LLM_AGENT_ALLOWED_PLATFORM_TOOLS;

const FSMStateSchema = z.object({ state: z.string() });

const PrepareResultSchema = z
  .object({ task: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

type PrepareResult = z.infer<typeof PrepareResultSchema>;

/**
 * Resolve `{{inputs.x}}`, `{{config.x}}`, and `{{signal.payload.x}}` refs in
 * an agent prompt against the prepare-result payload. LLM-authored workspaces
 * routinely write these placeholders (it's the convention in every other agent
 * framework) and the LLM refuses when they come through unrendered ("required
 * input values are missing"). Dotted paths are supported for nested values;
 * unresolved placeholders are kept verbatim so typos stay visible during
 * authoring rather than silently rendering as empty strings.
 *
 * Uses only properties already exposed via `PrepareResult` (`task`, `config`,
 * `artifactRefs`); does not reach into ambient FSM state, so there's no way
 * an agent's prompt can smuggle context from outside its invocation payload.
 */
export function interpolatePromptPlaceholders(
  prompt: string,
  prepareResult: PrepareResult | undefined,
): string {
  if (!prepareResult) return prompt;
  const config = prepareResult.config ?? {};
  // Expose the same bag under multiple well-known roots — different agent
  // frameworks use different names for this, and the cost of accepting all
  // three is one line per alias. `inputs.*` is the most common.
  const scopes: Record<string, unknown> = { inputs: config, config, signal: { payload: config } };
  return prompt.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\}\}/g, (original, path) => {
    const segments = String(path).split(".");
    let cursor: unknown = scopes;
    for (const segment of segments) {
      if (cursor === null || cursor === undefined || typeof cursor !== "object") {
        return original;
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
    if (cursor === undefined || cursor === null) return original;
    if (typeof cursor === "string") return cursor;
    if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);
    return JSON.stringify(cursor);
  });
}

/**
 * Parse a code action return value into a PrepareResult.
 * Returns undefined for null, non-conforming, or empty (neither task nor config) results.
 */
export function parsePrepareResult(raw: unknown): PrepareResult | undefined {
  if (raw == null) return undefined;

  const parsed = PrepareResultSchema.safeParse(raw);
  if (!parsed.success) {
    logger.debug("Code action return value did not match PrepareResultSchema", {
      error: parsed.error.message,
    });
    return undefined;
  }

  // Filter out empty results (neither task nor config present)
  if (parsed.data.task == null && parsed.data.config == null) {
    return undefined;
  }

  return parsed.data;
}

/**
 * Derive inputSnapshot for action execution events.
 *
 * Resolution order:
 * 1. `inputFrom: <docId>` (string) or `inputFrom: [<id1>, <id2>, ...]` (array)
 *    on the action — explicit author-declared chain from prior steps' outputs.
 *    Wins over carried-over prepareResult: cron/manual triggers auto-seed
 *    prepareResult from signal payloads, and an empty payload (`{}`) used to
 *    overshadow inputFrom and surface as `## Input: { config: {} }`.
 * 2. `prepareResult` from a `prepare` code action — falls through when no
 *    inputFrom is set on the action.
 * 3. Legacy `foo_result` ↔ `foo-request` document convention.
 */
export function getInputSnapshot(
  prepareResult: PrepareResult | undefined,
  action: { type: string; outputTo?: string; inputFrom?: string | string[] },
  documents: Map<string, unknown>,
): { task?: string; config?: Record<string, unknown> } | undefined {
  // inputFrom: explicit chain from a prior step's output document.
  // Fails loud — running with empty context is the bug we're trying to
  // avoid; if the referenced doc isn't there, the FSM is misconfigured.
  const inputFrom = action.type === "agent" || action.type === "llm" ? action.inputFrom : undefined;
  if (inputFrom !== undefined) {
    const ids = Array.isArray(inputFrom) ? inputFrom : [inputFrom];

    const items = ids.map((id) => {
      const doc = documents.get(id);
      if (!doc) {
        const available = [...documents.keys()];
        throw new Error(
          `inputFrom: document '${id}' not found. ` +
            `Available documents: ${available.length ? available.join(", ") : "(none)"}`,
        );
      }
      const data = (doc as { data?: unknown }).data;
      if (data === undefined || data === null) {
        throw new Error(`inputFrom: document '${id}' has no data`);
      }
      return { id, data };
    });

    // Single source: keep historical shape — `task` is the doc data itself
    // (raw string or JSON.stringify of object). Multi-source: prefix each
    // item with its id so the consuming LLM can tell sources apart.
    const task = Array.isArray(inputFrom)
      ? items
          .map(({ id, data }) => `${id}: ${typeof data === "string" ? data : JSON.stringify(data)}`)
          .join("\n\n")
      : typeof items[0]!.data === "string"
        ? (items[0]!.data as string)
        : JSON.stringify(items[0]!.data);

    const config: Record<string, unknown> = Object.fromEntries(
      items.map(({ id, data }) => [id, data]),
    );
    return { task, config };
  }

  // Carried-over prepareResult — from a prior `prepare` code action or
  // auto-seeded from the triggering signal payload.
  if (prepareResult) {
    const { task, config } = prepareResult;
    if (task || config) return { task, config };
  }

  // Fallback: old-style request document lookup (backward compat)
  // Supports unrecompiled workspaces that still use createDoc in prepare fns.
  // Remove this fallback when all workspaces are recompiled.
  return findRequestDocumentLegacy(action, documents);
}

/**
 * Derive request document ID from action outputTo field.
 * Convention: foo_result -> foo-request (underscore to kebab-case)
 * @deprecated Remove once all workspaces are recompiled to use prepare return values.
 */
function getRequestDocIdFromOutputTo(outputTo: string): string | undefined {
  const match = outputTo.match(/^(.+)_result$/);
  if (!match?.[1]) return undefined;

  const kebab = match[1].replaceAll("_", "-");
  return `${kebab}-request`;
}

/**
 * Find request document for an action based on its outputTo field.
 * Returns task and config from the request document if found.
 * @deprecated Remove once all workspaces are recompiled to use prepare return values.
 */
function findRequestDocumentLegacy(
  action: { type: string; outputTo?: string },
  documents: Map<string, unknown>,
): { task?: string; requestDocId?: string; config?: Record<string, unknown> } | undefined {
  // Get outputTo from agent or llm actions only
  const outputTo = action.type === "agent" || action.type === "llm" ? action.outputTo : undefined;

  if (!outputTo) return undefined;

  const requestDocId = getRequestDocIdFromOutputTo(outputTo);
  if (!requestDocId) return undefined;

  const doc = documents.get(requestDocId);
  if (!doc) return undefined;

  const data = (doc as { data?: Record<string, unknown> }).data;
  if (!data) return undefined;

  const task = typeof data.task === "string" ? data.task : undefined;
  const config =
    typeof data.config === "object" && data.config !== null
      ? (data.config as Record<string, unknown>)
      : undefined;

  if (!task && !config) return undefined;

  return { task, requestDocId, config };
}

type LLMResult = AgentResult<string, FSMLLMOutput>;

/** Extract `complete` tool args from LLM result, or structured data if already extracted */
function findCompleteToolArgs(result: LLMResult): Record<string, unknown> | undefined {
  if (!result.ok) return undefined;

  const fromToolCalls = extractToolCallInput(result.toolCalls ?? [], "complete");
  if (fromToolCalls) return fromToolCalls;

  // Fallback: non-response data means structured output was pre-extracted
  if (result.data && !("response" in result.data)) {
    return result.data;
  }

  return undefined;
}

/** Extract `failStep` tool args from LLM result */
function findFailStepToolArgs(result: LLMResult): Record<string, unknown> | undefined {
  if (!result.ok) return undefined;
  return extractToolCallInput(result.toolCalls ?? [], "failStep");
}

/** Max characters per tool result when formatting for retry context */
const MAX_RETRY_TOOL_RESULT_CHARS = 4000;

/** Max total characters for all tool results in retry context */
const MAX_RETRY_TOOL_CONTEXT_CHARS = 50_000;

/**
 * Format tool results from a previous LLM attempt into a readable text block
 * for injection into the retry prompt. Gives the retry LLM visibility into
 * data it already fetched so it can fix its reasoning without re-calling tools.
 */
export function formatToolResultsForRetry(trace: LLMActionTrace): string {
  if (!trace.toolResults?.length) return "";

  const parts: string[] = [];
  let totalLen = 0;

  for (let i = 0; i < trace.toolResults.length; i++) {
    const tr = trace.toolResults[i];
    if (!tr) continue;

    const toolName = tr.toolName ?? "unknown";
    const inputText = tr.input != null ? ` | input: ${JSON.stringify(tr.input)}` : "";
    const header = `=== Tool Result ${i + 1}: ${toolName}${inputText} ===`;

    let outputText: string;
    try {
      const raw = typeof tr.output === "string" ? tr.output : JSON.stringify(tr.output, null, 2);
      outputText =
        raw.length > MAX_RETRY_TOOL_RESULT_CHARS
          ? `${raw.slice(0, MAX_RETRY_TOOL_RESULT_CHARS)}…[truncated]`
          : raw;
    } catch {
      outputText = "[Failed to serialize]";
    }

    const entry = `${header}\n${outputText}`;
    // Account for "\n\n" join separator between entries
    const separatorLen = parts.length > 0 ? 2 : 0;

    if (totalLen + separatorLen + entry.length > MAX_RETRY_TOOL_CONTEXT_CHARS) {
      parts.push(`…[${trace.toolResults.length - i} more tool results truncated for size]`);
      break;
    }

    parts.push(entry);
    totalLen += separatorLen + entry.length;
  }

  return parts.join("\n\n");
}

/**
 * Build LLMActionTrace from an LLM result envelope for hallucination detection.
 * Passes through AI SDK tool types directly without transformation.
 */
export function buildLLMActionTrace(
  result: LLMResult,
  model: string,
  prompt: string,
): LLMActionTrace {
  // Extract content from result - use response field if present, otherwise stringify data
  const content = result.ok
    ? "response" in result.data
      ? String(result.data.response)
      : JSON.stringify(result.data)
    : result.error.reason;

  return {
    content,
    reasoning: result.ok ? result.reasoning : undefined,
    toolCalls: result.ok ? result.toolCalls : undefined,
    toolResults: result.ok ? result.toolResults : undefined,
    model,
    prompt,
  };
}

/**
 * Agent executor callback type
 * Integrates FSM agent actions with external agent orchestration systems
 *
 * @param action - The full AgentAction object (includes agentId, prompt, outputTo)
 * @param context - FSM context with documents, state, and utility functions
 * @param signal - Signal with context (sessionId, workspaceId, onEvent callback)
 * @param options - Optional execution options (e.g., resolved outputSchema from documentTypes)
 */
export type AgentExecutor = (
  action: AgentAction,
  context: Context,
  signal: SignalWithContext,
  options?: { outputSchema?: Record<string, unknown> },
) => Promise<AgentSDKExecutionResult>;

export interface FSMEngineOptions {
  llmProvider?: LLMProvider;
  documentStore: DocumentStore;
  scope: DocumentScope;
  agentExecutor?: AgentExecutor;
  /** MCP server configs from workspace — merged with atlas-platform at call time */
  mcpServerConfigs?: Record<string, MCPServerConfig>;
  validateOutput?: OutputValidator;
  /** Storage adapter for resolving image artifact binary data */
  artifactStorage?: ArtifactStorageAdapter;
  /**
   * Outbound chat broadcaster used by `notification` actions. Required only
   * when an FSM declares at least one such action — engines without it throw
   * a typed error on first encounter.
   */
  broadcastNotifier?: FSMBroadcastNotifier;
}

export class FSMEngine {
  private _currentState: string;
  private _documents = new Map<string, Document>();
  private _results = new Map<string, Record<string, unknown>>();
  private _signalQueue: SignalWithContext[] = [];
  private _processing = false;
  private _initialized = false;
  private _recursionDepth = 0;
  private _compiledSchemas = new Map<string, z.ZodType>();
  private _emittedEvents: EmittedEvent[] = [];
  private static readonly MAX_RECURSION_DEPTH = 10;
  private static readonly MAX_PROCESSED_SIGNALS = 100;
  private _processedSignalsCount = 0;

  constructor(
    private _definition: FSMDefinition,
    private options: FSMEngineOptions,
  ) {
    this._currentState = _definition.initial;
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      throw new Error("FSMEngine already initialized");
    }

    // Load saved state with schema validation
    // Corrupted state (invalid shape) returns error; missing state returns null
    const stateResult = await this.options.documentStore.loadState(
      this.options.scope,
      this.definition.id,
      FSMStateSchema,
    );

    if (!stateResult.ok) {
      throw new Error(`Failed to load FSM state: ${stateResult.error}`);
    }

    const storedState = stateResult.data;
    let stateRestored = false;

    if (storedState) {
      if (this.definition.states[storedState.state]) {
        this._currentState = storedState.state;
        stateRestored = true;
        logger.debug(`Restored state: ${this._currentState}`);
      } else {
        logger.warn(
          `Stored state "${storedState.state}" not found in definition. Resetting to initial.`,
        );
      }
    }

    // Compile document type schemas
    if (this._definition.documentTypes) {
      for (const [typeName, jsonSchema] of Object.entries(this._definition.documentTypes)) {
        try {
          const raw: Record<string, unknown> = jsonSchema;
          const zodSchema = z.fromJSONSchema(raw);
          this._compiledSchemas.set(typeName, zodSchema);
          logger.debug(`Compiled schema for document type: ${typeName}`);
        } catch (error) {
          throw new Error(
            `Failed to compile schema for document type "${typeName}": ${stringifyError(error)}`,
          );
        }
      }
    }

    // Load documents: storage first (if exists), then definition fallback
    const stored = await this.options.documentStore.list(this.options.scope, this._definition.id);

    if (stored.length > 0) {
      // FSM has been run before - restore from persistent storage
      logger.debug(`Restoring ${stored.length} documents from storage`);
      for (const id of stored) {
        const readResult = await this.options.documentStore.read(
          this.options.scope,
          this._definition.id,
          id,
          FSMDocumentDataSchema,
        );
        if (!readResult.ok) {
          logger.warn(`Failed to read document ${id}: ${readResult.error}`);
          continue;
        }
        const doc = readResult.data;
        if (doc) {
          const docType = doc.data.type;
          const docData = doc.data.data;
          try {
            this.validateDocumentData(docType, docData, id);
          } catch (err) {
            // Stored documents were validated at write time — restore failures
            // are typically JSON round-trip issues (null vs undefined) or schema
            // changes between runs. Warn and restore anyway.
            logger.warn(`Restoring document "${id}" despite validation error`, {
              error: err instanceof Error ? err.message : String(err),
            });
          }
          this._documents.set(id, { id, type: docType, data: docData });
        }
      }
    } else if (!stateRestored) {
      // First run - initialize from FSM definition
      logger.debug("No stored documents found, initializing from FSM definition");
      const initialState = this._definition.states[this._currentState];
      if (initialState?.documents) {
        for (const doc of initialState.documents) {
          this.validateDocumentData(doc.type, doc.data, doc.id);
          this._documents.set(doc.id, doc);
        }
      }

      // Execute entry actions for initial state
      if (initialState?.entry) {
        logger.debug("Executing entry actions for initial state", {
          state: this._currentState,
          actionCount: initialState.entry.length,
        });

        await this.executeActions(
          initialState.entry,
          { type: "__init__" },
          this._documents,
          this._emittedEvents,
          this._signalQueue,
          this._currentState,
        );

        logger.debug("Initial state entry actions completed");
      }

      // Persist initial state
      await this.persistExecutionState();
    } else {
      logger.debug("State restored but no documents found. Skipping initialization.");
    }

    // Always persist documents after initialization — clears stale documents
    // from storage regardless of which initialization path was taken
    await this.persistDocuments();

    this._initialized = true;
  }

  async signal(
    sig: Signal,
    context?: {
      sessionId: string;
      workspaceId: string;
      onEvent?: (event: import("./types.ts").FSMEvent) => void;
      /** Separate channel for agent UIMessageChunks (text, reasoning, tool-call, etc.) */
      onStreamEvent?: (chunk: import("@atlas/agent-sdk").AtlasUIMessageChunk) => void;
      abortSignal?: AbortSignal;
      /** State IDs to skip — their entry actions won't execute, engine chains through */
      skipStates?: string[];
    },
  ): Promise<void> {
    const signalWithContext: SignalWithContext = context ? { ...sig, _context: context } : sig;
    this._signalQueue.push(signalWithContext);
    if (!this._processing) {
      await this.processQueue();
    }
  }

  private async processQueue(): Promise<void> {
    this._processing = true;
    this._processedSignalsCount = 0;
    // Clear stale prepare config from previous signal batches so external
    // signals start fresh. Cascaded signals within this run will see
    // __lastPrepare set by earlier signals in the same batch.
    this._results.delete("__lastPrepare");
    try {
      while (this._signalQueue.length > 0) {
        if (this._processedSignalsCount++ > FSMEngine.MAX_PROCESSED_SIGNALS) {
          throw new Error(
            `Maximum signal cascade depth (${FSMEngine.MAX_PROCESSED_SIGNALS}) exceeded. ` +
              "Possible infinite loop in signal emissions.",
          );
        }
        const sig = this._signalQueue.shift();
        if (sig) {
          await this.processSingleSignal(sig);
        }
      }
    } finally {
      this._processing = false;
    }
  }

  private async processSingleSignal(sig: SignalWithContext): Promise<void> {
    await withOtelSpan(
      "fsm.signal",
      {
        "fsm.state": this._currentState,
        "fsm.signal.type": sig.type,
        "fsm.job.name": this._definition.id,
      },
      (otelSpan) => this.processSingleSignalInner(sig, otelSpan),
    );
  }

  private async processSingleSignalInner(
    sig: SignalWithContext,
    otelSpan: OtelSpan | null,
  ): Promise<void> {
    logger.debug("Processing signal", {
      signalType: sig.type,
      currentState: this._currentState,
      hasData: !!sig.data,
    });

    const state = this._definition.states[this._currentState];
    if (!state) throw new Error(`Invalid state: ${this._currentState}`);

    if (!state.on?.[sig.type]) {
      logger.debug("No transition defined for signal", {
        signalType: sig.type,
        currentState: this._currentState,
      });
      return; // No transition for this signal
    }

    // Get transitions for this signal type
    const transitionsOrSingle = state.on[sig.type];
    if (!transitionsOrSingle) {
      return; // No transition for this signal
    }
    const transitions = Array.isArray(transitionsOrSingle)
      ? transitionsOrSingle
      : [transitionsOrSingle];

    // Select first transition (guards removed in Phase 4)
    const selectedTransition: TransitionDefinition | null = transitions[0] ?? null;

    if (!selectedTransition) return; // No valid transition found

    // Skip chain-through: resolve the effective target by chaining through skipped states
    const skipStates = sig._context?.skipStates ?? [];

    // Warn about unknown state IDs (catches typos from direct API callers)
    for (const id of skipStates) {
      if (!this._definition.states[id]) {
        logger.warn("skipStates contains unknown state ID", {
          stateId: id,
          knownStates: Object.keys(this._definition.states),
        });
      }
    }

    let resolvedTarget = selectedTransition.target;
    const visited = new Set<string>();

    while (
      skipStates.includes(resolvedTarget) &&
      resolvedTarget !== this._definition.initial &&
      this._definition.states[resolvedTarget]?.type !== "final"
    ) {
      if (visited.has(resolvedTarget)) {
        throw new Error(`Circular skip chain detected: "${resolvedTarget}" already visited`);
      }
      visited.add(resolvedTarget);

      // Emit skip event before chaining through
      if (sig._context?.onEvent) {
        sig._context.onEvent({
          type: "data-fsm-state-skipped",
          data: {
            sessionId: sig._context.sessionId,
            workspaceId: sig._context.workspaceId,
            jobName: this._definition.id,
            stateId: resolvedTarget,
            timestamp: Date.now(),
          },
        });
      }

      const skippedStateDef = this._definition.states[resolvedTarget];
      const transitions = skippedStateDef?.on;
      if (!transitions) {
        throw new Error(`Cannot skip state "${resolvedTarget}": no outgoing transitions`);
      }

      const transitionKeys = Object.keys(transitions);
      if (transitionKeys.length !== 1) {
        throw new Error(
          `Cannot skip state with ${transitionKeys.length} outgoing transitions: ${resolvedTarget}`,
        );
      }

      const transitionKey = transitionKeys[0];
      if (!transitionKey) {
        throw new Error(`Cannot skip state "${resolvedTarget}": no outgoing transitions`);
      }
      const transitionValue = transitions[transitionKey];
      const singleTransition = Array.isArray(transitionValue)
        ? transitionValue.length === 1
          ? transitionValue[0]
          : null
        : transitionValue;

      if (!singleTransition) {
        throw new Error(`Cannot skip state with multiple guarded transitions: ${resolvedTarget}`);
      }

      resolvedTarget = singleTransition.target;
    }

    if (otelSpan) otelSpan.setAttribute("fsm.state.target", resolvedTarget);

    // Transactional execution:
    // Create pending state copies. Only commit if everything succeeds.
    const pendingDocuments = new Map<string, Document>();
    for (const [id, doc] of this._documents) {
      // Deep clone document to ensure complete isolation during transaction
      // This prevents any mutations from affecting original if transaction fails
      pendingDocuments.set(id, structuredClone(doc));
    }

    const pendingResults = new Map<string, Record<string, unknown>>(this._results);
    const pendingEvents: EmittedEvent[] = [];
    const pendingSignals: SignalWithContext[] = [];
    let pendingState = this._currentState;

    try {
      const previousState = pendingState;

      await withOtelSpan(
        "fsm.transition",
        {
          "fsm.state.from": pendingState,
          "fsm.state.to": resolvedTarget,
          "fsm.signal.type": sig.type,
          "fsm.job.name": this._definition.id,
        },
        async () => {
          // Execute transition actions
          if (selectedTransition.actions && selectedTransition.actions.length > 0) {
            await this.executeActions(
              selectedTransition.actions,
              sig,
              pendingDocuments,
              pendingEvents,
              pendingSignals,
              pendingState,
              pendingResults,
            );
          }

          // Transition to new state (using resolved target that accounts for skip chain)
          pendingState = resolvedTarget;

          logger.debug(`FSM transitioned: ${previousState} -> ${pendingState}`, {
            event: sig.type,
          });

          // Initialize documents for new state if they don't exist
          const newStateDefinition = this._definition.states[pendingState];
          if (newStateDefinition?.documents) {
            for (const doc of newStateDefinition.documents) {
              if (!pendingDocuments.has(doc.id)) {
                this.validateDocumentData(doc.type, doc.data, doc.id);
                pendingDocuments.set(doc.id, doc);
              }
            }
          }

          // Execute entry actions for new state
          if (newStateDefinition?.entry) {
            logger.debug("Executing entry actions for state", {
              state: pendingState,
              actionCount: newStateDefinition.entry.length,
            });

            await this.executeActions(
              newStateDefinition.entry,
              sig,
              pendingDocuments,
              pendingEvents,
              pendingSignals,
              pendingState,
              pendingResults,
            );

            logger.debug("Entry actions completed for state", { state: pendingState });
          }
        },
      );

      // COMMIT PHASE
      // 1. Commit documents
      this._documents = pendingDocuments;
      // 2. Commit results (clear when returning to initial state)
      if (pendingState === this._definition.initial) {
        this._results.clear();
      } else {
        this._results = pendingResults;
      }
      // 3. Commit state
      this._currentState = pendingState;
      // 4. Commit events
      this._emittedEvents = pendingEvents;
      // 5. Commit signals (enqueue them)
      for (const s of pendingSignals) {
        this._signalQueue.push(s);
      }

      // 5. Persist
      await this.persistDocuments();
      await this.persistExecutionState();

      // 6. Emit state transition event if callback provided and state changed
      if (sig._context?.onEvent && previousState !== pendingState) {
        sig._context.onEvent({
          type: "data-fsm-state-transition",
          data: {
            sessionId: sig._context.sessionId,
            workspaceId: sig._context.workspaceId,
            jobName: this._definition.id,
            fromState: previousState,
            toState: pendingState,
            triggeringSignal: sig.type,
            timestamp: Date.now(),
          },
        });
      }
    } catch (error) {
      // Classify the error to determine severity
      const errorCause = createErrorCause(error);

      // The catch fires before the COMMIT PHASE runs, so `this._currentState`
      // still points at the FROM state of the in-flight transition. Use
      // `pendingState` (the state whose entry/transition action actually ran)
      // for accurate attribution. When an entry action of the TO state
      // throws, this distinguishes "summarize failed entering via ADVANCE
      // from triage" from the misleading old "error in state triage".
      const failedState = pendingState;
      const fromState = this._currentState;
      const transitionDescriptor =
        failedState === fromState
          ? `state ${failedState}`
          : `state ${failedState} (entered via ${sig.type} from ${fromState})`;

      if (isAPIErrorCause(errorCause) && errorCause.code === "BUDGET_EXCEEDED") {
        logger.warn(`FSM error in ${transitionDescriptor}, signal ${sig.type}: budget exceeded`, {
          error,
          errorCode: errorCause.code,
          statusCode: errorCause.statusCode,
          state: failedState,
          fromState,
          signalType: sig.type,
        });
      } else {
        // `warn`, not `error`. FSM step failures are domain events
        // (LLM API rejection, tool error, validation fail) that get
        // re-thrown to the runtime and surfaced via the cascade
        // dispatcher's warn-level `Cascade session failed`. Logging at
        // error here turned every misconfigured workspace.yml model id
        // into an infra-level alert.
        logger.warn(`FSM error in ${transitionDescriptor}, signal ${sig.type}`, {
          error,
          state: failedState,
          fromState,
          signalType: sig.type,
        });
      }
      throw error;
    }
  }

  private async executeActions(
    actions: Action[],
    sig: SignalWithContext,
    documents: Map<string, Document>,
    events: EmittedEvent[],
    signals: SignalWithContext[],
    currentState: string,
    results?: Map<string, Record<string, unknown>>,
  ): Promise<void> {
    this._recursionDepth++;
    if (this._recursionDepth > FSMEngine.MAX_RECURSION_DEPTH) {
      throw new Error(
        `Maximum recursion depth (${FSMEngine.MAX_RECURSION_DEPTH}) exceeded. ` +
          "Possible infinite loop in signal emissions.",
      );
    }

    try {
      // Seed prepareResult from the previous state's stored value so agent
      // actions in a cascaded state inherit config (e.g. platformUrl, workDir)
      // without needing their own code action. A code action in this state
      // overrides the stored value naturally via its return value.
      const storedPrepare = results?.get("__lastPrepare");
      let prepareResult: PrepareResult | undefined = storedPrepare
        ? parsePrepareResult(storedPrepare)
        : undefined;

      // If there's no prior prepare result and the triggering signal carries a
      // payload, auto-seed the config from it. Friday-authored FSMs routinely
      // expect agent prompts to reference signal-payload fields (either via
      // `{{inputs.x}}` substitution or the Input section), but most authors
      // never add an explicit code-action to move the payload into
      // prepareResult. Without this, signal payloads simply vanished — the
      // job fired, the FSM ran, and the agent complained about missing
      // inputs while the values sat in `sig.data` unread.
      if (!prepareResult && sig.data && typeof sig.data === "object") {
        const candidate = sig.data as Record<string, unknown>;
        // `createJobTools` wraps tool args under `payload` when firing the
        // signal; unwrap if present so the agent sees the user-supplied
        // fields at the top level. Otherwise take the raw object.
        const payload =
          "payload" in candidate && typeof candidate.payload === "object" && candidate.payload
            ? (candidate.payload as Record<string, unknown>)
            : candidate;
        prepareResult = { config: payload };
      }
      for (const action of actions) {
        prepareResult = await this.executeAction(
          action,
          sig,
          documents,
          events,
          signals,
          currentState,
          results,
          prepareResult,
        );

        // After a code action produces a prepareResult without artifactRefs,
        // collect any artifactRefs from prior agent results in the accumulator.
        // This ensures LLM steps see artifact content even when the prepare
        // function only forwards .response (the common compiled-workspace pattern).
        if (prepareResult && !prepareResult.artifactRefs && results) {
          const seen = new Set<string>();
          const collectedRefs: ArtifactRef[] = [];
          for (const entry of results.values()) {
            const refs = entry.artifactRefs;
            if (Array.isArray(refs)) {
              for (const ref of refs) {
                const parsed = ArtifactRefSchema.safeParse(ref);
                if (parsed.success) {
                  if (!seen.has(parsed.data.id)) {
                    seen.add(parsed.data.id);
                    collectedRefs.push(parsed.data);
                  }
                } else {
                  logger.warn("Malformed artifactRef in agent result, skipping", {
                    error: parsed.error.message,
                  });
                }
              }
            }
          }
          if (collectedRefs.length > 0) {
            prepareResult = { ...prepareResult, artifactRefs: collectedRefs };
          }
        }
      }

      // Persist prepareResult so subsequent states inherit config
      // (e.g. platformUrl, workDir) without needing their own code action.
      if (prepareResult && results) {
        results.set("__lastPrepare", { ...prepareResult });
      }
    } finally {
      this._recursionDepth--;
    }
  }

  private async executeAction(
    action: Action,
    sig: SignalWithContext,
    documents: Map<string, Document>,
    events: EmittedEvent[],
    signals: SignalWithContext[],
    currentState: string,
    results?: Map<string, Record<string, unknown>>,
    prepareResult?: PrepareResult,
  ): Promise<PrepareResult | undefined> {
    const actionStartTime = Date.now();

    // Compute inputSnapshot for agent/llm actions
    const inputSnapshot =
      action.type === "agent" || action.type === "llm"
        ? getInputSnapshot(prepareResult, action, documents)
        : undefined;

    // When the action declares `inputFrom`, the snapshot's chained data must
    // drive the agent's `task` and `## Input` (otherwise the agent renders
    // from the carried-over prepareResult — typically an auto-seeded signal
    // payload — and complains its inputs are missing). But the signal-payload
    // `config` must survive: downstream steps need `{{inputs.<signal_field>}}`
    // to keep working, and end-to-end values like a recipient email should not
    // get clobbered the moment a step uses inputFrom. So we merge: chained
    // doc keys layered on top of the carried-over config (collisions favor the
    // chained data, which matches the historical "inputFrom wins" intent for
    // any name that overlaps).
    const hasExplicitInputFrom =
      (action.type === "agent" || action.type === "llm") && action.inputFrom !== undefined;
    const effectivePrepareResult: PrepareResult | undefined =
      hasExplicitInputFrom && inputSnapshot
        ? {
            ...inputSnapshot,
            config: { ...prepareResult?.config, ...inputSnapshot.config },
            ...(prepareResult?.artifactRefs ? { artifactRefs: prepareResult.artifactRefs } : {}),
          }
        : prepareResult;

    // Emit action started event
    if (sig._context?.onEvent) {
      sig._context.onEvent({
        type: "data-fsm-action-execution",
        data: {
          sessionId: sig._context.sessionId,
          workspaceId: sig._context.workspaceId,
          jobName: this._definition.id,
          actionType: action.type,
          actionId: this.getActionId(action),
          state: currentState,
          status: "started",
          timestamp: actionStartTime,
          inputSnapshot,
        },
      });
    }

    // Create a context bound to the pending documents/signals
    const resultsMap = results ?? this._results;
    const context: Context = {
      documents: Array.from(documents.values()),
      state: currentState,
      results: Object.fromEntries(resultsMap),
      setResult: (key: string, data: Record<string, unknown>) => {
        resultsMap.set(key, data);
      },
      emit: (s: Signal) => {
        logger.debug("Signal emitted from action", {
          signalType: s.type,
          currentState,
          hasData: !!s.data,
        });
        // Cascaded signals inherit parent's context (including onEvent callback).
        // When the emitted signal has explicit data, it replaces the parent's
        // data entirely. When no data is provided (e.g. bare ADVANCE), the
        // parent's data (streamId, datetime) passes through.
        const cascadedSignal: SignalWithContext = sig._context
          ? { ...s, data: s.data ?? sig.data, _context: sig._context }
          : s;
        signals.push(cascadedSignal);
        return Promise.resolve();
      },
      updateDoc: this.makeUpdateDocFn(documents),
      createDoc: this.makeCreateDocFn(documents, currentState),
      deleteDoc: this.makeDeleteDocFn(documents, currentState),
    };

    let llmResultData: FSMActionExecutionEvent["data"]["llmResult"];

    // Build OTEL attributes based on action type
    const otelAttrs: Record<string, string | number | boolean> = {
      "fsm.action.type": action.type,
      "fsm.state": currentState,
      "fsm.job.name": this._definition.id,
    };
    const actionId = this.getActionId(action);
    if (actionId) otelAttrs["fsm.action.id"] = actionId;
    if (action.type === "llm") otelAttrs["fsm.action.model"] = action.model;

    const executeInSpan = async (span: OtelSpan | null) => {
      try {
        switch (action.type) {
          case "emit": {
            events.push({ event: action.event, data: action.data });
            logger.debug("Event emitted", { event: action.event, data: action.data });

            // If we have an emit function in context, call it to trigger transitions
            if (context.emit && action.event) {
              await context.emit({ type: action.event, data: action.data });
            }
            break;
          }

          case "llm": {
            if (!this.options.llmProvider) {
              throw new Error("LLM action requires llmProvider in FSMEngineOptions");
            }

            logger.debug("Executing LLM action", {
              model: action.model,
              state: currentState,
              hasTools: !!action.tools,
              toolCount: action.tools?.length ?? 0,
              outputTo: action.outputTo,
            });

            // Resolve workspace-scoped skills with optional job-level layer.
            // The FSM definition's id IS the job name in workspace.yml — the
            // FSMEngine is built per-job, so `this._definition.id` is the
            // authoritative source even if `sig._context.jobName` is missing
            // (e.g. older callers).
            //
            // LLM actions outside a workspace context get an empty list — we
            // don't fall back to the unfiltered catalog because that would leak
            // skills assigned to other workspaces into this LLM call.
            const workspaceId = sig._context?.workspaceId;
            const jobName = this._definition.id;
            const skills: SkillSummary[] = workspaceId
              ? await resolveVisibleSkills(workspaceId, SkillStorage, { jobName })
              : [];
            if (!workspaceId) {
              logger.warn("LLM action without workspaceId — skill list empty", {
                state: currentState,
              });
            }
            logger.debug("Resolved workspace skills", {
              workspaceId,
              jobName,
              skillCount: skills.length,
              skillNames: skills.map((s) => s.name),
            });

            const buildResult = action.tools
              ? await this.buildTools(action.tools, context, sig._context?.abortSignal)
              : { tools: {}, dispose: async () => {} };
            const baseTools = buildResult.tools;

            let cleanupSkills: (() => Promise<void>) | undefined;
            if (skills.length > 0) {
              // Cast to Tool to avoid deep type instantiation issues with AI SDK generics
              const { tool: loadSkill, cleanup } = createLoadSkillTool({ workspaceId, jobName });
              baseTools.load_skill = loadSkill as Tool;
              cleanupSkills = cleanup;
            }

            try {
              // Inject failStep tool for explicit failure signaling
              const failStepTool = tool({
                description:
                  "Signal that you cannot complete this task. Use this when you lack required information, encounter an unrecoverable error, or the task is impossible to complete.",
                inputSchema: FailInputSchema,
                execute: (input: FailInput) => ({ failed: true, reason: input.reason }),
              });

              const tools: Record<string, Tool> = { ...baseTools, failStep: failStepTool };

              // Check if outputTo document type has a structured schema (properties defined)
              // If so, inject a `complete` tool to capture structured output
              let capturedCompleteOutput: Record<string, unknown> | undefined;
              let completeToolInjected = false;

              if (action.outputTo) {
                // Determine document type name for schema lookup:
                // 1. action.outputType takes precedence (explicit mapping)
                // 2. Fall back to document.type if document exists
                const outputDoc = documents.get(action.outputTo);
                const docTypeName = action.outputType ?? outputDoc?.type;

                if (docTypeName) {
                  const jsonSchema = this._definition.documentTypes?.[docTypeName];

                  // Only inject complete tool if schema has properties defined (not just catch-all)
                  if (hasDefinedSchema(jsonSchema)) {
                    const compiledSchema = this._compiledSchemas.get(docTypeName);
                    if (compiledSchema) {
                      completeToolInjected = true;

                      // Create tool object directly (same pattern as buildTools at line 1118)
                      // This avoids type inference issues with the tool() helper
                      tools.complete = {
                        description:
                          "Call this to complete the task and store results. You MUST call this when finished.",
                        inputSchema: compiledSchema,
                        execute: () => ({ success: true }),
                      };

                      logger.debug("Injected complete tool for structured output", {
                        docType: docTypeName,
                        outputTo: action.outputTo,
                      });
                    }
                  }
                }
              }

              // Build prompt with curated input from prepare function, skills, and image resolution
              let { prompt: contextPrompt, images } = await this.buildContextPrompt(
                action.prompt,
                effectivePrepareResult,
                skills,
              );

              if (completeToolInjected) {
                contextPrompt +=
                  "\n\nIMPORTANT: When you have gathered all necessary information, you MUST call the `complete` tool to store your results. " +
                  "If you cannot complete this task, call the failStep tool with a reason.";
              } else {
                contextPrompt +=
                  "\n\nIMPORTANT: If you cannot complete this task, call the failStep tool with a reason.";
              }

              // Build agentId for the LLM action
              const llmAgentId = `fsm:${this._definition.id}:${action.outputTo ?? "llm"}`;

              // When images are present, assemble a messages array with mixed content.
              // Otherwise, use the prompt-only path for backward compatibility.
              const messages: ModelMessage[] | undefined =
                images.length > 0
                  ? [{ role: "user", content: [{ type: "text", text: contextPrompt }, ...images] }]
                  : undefined;

              const llmToolChoice = completeToolInjected
                ? ({ type: "tool", toolName: "complete" } as const)
                : ("auto" as const);

              let result = await this.options.llmProvider.call({
                agentId: llmAgentId,
                provider: action.provider,
                model: action.model,
                prompt: contextPrompt,
                messages,
                tools,
                toolChoice: llmToolChoice,
                stopOnToolCall: completeToolInjected ? ["complete", "failStep"] : ["failStep"],
                onStreamEvent: sig._context?.onStreamEvent,
                abortSignal: sig._context?.abortSignal,
              });

              // Check for adapter-level errors (network, API, etc.)
              if (!result.ok) {
                throw new Error(`LLM call failed: ${result.error.reason}`);
              }

              // Emit tool events for UI visibility (skip when streaming — events already emitted in real-time)
              if (!sig._context?.onStreamEvent) {
                this.emitToolEvents(result, action, sig, currentState);
              }

              // Check if LLM called failStep (search toolCalls for multi-tool scenarios)
              const failArgs = findFailStepToolArgs(result);
              if (failArgs) {
                throw new Error(`LLM step failed: ${JSON.stringify(failArgs)}`);
              }

              // Check if LLM called complete tool - capture the structured output.
              // The adapter already extracts complete args into result.data, but we
              // also check toolCalls for backward compatibility with mock providers.
              if (completeToolInjected) {
                capturedCompleteOutput = findCompleteToolArgs(result);
              }

              // Validate output if validator provided.
              // Retry policy: only verdict.status === "fail" triggers a retry.
              // Both `pass` and `uncertain` proceed identically — uncertain is observability-only,
              // never gating, so judge confusion (timezones, math) cannot kill recoverable work.
              if (this.options.validateOutput) {
                const trace = buildLLMActionTrace(result, action.model, contextPrompt);
                const validationActionId = this.getActionId(action);

                this.emitValidationAttempt(sig, currentState, validationActionId, {
                  attempt: 1,
                  status: "running",
                });

                const { verdict } = await this.options.validateOutput(
                  trace,
                  sig._context?.abortSignal,
                );
                // Note: If validator throws, error propagates and aborts the action (fail-closed)

                if (verdict.status === "fail") {
                  this.emitValidationAttempt(sig, currentState, validationActionId, {
                    attempt: 1,
                    status: "failed",
                    terminal: false,
                    verdict,
                  });

                  logger.warn("LLM action failed validation, retrying with feedback", {
                    state: currentState,
                    model: action.model,
                    confidence: verdict.confidence,
                    threshold: verdict.threshold,
                    retryGuidance: verdict.retryGuidance,
                  });

                  // Include previous tool results so the retry LLM can see data
                  // it already fetched and fix its reasoning without re-calling tools.
                  const previousToolContext = formatToolResultsForRetry(trace);

                  const retryPrompt =
                    `${contextPrompt}\n\n` +
                    (previousToolContext
                      ? `<previous-attempt-tool-results>\nThese are the tool results from your previous attempt. Use this data to correct your output.\n\n${previousToolContext}\n</previous-attempt-tool-results>\n\n`
                      : "") +
                    `<validation-feedback>\n${
                      verdict.retryGuidance || "Output failed validation."
                    }\n</validation-feedback>\n` +
                    (previousToolContext
                      ? `IMPORTANT: Correct your output using the tool results above. Only re-call tools if you need different data. If you cannot comply, call failStep.`
                      : `IMPORTANT: Correct your output based on the feedback above. If you cannot comply, call failStep.`);

                  // Rebuild messages with retry prompt, preserving image parts from the original call
                  const retryMessages: ModelMessage[] | undefined =
                    images.length > 0
                      ? [
                          {
                            role: "user",
                            content: [{ type: "text", text: retryPrompt }, ...images],
                          },
                        ]
                      : undefined;

                  result = await this.options.llmProvider.call({
                    agentId: llmAgentId,
                    provider: action.provider,
                    model: action.model,
                    prompt: retryPrompt,
                    messages: retryMessages,
                    tools,
                    toolChoice: llmToolChoice,
                    stopOnToolCall: completeToolInjected ? ["complete", "failStep"] : ["failStep"],
                    onStreamEvent: sig._context?.onStreamEvent,
                    abortSignal: sig._context?.abortSignal,
                  });

                  // Check for adapter-level errors on retry
                  if (!result.ok) {
                    throw new Error(`LLM call failed on retry: ${result.error.reason}`);
                  }

                  // Emit tool events for UI visibility (retry — skip when streaming)
                  if (!sig._context?.onStreamEvent) {
                    this.emitToolEvents(result, action, sig, currentState);
                  }

                  // Check if LLM called failStep on retry (search toolCalls for multi-tool scenarios)
                  const retryFailArgs = findFailStepToolArgs(result);
                  if (retryFailArgs) {
                    throw new Error(`LLM step failed on retry: ${JSON.stringify(retryFailArgs)}`);
                  }

                  // Check if LLM called complete tool on retry
                  if (completeToolInjected) {
                    capturedCompleteOutput = findCompleteToolArgs(result);
                  }

                  const retryTrace = buildLLMActionTrace(result, action.model, retryPrompt);

                  // Merge original call's tool results into the retry trace so the
                  // validator can see all fetched data, even if the retry LLM didn't
                  // re-issue the same tool calls.
                  if (trace.toolResults?.length && !retryTrace.toolResults?.length) {
                    retryTrace.toolResults = trace.toolResults;
                    retryTrace.toolCalls = trace.toolCalls;
                  }

                  this.emitValidationAttempt(sig, currentState, validationActionId, {
                    attempt: 2,
                    status: "running",
                  });

                  const { verdict: retryVerdict } = await this.options.validateOutput(
                    retryTrace,
                    sig._context?.abortSignal,
                  );

                  if (retryVerdict.status === "fail") {
                    this.emitValidationAttempt(sig, currentState, validationActionId, {
                      attempt: 2,
                      status: "failed",
                      terminal: true,
                      verdict: retryVerdict,
                    });

                    logger.error("LLM action failed validation after retry", {
                      state: currentState,
                      model: action.model,
                      confidence: retryVerdict.confidence,
                      threshold: retryVerdict.threshold,
                      retryGuidance: retryVerdict.retryGuidance,
                    });
                    // Attach the verdict to the error so callers (Task #29 system error
                    // chunk renderer) can inspect issues without re-parsing strings.
                    throw new ValidationFailedError(retryVerdict, llmAgentId);
                  }

                  this.emitValidationAttempt(sig, currentState, validationActionId, {
                    attempt: 2,
                    status: "passed",
                    verdict: retryVerdict,
                  });

                  logger.info("LLM action passed validation on retry", {
                    state: currentState,
                    model: action.model,
                    status: retryVerdict.status,
                  });
                } else {
                  this.emitValidationAttempt(sig, currentState, validationActionId, {
                    attempt: 1,
                    status: "passed",
                    verdict,
                  });
                }
              }

              if (action.outputTo) {
                const outputDoc = documents.get(action.outputTo);
                const newDocType = action.outputType ?? "LLMResult";
                // Use captured complete output if available, otherwise fall back to result.data
                // result.data is { response: string } for text output, or structured for complete tool
                const dataToStore = capturedCompleteOutput ?? result.data;

                if (capturedCompleteOutput) {
                  logger.debug("Storing structured output from complete tool", {
                    outputTo: action.outputTo,
                    hasData: Object.keys(capturedCompleteOutput).length > 0,
                  });
                }

                // Dual-write: results accumulator (replace semantics)
                // LLMs sometimes stringify nested JSON fields (e.g. arrays as
                // JSON strings). Parse them so downstream .map() calls don't crash.
                if (results && dataToStore) {
                  const sanitized = unstringifyNestedJson(dataToStore);
                  const parsed = z.record(z.string(), z.unknown()).safeParse(sanitized);
                  if (parsed.success) {
                    results.set(action.outputTo, parsed.data);
                  }
                }

                // Dual-write: documents (backward compat)
                if (outputDoc) {
                  outputDoc.data = { ...outputDoc.data, ...dataToStore };
                } else {
                  documents.set(action.outputTo, {
                    id: action.outputTo,
                    type: newDocType,
                    data: dataToStore,
                  });
                }
              }

              // Capture LLM result for session history side-channel
              if (result.ok) {
                const resultsByCallId = new Map(
                  result.toolResults?.map((tr) => [tr.toolCallId, tr.output]) ?? [],
                );
                const toolCalls = (result.toolCalls ?? []).map((tc) => ({
                  toolName: tc.toolName,
                  args: tc.input,
                  ...(resultsByCallId.has(tc.toolCallId) && {
                    result: resultsByCallId.get(tc.toolCallId),
                  }),
                }));
                // Structured output = args from the "complete" tool call (the actual
                // result the agent declared). Falls back to result.data (LLM text)
                // when no complete tool call exists. Mirrors workspace-runtime logic.
                const completeCall = toolCalls.find((tc) => tc.toolName === "complete");
                llmResultData = {
                  toolCalls,
                  reasoning: result.reasoning,
                  output: completeCall?.args ?? result.data,
                };
              }

              // Add tool call names to OTEL span for trace visibility
              if (span && llmResultData?.toolCalls?.length) {
                const toolNames = llmResultData.toolCalls
                  .map((tc) => tc.toolName)
                  .filter((n) => n !== "complete" && n !== "failStep");
                if (toolNames.length) {
                  span.setAttribute("fsm.tools.called", toolNames.join(", "));
                }
              }

              logger.debug("LLM action completed", {
                model: action.model,
                outputTo: action.outputTo,
              });
            } finally {
              await buildResult.dispose();
              cleanupSkills?.();
            }
            break;
          }

          case "agent": {
            if (!this.options.agentExecutor) {
              throw new Error(
                `Agent action requires agentExecutor in FSMEngineOptions. ` +
                  `Pass agentExecutor callback that integrates with your agent system. ` +
                  `Agent: ${action.agentId}`,
              );
            }

            logger.debug("Executing agent action", {
              agentId: action.agentId,
              state: currentState,
              outputTo: action.outputTo,
              hasSignalContext: !!sig._context,
              hasOnStreamEvent: !!sig._context?.onStreamEvent,
              hasPrepareInput: !!prepareResult,
              resultKeys: Object.keys(Object.fromEntries(resultsMap)),
            });

            // Build context for agent execution
            const agentContext: Context = {
              documents: Array.from(documents.values()),
              state: currentState,
              results: Object.fromEntries(resultsMap),
              ...(effectivePrepareResult ? { input: effectivePrepareResult } : {}),
              emit: context.emit,
              updateDoc: this.makeUpdateDocFn(documents),
              createDoc: this.makeCreateDocFn(documents, currentState),
              deleteDoc: this.makeDeleteDocFn(documents, currentState),
            };

            // Resolve output schema from documentTypes — same fallback logic as LLM actions:
            // 1. action.outputType takes precedence (explicit mapping)
            // 2. Fall back to existing document's type if document exists
            const outputDoc = action.outputTo ? documents.get(action.outputTo) : undefined;
            const agentDocTypeName = action.outputType ?? outputDoc?.type;
            const agentOutputSchema = agentDocTypeName
              ? z
                  .record(z.string(), z.unknown())
                  .optional()
                  .parse(this._definition.documentTypes?.[agentDocTypeName])
              : undefined;

            // Execute agent via callback, passing full action object for prompt access
            // Agent returns AgentResult envelope directly
            const result = await this.options.agentExecutor(
              action,
              agentContext,
              sig,
              agentOutputSchema ? { outputSchema: agentOutputSchema } : undefined,
            );

            // Check envelope's ok discriminant for error
            if (!result.ok) {
              throw new Error(result.error.reason);
            }

            // Store result if outputTo specified
            // result.data is the structured output from the agent
            if (action.outputTo && result.data) {
              const parsed = z.record(z.string(), z.unknown()).safeParse(result.data);
              const baseData = parsed.success ? parsed.data : { value: result.data };

              // Validate against schema when outputType is declared
              if (action.outputType) {
                const schema = this._compiledSchemas.get(action.outputType);
                if (schema) {
                  const validation = schema.safeParse(baseData);
                  if (!validation.success) {
                    const issues = validation.error.issues
                      .map((i) => `${i.path.join(".")}: ${i.message}`)
                      .join(", ");
                    throw new Error(
                      `Agent '${action.agentId}' output does not match ${action.outputType} schema: ${issues}`,
                    );
                  }
                }
              }

              // Include artifactRefs after validation (execution metadata, not contract fields)
              const data =
                result.artifactRefs && result.artifactRefs.length > 0
                  ? { ...baseData, artifactRefs: result.artifactRefs }
                  : baseData;

              // Dual-write: results accumulator (replace semantics)
              if (results) {
                results.set(action.outputTo, data);
              }

              // Dual-write: documents (backward compat)
              const existingDoc = documents.get(action.outputTo);
              if (existingDoc) {
                existingDoc.data = { ...existingDoc.data, ...data };
              } else {
                documents.set(action.outputTo, { id: action.outputTo, type: "AgentResult", data });
              }
            }

            logger.debug("Agent action completed", {
              agentId: action.agentId,
              outputTo: action.outputTo,
              durationMs: result.durationMs,
            });
            break;
          }

          case "notification": {
            if (!this.options.broadcastNotifier) {
              throw new Error(
                `FSMEngineOptions.broadcastNotifier is required to execute notification actions. ` +
                  `Engine host must wire one — atlasd does this automatically; third-party ` +
                  `consumers must construct their own.`,
              );
            }
            logger.debug("Executing notification action", {
              state: currentState,
              communicators: action.communicators,
              messageLength: action.message.length,
            });
            await this.options.broadcastNotifier.broadcast({
              message: action.message,
              communicators: action.communicators,
            });
            break;
          }

          default: {
            logger.error("Unknown action type", { action });
            throw new Error(`Unknown action type`);
          }
        }

        // Emit action completed event
        if (sig._context?.onEvent) {
          sig._context.onEvent({
            type: "data-fsm-action-execution",
            data: {
              sessionId: sig._context.sessionId,
              workspaceId: sig._context.workspaceId,
              jobName: this._definition.id,
              actionType: action.type,
              actionId: this.getActionId(action),
              state: currentState,
              status: "completed",
              durationMs: Date.now() - actionStartTime,
              timestamp: Date.now(),
              inputSnapshot,
              llmResult: llmResultData,
            },
          });
        }
      } catch (error) {
        // Emit action failed event before rethrowing
        if (sig._context?.onEvent) {
          sig._context.onEvent({
            type: "data-fsm-action-execution",
            data: {
              sessionId: sig._context.sessionId,
              workspaceId: sig._context.workspaceId,
              jobName: this._definition.id,
              actionType: action.type,
              actionId: this.getActionId(action),
              state: currentState,
              status: "failed",
              durationMs: Date.now() - actionStartTime,
              error: stringifyError(error),
              timestamp: Date.now(),
              inputSnapshot,
            },
          });
        }
        throw error;
      }

      return prepareResult;
    }; // end executeInSpan

    return await withOtelSpan("fsm.action", otelAttrs, executeInSpan);
  }

  /**
   * Get a meaningful identifier for an action based on its type
   */
  private getActionId(action: Action): string | undefined {
    switch (action.type) {
      case "agent":
        return action.agentId;
      case "emit":
        return action.event;
      case "llm":
        return action.outputTo;
      case "notification":
        return action.message.slice(0, 40);
      default:
        return undefined;
    }
  }

  /**
   * Emit tool call and tool result events from an LLM result envelope.
   * Called after LLM calls to stream tool activity for UI visibility.
   * @param result - The LLM result envelope containing toolCalls/toolResults
   * @param action - The LLM action being executed (used for actionId correlation)
   * @param sig - Signal with context containing onEvent callback
   * @param currentState - Current FSM state for event correlation
   */
  private emitToolEvents(
    result: LLMResult,
    action: Action,
    sig: SignalWithContext,
    currentState: string,
  ): void {
    if (!sig._context?.onEvent || !result.ok) return;

    const actionId = this.getActionId(action);
    const timestamp = Date.now();
    const baseData = {
      sessionId: sig._context.sessionId,
      workspaceId: sig._context.workspaceId,
      jobName: this._definition.id,
      actionId,
      state: currentState,
      timestamp,
    };

    // Emit tool call events
    if (result.toolCalls) {
      for (const toolCall of result.toolCalls) {
        sig._context.onEvent({ type: "data-fsm-tool-call", data: { ...baseData, toolCall } });
      }
    }

    // Emit tool result events
    if (result.toolResults) {
      for (const toolResult of result.toolResults) {
        sig._context.onEvent({ type: "data-fsm-tool-result", data: { ...baseData, toolResult } });
      }
    }
  }

  /**
   * Emit a single validation-attempt lifecycle event.
   * `running` events have no `verdict`; `passed`/`failed` carry the verdict.
   * `terminal` is meaningful only on `failed` — `false` on a will-retry failure,
   * `true` on the second attempt's failure that throws.
   */
  private emitValidationAttempt(
    sig: SignalWithContext,
    currentState: string,
    actionId: string | undefined,
    payload: {
      attempt: number;
      status: "running" | "passed" | "failed";
      terminal?: boolean;
      verdict?: ValidationVerdict;
    },
  ): void {
    if (!sig._context?.onEvent) return;
    sig._context.onEvent({
      type: "data-fsm-validation-attempt",
      data: {
        sessionId: sig._context.sessionId,
        workspaceId: sig._context.workspaceId,
        jobName: this._definition.id,
        actionId,
        state: currentState,
        attempt: payload.attempt,
        status: payload.status,
        ...(payload.terminal !== undefined ? { terminal: payload.terminal } : {}),
        ...(payload.verdict !== undefined ? { verdict: payload.verdict } : {}),
        timestamp: Date.now(),
      },
    });
  }

  private async buildContextPrompt(
    basePrompt: string,
    prepareResult?: PrepareResult,
    skills: SkillSummary[] = [],
  ): Promise<{ prompt: string; images: ImagePart[] }> {
    // Ground the LLM temporally at invocation time
    const factsSection = buildTemporalFacts();

    // Resolve `{{inputs.x}}` / `{{config.x}}` references against the prepare
    // result BEFORE composing the prompt. LLM-authored workspaces consistently
    // emit Mustache-style placeholders in agent prompts (it's how CrewAI,
    // LangChain, and every other agent framework do it); Atlas originally
    // didn't substitute them, so the LLM saw literal `{{inputs.content}}`
    // and refused with "required input values are missing" while the actual
    // payload sat in the Input section below. Interpolating here makes the
    // convention work without teaching every author a bespoke pattern. Keys
    // that don't resolve are left intact so broken templates are visible
    // rather than silently blanked to empty strings.
    const resolvedBase = interpolatePromptPlaceholders(basePrompt, prepareResult);

    let prompt = `${factsSection}\n\n${resolvedBase}`;
    const images: ImagePart[] = [];

    // Inject curated input from prepare function (replaces old Available Documents)
    if (prepareResult) {
      const expanded = await expandArtifactRefsInInput(prepareResult);

      // Resolve image artifacts from prepare result if storage adapter is available
      if (this.options.artifactStorage) {
        const input: Record<string, unknown> = prepareResult;
        const refsResult = z.array(z.object({ id: z.string() })).safeParse(input.artifactRefs);

        if (refsResult.success && refsResult.data.length > 0) {
          const result = await this.options.artifactStorage.getManyLatest({
            ids: refsResult.data.map((r) => r.id),
          });

          if (result.ok) {
            const parts = await resolveImageParts(result.data, this.options.artifactStorage);
            for (const part of parts) {
              if (part.type === "image") {
                images.push(part);
              } else {
                // TextPart fallback (binary read failed) — append to prompt
                prompt += `\n${part.text}`;
              }
            }
          }
        }
      }

      prompt = `${prompt}\n\nInput:\n${JSON.stringify(expanded, null, 2)}`;
    }

    if (skills.length > 0) {
      const namedSkills = skills.map((s) => ({
        name: `@${s.namespace}/${s.name}`,
        description: s.description,
      }));
      prompt = `${prompt}\n\n${formatAvailableSkills(namedSkills)}`;
    }

    return { prompt, images };
  }

  /**
   * Build AI SDK Tool objects for LLM action.
   * MCP tools: ephemeral createMCPTools() call — dispose in finally block
   */
  private async buildTools(
    toolNames: string[],
    _context: Context,
    _abortSignal?: AbortSignal,
  ): Promise<{ tools: Record<string, Tool>; dispose: () => Promise<void> }> {
    const tools: Record<string, Tool> = {};
    let dispose: () => Promise<void> = async () => {};

    // `action.tools` accepts three entry shapes:
    //   "serverId/toolName" — qualified, strict per-tool allowlist for that server
    //   "serverId"          — bare server ID, all tools from that server
    //   "toolName"          — bare tool name (legacy); resolved against any
    //                         configured server that exposes it
    //
    // Per-server allowlist tracks which names are permitted from each server.
    // A server mapped to "all" exposes every tool it provides; a server mapped
    // to a Set is restricted to those names. Bare tool names get added to a
    // global pool that's matched by name regardless of source server.
    const knownServer = (id: string) => Boolean(this.options.mcpServerConfigs?.[id]);
    const serverAllow = new Map<string, "all" | Set<string>>();
    const bareToolNames = new Set<string>();
    for (const entry of toolNames) {
      const slash = entry.indexOf("/");
      if (slash > 0) {
        const sid = entry.slice(0, slash);
        const tn = entry.slice(slash + 1);
        const cur = serverAllow.get(sid);
        if (cur === "all") continue;
        if (cur instanceof Set) {
          cur.add(tn);
        } else {
          serverAllow.set(sid, new Set([tn]));
        }
      } else if (knownServer(entry)) {
        serverAllow.set(entry, "all");
      } else {
        bareToolNames.add(entry);
      }
    }
    const hasBareToolName = bareToolNames.size > 0;
    const hasNameAllowlist = hasBareToolName || [...serverAllow.values()].some((v) => v !== "all");

    // MCP tools: always include atlas-platform for ambient capabilities (webfetch,
    // artifacts) even when the action only uses FSM-defined tools. The connection
    // cost is one HTTP roundtrip + dispose per LLM action — acceptable tradeoff
    // for consistent platform tool availability.
    const effectiveConfigs: Record<string, MCPServerConfig> = {
      "atlas-platform": getAtlasPlatformServerConfig(),
    };
    // Server selection. Bare tool names can come from any server, so we have
    // to load all of them and rely on the post-filter to scope down. Without
    // any bare names we connect only to servers explicitly referenced — both
    // qualified (`serverId/toolName`) and bare server IDs.
    if (hasBareToolName && this.options.mcpServerConfigs) {
      for (const [id, config] of Object.entries(this.options.mcpServerConfigs)) {
        if (id !== "atlas-platform") effectiveConfigs[id] = config;
      }
    } else {
      for (const id of serverAllow.keys()) {
        const config = this.options.mcpServerConfigs?.[id];
        if (config && id !== "atlas-platform") {
          effectiveConfigs[id] = config;
        }
      }
    }

    let mcpResult: MCPToolsResult;
    try {
      mcpResult = await createMCPTools(effectiveConfigs, logger);
    } catch (error) {
      if (hasUnusableCredentialCause(error)) {
        let provider = "unknown";
        if (
          error instanceof LinkCredentialNotFoundError ||
          error instanceof LinkCredentialExpiredError
        ) {
          provider = error.serverName ?? "unknown";
        } else if (error instanceof NoDefaultCredentialError) {
          provider = error.provider;
        }
        throw UserConfigurationError.credentialRefreshFailed(this._definition.id, provider, error);
      }
      throw error;
    }
    dispose = mcpResult.dispose;

    // Filter: platform tools must be in allowlist, non-platform tools pass through.
    // Allowlisted platform tools get workspaceId auto-injected from engine scope
    // so workspace.yml never needs to reference workspace identity.
    const filtered: Record<string, Tool> = {};
    for (const [name, mcpTool] of Object.entries(mcpResult.tools)) {
      if (!PLATFORM_TOOL_NAMES.has(name) || PLATFORM_TOOL_ALLOWLIST.has(name)) {
        filtered[name] = mcpTool;
      }
    }

    // Per-agent tools whitelist, applied per-server using the attribution
    // index from createMCPTools. A server mapped to "all" passes every tool
    // through; a server mapped to a Set keeps only those names; bare tool
    // names are matched globally regardless of source server. Without this,
    // an agent declaring `tools: [google-calendar/list_calendars]` would
    // still see every other server's tools (e.g. `send_gmail_message`) —
    // the source of the daily-memo "fetcher agents send their own emails"
    // bug.
    let scoped: Record<string, Tool> = filtered;
    if (hasNameAllowlist) {
      scoped = {};
      for (const [serverId, names] of Object.entries(mcpResult.toolsByServer)) {
        if (serverId === "atlas-platform") {
          // Platform tools were already filtered above by PLATFORM_TOOL_ALLOWLIST.
          // Don't re-filter here — they're ambient, not subject to the agent's
          // workspace MCP whitelist.
          for (const name of names) if (filtered[name]) scoped[name] = filtered[name];
          continue;
        }
        const allow = serverAllow.get(serverId);
        for (const name of names) {
          if (!filtered[name]) continue; // dropped by platform-allowlist filter
          if (allow === "all") {
            scoped[name] = filtered[name];
          } else if (allow instanceof Set && allow.has(name)) {
            scoped[name] = filtered[name];
          } else if (bareToolNames.has(name)) {
            scoped[name] = filtered[name];
          }
        }
      }
    }

    const wrapped = wrapPlatformToolsWithScope(scoped, {
      workspaceId: this.options.scope.workspaceId,
      workspaceName: this.options.scope.workspaceName,
    });
    Object.assign(tools, wrapped);

    return { tools, dispose };
  }

  private validateDocumentData(type: string, data: Record<string, unknown>, id: string): void {
    // Skip validation for system-managed document types
    const systemDocumentTypes = ["AgentResult", "LLMResult"];
    if (systemDocumentTypes.includes(type)) {
      logger.debug("Skipping validation for system document type", { type, id });
      return;
    }

    const schema = this._compiledSchemas.get(type);

    if (!schema) {
      // No schema defined - check if document types are defined at all
      if (this._definition.documentTypes) {
        const availableTypes = Object.keys(this._definition.documentTypes).join(", ");
        throw new Error(
          `Document "${id}" has type "${type}" which is not defined in documentTypes. ` +
            `Available types: ${availableTypes || "none"}`,
        );
      }
      // No document types defined at all - allow any data (backwards compatibility)
      return;
    }

    // Validate against schema
    try {
      schema.parse(data);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const formattedErrors = error.issues
          .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
          .join("\n");
        throw new Error(
          `Document "${id}" of type "${type}" failed validation:\n${formattedErrors}`,
        );
      }
      throw error;
    }
  }

  /**
   * Create createDoc function for context
   * Allows FSM actions to dynamically create documents
   */
  private makeCreateDocFn(
    documents: Map<string, Document> = this._documents,
    currentState: string = this._currentState,
  ): (doc: Document) => void {
    return (doc: Document) => {
      if (documents.has(doc.id)) {
        throw new Error(
          `Cannot create document "${doc.id}" - document already exists. ` +
            `Use updateDoc() to modify existing documents.`,
        );
      }

      // Validate against schema
      this.validateDocumentData(doc.type, doc.data, doc.id);

      // Add to documents Map
      documents.set(doc.id, doc);

      logger.debug("Document created dynamically", {
        documentId: doc.id,
        documentType: doc.type,
        state: currentState,
      });
    };
  }

  /**
   * Create updateDoc function for context
   */
  private makeUpdateDocFn(
    documents: Map<string, Document> = this._documents,
  ): (id: string, data: Record<string, unknown>) => void {
    return (id: string, data: Record<string, unknown>) => {
      const existing = documents.get(id);
      if (existing) {
        // Merge and validate updated data
        const merged = { ...existing.data, ...data };
        this.validateDocumentData(existing.type, merged, id);
        existing.data = merged;
      } else {
        throw new Error(
          `Cannot update document "${id}" - document does not exist. ` +
            `Create the document in the state's documents array first, or use createDoc().`,
        );
      }
    };
  }

  /**
   * Create deleteDoc function for context
   * Allows FSM actions to selectively remove documents
   * Idempotent - no-op if document doesn't exist
   */
  private makeDeleteDocFn(
    documents: Map<string, Document> = this._documents,
    currentState: string = this._currentState,
  ): (id: string) => void {
    return (id: string) => {
      const existed = documents.has(id);
      if (existed) {
        documents.delete(id);
        logger.debug("Document deleted", { documentId: id, state: currentState });
      }
    };
  }

  private async persistExecutionState(): Promise<void> {
    const result = await this.options.documentStore.saveState(
      this.options.scope,
      this.definition.id,
      { state: this._currentState },
      FSMStateSchema,
    );
    if (!result.ok) {
      throw new Error(`Failed to persist FSM state: ${result.error}`);
    }
  }

  private async persistDocuments(): Promise<void> {
    for (const doc of this._documents.values()) {
      const result = await this.options.documentStore.write(
        this.options.scope,
        this._definition.id,
        doc.id,
        { type: doc.type, data: doc.data },
        FSMDocumentDataSchema,
      );
      if (!result.ok) {
        throw new Error(`Failed to persist document ${doc.id}: ${result.error}`);
      }
    }

    // Delete stale documents that are no longer in memory
    const storedIds = await this.options.documentStore.list(
      this.options.scope,
      this._definition.id,
    );
    for (const id of storedIds) {
      if (!this._documents.has(id)) {
        const deleted = await this.options.documentStore.delete(
          this.options.scope,
          this._definition.id,
          id,
        );
        if (!deleted) {
          logger.warn(`Failed to delete stale document ${id} from storage`);
        }
      }
    }
  }

  /** The immutable FSM graph definition this engine was constructed with. */
  get definition(): FSMDefinition {
    return this._definition;
  }

  get state(): string {
    return this._currentState;
  }

  get documents(): Document[] {
    return Array.from(this._documents.values());
  }

  get results(): Record<string, Record<string, unknown>> {
    return Object.fromEntries(this._results);
  }

  getDocument(id: string): Document | undefined {
    return this._documents.get(id);
  }

  get context(): Context {
    return {
      documents: this.documents,
      state: this._currentState,
      results: Object.fromEntries(this._results),
      setResult: (key: string, data: Record<string, unknown>) => {
        this._results.set(key, data);
      },
      emit: (s: Signal) => this.signal(s),
      updateDoc: this.makeUpdateDocFn(),
      createDoc: this.makeCreateDocFn(),
      deleteDoc: this.makeDeleteDocFn(),
    };
  }

  get emittedEvents(): EmittedEvent[] {
    return [...this._emittedEvents];
  }

  toYAML(): string {
    return serializer.toYAML(this.definition);
  }

  stop(): void {}

  /**
   * Reset FSM to initial state without re-initialization
   * Clears all runtime state (signals, events) and returns to initial state
   * Re-runs idle state entry actions to allow selective document cleanup
   * Used when workspace needs to start fresh for trigger signals
   */
  /**
   * Pre-populate results entries before any signal processing.
   * Used by WorkspaceRuntime to inject `__meta` (and potentially other
   * seed data) so code actions see it via `context.results`.
   *
   * Merges entries — safe to call between sessions (when not actively
   * processing). Throws if called mid-session to prevent mutation while
   * the signal queue is draining.
   */
  seedResults(results: Record<string, Record<string, unknown>>): void {
    if (this._processing) {
      throw new Error(
        "seedResults() cannot be called while a signal is being processed. " +
          "Seed data must be injected before or between engine.signal() calls.",
      );
    }
    for (const [key, value] of Object.entries(results)) {
      this._results.set(key, value);
    }
  }

  async reset(): Promise<void> {
    this._currentState = this._definition.initial;
    this._results.clear();
    this._documents.clear();
    this._signalQueue = [];
    this._emittedEvents = [];
    this._recursionDepth = 0;
    this._processedSignalsCount = 0;
    this._processing = false;

    // Re-run idle entry actions (like initialize() does)
    const initialState = this._definition.states[this._currentState];
    if (initialState?.entry) {
      logger.debug("Executing entry actions for reset state", {
        state: this._currentState,
        actionCount: initialState.entry.length,
      });

      await this.executeActions(
        initialState.entry,
        { type: "__reset__" },
        this._documents,
        this._emittedEvents,
        this._signalQueue,
        this._currentState,
      );
    }

    // Always persist after reset — clears stale documents from storage
    // even when initial state has no entry actions
    await this.persistDocuments();

    logger.debug("FSM reset to initial state", {
      fsmId: this._definition.id,
      initialState: this._currentState,
    });
  }
}
