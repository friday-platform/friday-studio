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
} from "@atlas/agent-sdk";
import { extractToolCallInput } from "@atlas/agent-sdk/vercel-helpers";
import { createErrorCause, isAPIErrorCause } from "@atlas/core";
import type { ArtifactStorageAdapter } from "@atlas/core/artifacts";
import { resolveImageParts } from "@atlas/core/artifacts/images";
import { buildTemporalFacts } from "@atlas/llm";
import { logger } from "@atlas/logger";
import type { SkillSummary } from "@atlas/skills";
import { createLoadSkillTool, formatAvailableSkills, SkillStorage } from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import { type CoreMessage, type ImagePart, type Tool, tool } from "ai";
import { z } from "zod";
import type { DocumentScope, DocumentStore } from "../document-store/node.ts";
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
  FSMDefinition,
  FSMLLMOutput,
  LLMActionTrace,
  LLMProvider,
  OutputValidator,
  Signal,
  SignalWithContext,
  TransitionDefinition,
} from "./types.ts";
import { WorkerExecutor } from "./worker-executor.ts";

const FSMStateSchema = z.object({ state: z.string() });

const PrepareResultSchema = z
  .object({ task: z.string().optional(), config: z.record(z.string(), z.unknown()).optional() })
  .passthrough();

type PrepareResult = z.infer<typeof PrepareResultSchema>;

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
 * Prefers prepare result when available, falls back to legacy request document lookup
 * for backward compatibility with unrecompiled workspaces.
 */
export function getInputSnapshot(
  prepareResult: PrepareResult | undefined,
  action: { type: string; outputTo?: string },
  documents: Map<string, unknown>,
): { task?: string; config?: Record<string, unknown> } | undefined {
  // New path: use prepare result when available
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

/**
 * Transform code for Function constructor (same as function-executor.worker.ts).
 */
function transformForExecution(code: string): string {
  const trimmed = code.trim();
  if (trimmed.startsWith("export default")) {
    return trimmed.replace("export default", "const __fn__ =");
  }
  return `const __fn__ = ${trimmed}`;
}

/**
 * Try to parse code, returning the error if it fails.
 */
function tryParse(code: string): SyntaxError | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function(
      "context",
      "event",
      `${transformForExecution(code)}; return __fn__(context, event);`,
    );
    return null;
  } catch (error) {
    return error instanceof SyntaxError ? error : null;
  }
}

/**
 * Attempt to fix apostrophes in single-quoted strings.
 * Example: 'team's calendar' → "team's calendar"
 */
function attemptStringQuoteFix(code: string): string | null {
  // Pattern: 'word's thing' or 'couldn't work' - apostrophe between letters
  const pattern = /'([^'\\]*[a-zA-Z])'([a-zA-Z][^']*)'/g;
  const fixed = code.replace(pattern, '"$1\'$2"');
  return fixed !== code ? fixed : null;
}

/**
 * Validate and potentially fix function code syntax at compile time.
 * Attempts auto-fix for common LLM mistakes before failing.
 */
function validateAndFixFunctionSyntax(code: string, functionName: string): string {
  // Try original code
  const error = tryParse(code);
  if (!error) return code;

  // Try auto-fix
  const fixedCode = attemptStringQuoteFix(code);
  if (fixedCode && !tryParse(fixedCode)) {
    logger.info(`Auto-fixed string escaping in function "${functionName}"`);
    return fixedCode;
  }

  // Neither worked
  throw new Error(
    `Syntax error in function "${functionName}": ${error.message}\n\nFunction code:\n${code}`,
  );
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
 */
export type AgentExecutor = (
  action: AgentAction,
  context: Context,
  signal: SignalWithContext,
) => Promise<AgentSDKExecutionResult>;

export interface FSMEngineOptions {
  llmProvider?: LLMProvider;
  documentStore: DocumentStore;
  scope: DocumentScope;
  agentExecutor?: AgentExecutor;
  mcpToolProvider?: import("./mcp-tool-context.ts").MCPToolProvider;
  validateOutput?: OutputValidator;
  /** Storage adapter for resolving image artifact binary data */
  artifactStorage?: ArtifactStorageAdapter;
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
  private _guardFunctions = new Map<string, string>(); // Store CODE, not compiled fn
  private _actionFunctions = new Map<string, string>(); // Store CODE, not compiled fn
  private _guardExecutor: WorkerExecutor;
  private _actionExecutor: WorkerExecutor;
  private _toolExecutor: WorkerExecutor;
  private static readonly MAX_RECURSION_DEPTH = 10;
  private static readonly MAX_PROCESSED_SIGNALS = 100;
  private _processedSignalsCount = 0;

  constructor(
    private _definition: FSMDefinition,
    private options: FSMEngineOptions,
  ) {
    this._currentState = _definition.initial;

    // Documents will be loaded in initialize() to avoid race condition
    // between definition and persistent storage

    this._guardExecutor = new WorkerExecutor({ timeout: 1000, functionType: "guard" });
    this._actionExecutor = new WorkerExecutor({ timeout: 10000, functionType: "action" });
    this._toolExecutor = new WorkerExecutor({
      timeout: 180000,
      functionType: "tool",
      permissions: { net: true, read: true, env: true },
    });
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

    // Load and compile guard/action functions
    if (this._definition.functions) {
      for (const [name, func] of Object.entries(this._definition.functions)) {
        try {
          // Validate syntax and auto-fix common LLM escaping issues
          const validatedCode = validateAndFixFunctionSyntax(func.code, name);

          if (func.type === "guard") {
            this._guardFunctions.set(name, validatedCode);
          } else {
            this._actionFunctions.set(name, validatedCode);
          }

          logger.debug(`Compiled ${func.type} function: ${name}`);
        } catch (error) {
          throw new Error(
            `Failed to compile ${func.type} function "${name}": ${stringifyError(error)}`,
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

      // Persist initial documents if any
      if (this._documents.size > 0) {
        await this.persistDocuments();
      }

      // Persist initial state
      await this.persistExecutionState();
    } else {
      logger.debug("State restored but no documents found. Skipping initialization.");
    }

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
    logger.debug("Processing signal", {
      signalType: sig.type,
      currentState: this._currentState,
      hasData: !!sig.data,
    });

    const state = this._definition.states[this._currentState];
    if (!state) throw new Error(`Invalid state: ${this._currentState}`);

    if (!state.on || !state.on[sig.type]) {
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

    // Find first transition whose guards all pass (or first without guards)
    let selectedTransition: TransitionDefinition | null = null;
    for (const t of transitions) {
      if (!t.guards || t.guards.length === 0) {
        // Unconditional transition
        selectedTransition = t;
        break;
      }

      // Check all guards
      let allGuardsPassed = true;
      for (const guardName of t.guards) {
        const guardCode = this._guardFunctions.get(guardName);
        if (!guardCode) {
          throw new Error(`Guard function "${guardName}" not found`);
        }

        try {
          const result = await this._guardExecutor.execute(guardCode, guardName, this.context, sig);
          const passed = Boolean(result);
          logger.debug("Guard evaluated", {
            guardName,
            passed,
            signalType: sig.type,
            currentState: this._currentState,
          });

          if (!passed) {
            allGuardsPassed = false;
            break;
          }
        } catch (error) {
          throw new Error(`Guard "${guardName}" threw error: ${stringifyError(error)}`);
        }
      }

      if (allGuardsPassed) {
        selectedTransition = t;
        break;
      }
    }

    if (!selectedTransition) return; // No valid transition found

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
    const pendingSignals: Signal[] = [];
    let pendingState = this._currentState;

    try {
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

      // Transition to new state
      const previousState = pendingState;
      pendingState = selectedTransition.target;

      logger.debug(`FSM transitioned: ${previousState} -> ${pendingState}`, { event: sig.type });

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

      // Budget exceeded is expected when workspace hits spending limit - don't spam Sentry
      if (isAPIErrorCause(errorCause) && errorCause.code === "BUDGET_EXCEEDED") {
        logger.warn(
          `FSM error in state ${this._currentState}, signal ${sig.type}: budget exceeded`,
          { error, errorCode: errorCause.code, statusCode: errorCause.statusCode },
        );
      } else {
        logger.error(`FSM error in state ${this._currentState}, signal ${sig.type}`, { error });
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
      let prepareResult: PrepareResult | undefined;
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
        // Cascaded signals inherit parent's context (including onEvent callback)
        const cascadedSignal: SignalWithContext = sig._context
          ? { ...s, _context: sig._context }
          : s;
        signals.push(cascadedSignal);
        return Promise.resolve();
      },
      updateDoc: this.makeUpdateDocFn(documents),
      createDoc: this.makeCreateDocFn(documents, currentState),
      deleteDoc: this.makeDeleteDocFn(documents, currentState),
    };

    let codeActionResult: PrepareResult | undefined;
    let llmResultData: FSMActionExecutionEvent["data"]["llmResult"];

    try {
      switch (action.type) {
        case "code": {
          const actionCode = this._actionFunctions.get(action.function);
          if (!actionCode) {
            throw new Error(`Action function "${action.function}" not found`);
          }

          logger.debug("Executing code action", {
            function: action.function,
            state: currentState,
            signalType: sig.type,
          });

          try {
            const returnValue = await this._actionExecutor.execute(
              actionCode,
              action.function,
              context,
              sig,
            );
            codeActionResult = parsePrepareResult(returnValue);
            logger.debug("Code action completed", {
              function: action.function,
              state: currentState,
              hasReturnValue: returnValue != null,
            });
          } catch (error) {
            throw new Error(`Action "${action.function}" threw error: ${stringifyError(error)}`);
          }
          break;
        }

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

          // Fetch workspace skills for injection
          const workspaceId = sig._context?.workspaceId;
          let skills: SkillSummary[] = [];
          if (workspaceId) {
            const skillsResult = await SkillStorage.list(workspaceId);
            if (!skillsResult.ok) {
              logger.error("Failed to fetch workspace skills", {
                workspaceId,
                error: skillsResult.error,
              });
            }
            skills = skillsResult.ok ? skillsResult.data : [];
            logger.debug("Workspace skills query result", {
              workspaceId,
              ok: skillsResult.ok,
              skillCount: skills.length,
              skillNames: skills.map((s) => s.name),
            });
          } else {
            logger.debug("Skipping skill injection - no workspaceId in signal context", {
              hasContext: !!sig._context,
              signalType: sig.type,
            });
          }

          // Build base tools from action definition
          const baseTools = action.tools ? await this.buildTools(action.tools, context) : {};

          // Add load_skill tool if workspace has skills
          if (skills.length > 0 && workspaceId) {
            // Cast to Tool to avoid deep type instantiation issues with AI SDK generics
            baseTools.load_skill = createLoadSkillTool(workspaceId) as Tool;
          }

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
            prepareResult,
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
          const messages: CoreMessage[] | undefined =
            images.length > 0
              ? [{ role: "user", content: [{ type: "text", text: contextPrompt }, ...images] }]
              : undefined;

          let result = await this.options.llmProvider.call({
            agentId: llmAgentId,
            model: action.model,
            prompt: contextPrompt,
            messages,
            tools,
            toolChoice: "auto", // Let LLM decide when to stop calling tools
            stopOnToolCall: completeToolInjected ? ["complete", "failStep"] : ["failStep"],
          });

          // Check for adapter-level errors (network, API, etc.)
          if (!result.ok) {
            throw new Error(`LLM call failed: ${result.error.reason}`);
          }

          // Emit tool events for UI visibility
          this.emitToolEvents(result, action, sig, currentState);

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

          // Validate output if validator provided
          if (this.options.validateOutput) {
            const trace = buildLLMActionTrace(result, action.model, contextPrompt);

            const validation = await this.options.validateOutput(trace);
            // Note: If validator throws, error propagates and aborts the action (fail-closed)

            if (!validation.valid) {
              logger.warn("LLM action failed validation, retrying with feedback", {
                state: currentState,
                model: action.model,
                feedback: validation.feedback,
              });

              const retryPrompt =
                `${contextPrompt}\n\n` +
                `<validation-feedback>\n${
                  validation.feedback ?? "Output failed validation."
                }\n</validation-feedback>\n` +
                `IMPORTANT: Use only data from tool results. If you cannot comply, call failStep.`;

              // Rebuild messages with retry prompt, preserving image parts from the original call
              const retryMessages: CoreMessage[] | undefined =
                images.length > 0
                  ? [{ role: "user", content: [{ type: "text", text: retryPrompt }, ...images] }]
                  : undefined;

              result = await this.options.llmProvider.call({
                agentId: llmAgentId,
                model: action.model,
                prompt: retryPrompt,
                messages: retryMessages,
                tools,
                toolChoice: "auto", // Let LLM decide when to stop calling tools
                stopOnToolCall: completeToolInjected ? ["complete", "failStep"] : ["failStep"],
              });

              // Check for adapter-level errors on retry
              if (!result.ok) {
                throw new Error(`LLM call failed on retry: ${result.error.reason}`);
              }

              // Emit tool events for UI visibility (retry call)
              this.emitToolEvents(result, action, sig, currentState);

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

              const retryValidation = await this.options.validateOutput(retryTrace);

              if (!retryValidation.valid) {
                logger.error("LLM action failed validation after retry", {
                  state: currentState,
                  model: action.model,
                  feedback: retryValidation.feedback,
                });
                throw new Error(
                  `LLM action failed validation after retry: ${
                    retryValidation.feedback ?? "no feedback"
                  }`,
                );
              }

              logger.info("LLM action passed validation on retry", {
                state: currentState,
                model: action.model,
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
            if (results && dataToStore) {
              const parsed = z.record(z.string(), z.unknown()).safeParse(dataToStore);
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
            const toolCalls = (result.toolCalls ?? []).map((tc) => ({
              toolName: tc.toolName,
              args: tc.input,
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

          logger.debug("LLM action completed", { model: action.model, outputTo: action.outputTo });
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
          });

          // Build context for agent execution
          const agentContext: Context = {
            documents: Array.from(documents.values()),
            state: currentState,
            results: Object.fromEntries(resultsMap),
            ...(prepareResult ? { input: prepareResult } : {}),
            emit: context.emit,
            updateDoc: this.makeUpdateDocFn(documents),
            createDoc: this.makeCreateDocFn(documents, currentState),
            deleteDoc: this.makeDeleteDocFn(documents, currentState),
          };

          // Execute agent via callback, passing full action object for prompt access
          // Agent returns AgentResult envelope directly
          const result = await this.options.agentExecutor(action, agentContext, sig);

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

    return codeActionResult;
  }

  /**
   * Get a meaningful identifier for an action based on its type
   */
  private getActionId(action: Action): string | undefined {
    switch (action.type) {
      case "agent":
        return action.agentId;
      case "code":
        return action.function;
      case "emit":
        return action.event;
      case "llm":
        return action.outputTo;
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

  private async buildContextPrompt(
    basePrompt: string,
    prepareResult?: PrepareResult,
    skills: SkillSummary[] = [],
  ): Promise<{ prompt: string; images: ImagePart[] }> {
    // Ground the LLM temporally at invocation time
    const factsSection = buildTemporalFacts();

    let prompt = `${factsSection}\n\n${basePrompt}`;
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

    // Append available skills if any exist
    if (skills.length > 0) {
      prompt = `${prompt}\n\n${formatAvailableSkills(skills)}`;
    }

    return { prompt, images };
  }

  /**
   * Build AI SDK Tool objects for LLM action
   * FSM tools: JSONSchema → Zod → Tool (one conversion)
   * MCP tools: Already Tool objects (pass through)
   */
  private async buildTools(toolNames: string[], context: Context): Promise<Record<string, Tool>> {
    const tools: Record<string, Tool> = {};

    const fsmToolNames = toolNames.filter((name) => this._definition.tools?.[name]);
    const mcpServerIds = toolNames.filter((name) => !this._definition.tools?.[name]);

    // FSM tools: compile code, wrap in Tool
    for (const toolName of fsmToolNames) {
      const toolDef = this._definition.tools?.[toolName];
      if (!toolDef) {
        throw new Error(`Tool ${toolName} not found in FSM definition`);
      }
      const raw: Record<string, unknown> = toolDef.inputSchema;
      const zodSchema = z.fromJSONSchema(raw);

      tools[toolName] = {
        description: toolDef.description,
        inputSchema: zodSchema,
        execute: (args) =>
          this._toolExecutor.execute(toolDef.code, toolName, context, {
            type: "__tool__",
            data: args,
          }),
      };
    }

    // MCP tools: always fetch when provider available (includes ambient platform tools)
    // GlobalMCPToolProvider auto-includes atlas-platform for webfetch/artifacts even with empty serverIds
    if (this.options.mcpToolProvider) {
      const mcpTools = await this.options.mcpToolProvider.getToolsForServers(mcpServerIds);
      Object.assign(tools, mcpTools);
    }

    return tools;
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

  /**
   * Clear all documents from memory
   * Used when workspace needs to start fresh for each signal
   */
  clearDocuments(): void {
    this._documents.clear();
    logger.debug("Cleared all documents from FSM engine", { fsmId: this._definition.id });
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

  stop(): void {
    // No-op: Workers are terminated after each call, no cleanup needed
  }

  /**
   * Reset FSM to initial state without re-initialization
   * Clears all runtime state (signals, events) and returns to initial state
   * Re-runs idle state entry actions to allow selective document cleanup
   * Used when workspace needs to start fresh for trigger signals
   */
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

      // Persist any document changes from entry actions
      await this.persistDocuments();
    }

    logger.debug("FSM reset to initial state", {
      fsmId: this._definition.id,
      initialState: this._currentState,
    });
  }
}
