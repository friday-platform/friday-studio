/**
 * FSMEngine - FSM execution engine using code-based guards and actions
 *
 * Executes FSMDefinition with TypeScript code for guards and actions.
 * Guards and actions are executed via dynamic import from code strings.
 */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import type { Tool } from "ai";
import { z } from "zod";
import type { DocumentScope, DocumentStore } from "../document-store/node.ts";
import { FSMDocumentDataSchema } from "./document-schemas.ts";
import { jsonSchemaToZod, validateJSONSchema } from "./json-schema-to-zod.ts";
import * as serializer from "./serializer.ts";
import type {
  Action,
  ActionFunction,
  Context,
  Document,
  EmittedEvent,
  FSMDefinition,
  GuardFunction,
  LLMProvider,
  Signal,
  SignalWithContext,
  TransitionDefinition,
} from "./types.ts";

const FSMStateSchema = z.object({ state: z.string() });

/**
 * Agent execution result interface
 * Matches AgentResult from @atlas/agent-sdk
 */
export interface AgentResult {
  agentId: string;
  task: string;
  input: unknown;
  output: unknown;
  reasoning?: string;
  error?: string;
  duration: number;
  timestamp?: string;
}

/**
 * Agent executor callback type
 * Integrates FSM agent actions with external agent orchestration systems
 *
 * @param agentId - The ID of the agent to execute
 * @param context - FSM context with documents, state, and utility functions
 * @param signal - Signal with context (sessionId, workspaceId, onEvent callback)
 */
export type AgentExecutor = (
  agentId: string,
  context: Context,
  signal: SignalWithContext,
) => Promise<AgentResult>;

export interface FSMEngineOptions {
  llmProvider?: LLMProvider;
  documentStore: DocumentStore;
  scope: DocumentScope;
  agentExecutor?: AgentExecutor;
  mcpToolProvider?: import("./mcp-tool-context.ts").MCPToolProvider;
}

export class FSMEngine {
  private _currentState: string;
  private _documents = new Map<string, Document>();
  private _signalQueue: SignalWithContext[] = [];
  private _processing = false;
  private _initialized = false;
  private _recursionDepth = 0;
  private _compiledSchemas = new Map<string, z.ZodType>();
  private _emittedEvents: EmittedEvent[] = [];
  private _guardFunctions = new Map<string, GuardFunction>();
  private _actionFunctions = new Map<string, ActionFunction>();
  private static readonly MAX_RECURSION_DEPTH = 10;
  private static readonly MAX_PROCESSED_SIGNALS = 100;
  private _processedSignalsCount = 0;

  constructor(
    private definition: FSMDefinition,
    private options: FSMEngineOptions,
  ) {
    this._currentState = definition.initial;

    // Documents will be loaded in initialize() to avoid race condition
    // between definition and persistent storage
  }

  async initialize(): Promise<void> {
    if (this._initialized) {
      throw new Error("FSMEngine already initialized");
    }

    // Load saved state
    const storedState = await this.options.documentStore.loadState(
      this.options.scope,
      this.definition.id,
    );

    let stateRestored = false;

    if (storedState) {
      const result = FSMStateSchema.safeParse(storedState);
      if (result.success) {
        if (this.definition.states[result.data.state]) {
          this._currentState = result.data.state;
          stateRestored = true;
          logger.debug(`Restored state: ${this._currentState}`);
        } else {
          logger.warn(
            `Stored state "${result.data.state}" not found in definition. Resetting to initial.`,
          );
        }
      }
    }

    // Compile document type schemas
    if (this.definition.documentTypes) {
      for (const [typeName, jsonSchema] of Object.entries(this.definition.documentTypes)) {
        try {
          validateJSONSchema(jsonSchema, `documentTypes.${typeName}`);
          const zodSchema = jsonSchemaToZod(jsonSchema);
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
    if (this.definition.functions) {
      for (const [name, func] of Object.entries(this.definition.functions)) {
        try {
          if (func.type === "guard") {
            const compiled = await this.compileFunctionCode<GuardFunction>(func.code, name);
            this._guardFunctions.set(name, compiled);
          } else {
            const compiled = await this.compileFunctionCode<ActionFunction>(func.code, name);
            this._actionFunctions.set(name, compiled);
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
    const stored = await this.options.documentStore.list(this.options.scope, this.definition.id);

    if (stored.length > 0) {
      // FSM has been run before - restore from persistent storage
      logger.debug(`Restoring ${stored.length} documents from storage`);
      for (const id of stored) {
        const doc = await this.options.documentStore.read(
          this.options.scope,
          this.definition.id,
          id,
          FSMDocumentDataSchema,
        );
        if (doc) {
          const docType = doc.data.type;
          const docData = doc.data.data;
          this.validateDocumentData(docType, docData, id);
          this._documents.set(id, { id, type: docType, data: docData });
        }
      }
    } else if (!stateRestored) {
      // First run - initialize from FSM definition
      logger.debug("No stored documents found, initializing from FSM definition");
      const initialState = this.definition.states[this._currentState];
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

  /**
   * Compile function code string to executable function
   * Uses dynamic import with Blob URL for code execution (supports UTF-8)
   */
  private async compileFunctionCode<
    T = (context: Context, event: Signal, ...args: unknown[]) => unknown,
  >(code: string, name: string): Promise<T> {
    // Wrap code in module format if it's not already
    const moduleCode = code.includes("export default") ? code : `export default ${code}`;

    // Create Blob URL for dynamic import (handles UTF-8 correctly, unlike btoa)
    const blob = new Blob([moduleCode], { type: "text/javascript" });
    const blobUrl = URL.createObjectURL(blob);

    try {
      const module = await import(blobUrl);
      if (!module.default || typeof module.default !== "function") {
        throw new Error(`Function "${name}" must export a default function`);
      }
      return module.default as T;
    } catch (error) {
      throw new Error(`Failed to compile function "${name}": ${stringifyError(error)}`);
    } finally {
      // Clean up Blob URL to prevent memory leaks
      URL.revokeObjectURL(blobUrl);
    }
  }

  async signal(
    sig: Signal,
    context?: {
      sessionId: string;
      workspaceId: string;
      onEvent?: (event: import("./types.ts").FSMEvent) => void;
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

    const state = this.definition.states[this._currentState];
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
        const guardFn = this._guardFunctions.get(guardName);
        if (!guardFn) {
          throw new Error(`Guard function "${guardName}" not found`);
        }

        try {
          const passed = guardFn(this.context, sig);
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
        );
      }

      // Transition to new state
      const previousState = pendingState;
      pendingState = selectedTransition.target;

      logger.debug(`FSM transitioned: ${previousState} -> ${pendingState}`, { event: sig.type });

      // Initialize documents for new state if they don't exist
      const newStateDefinition = this.definition.states[pendingState];
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
        );

        logger.debug("Entry actions completed for state", { state: pendingState });
      }

      // COMMIT PHASE
      // 1. Commit documents
      this._documents = pendingDocuments;
      // 2. Commit state
      this._currentState = pendingState;
      // 3. Commit events
      this._emittedEvents = pendingEvents;
      // 4. Commit signals (enqueue them)
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
            jobName: this.definition.id,
            fromState: previousState,
            toState: pendingState,
            triggeringSignal: sig.type,
            timestamp: Date.now(),
          },
        });
      }
    } catch (error) {
      logger.error(`FSM error in state ${this._currentState}, signal ${sig.type}`, { error });
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
  ): Promise<void> {
    this._recursionDepth++;
    if (this._recursionDepth > FSMEngine.MAX_RECURSION_DEPTH) {
      throw new Error(
        `Maximum recursion depth (${FSMEngine.MAX_RECURSION_DEPTH}) exceeded. ` +
          "Possible infinite loop in signal emissions.",
      );
    }

    try {
      for (const action of actions) {
        await this.executeAction(action, sig, documents, events, signals, currentState);
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
  ): Promise<void> {
    const actionStartTime = Date.now();

    // Emit action started event
    if (sig._context?.onEvent) {
      sig._context.onEvent({
        type: "data-fsm-action-execution",
        data: {
          sessionId: sig._context.sessionId,
          workspaceId: sig._context.workspaceId,
          jobName: this.definition.id,
          actionType: action.type,
          actionId:
            action.type === "agent"
              ? action.agentId
              : action.type === "code"
                ? action.function
                : undefined,
          state: currentState,
          status: "started",
          timestamp: actionStartTime,
        },
      });
    }

    // Create a context bound to the pending documents/signals
    const context: Context = {
      documents: Array.from(documents.values()),
      state: currentState,
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

    switch (action.type) {
      case "code": {
        const actionFn = this._actionFunctions.get(action.function);
        if (!actionFn) {
          throw new Error(`Action function "${action.function}" not found`);
        }

        logger.debug("Executing code action", {
          function: action.function,
          state: currentState,
          signalType: sig.type,
        });

        try {
          await actionFn(context, sig);
          logger.debug("Code action completed", { function: action.function, state: currentState });
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

        const contextPrompt = this.buildContextPrompt(action.prompt, documents);
        const tools = action.tools ? await this.buildTools(action.tools, context) : undefined;

        const response = await this.options.llmProvider.call({
          model: action.model,
          prompt: contextPrompt,
          tools,
        });

        if (action.outputTo) {
          const outputDoc = documents.get(action.outputTo);
          if (outputDoc) {
            outputDoc.data = { ...outputDoc.data, ...response.data, content: response.content };
          } else {
            documents.set(action.outputTo, {
              id: action.outputTo,
              type: "LLMResult",
              data: { ...response.data, content: response.content },
            });
          }
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
          emit: context.emit,
          updateDoc: (id: string, data: Record<string, unknown>) => {
            const doc = documents.get(id);
            if (doc) {
              doc.data = { ...doc.data, ...data };
            }
          },
          createDoc: (doc: Document) => {
            documents.set(doc.id, doc);
          },
          deleteDoc: (id: string) => {
            documents.delete(id);
          },
        };

        // Execute agent via callback, passing signal context
        const result = await this.options.agentExecutor(action.agentId, agentContext, sig);

        if (result.error) {
          throw new Error(`Agent ${action.agentId} failed: ${result.error}`);
        }

        // Store result in document if outputTo specified
        if (action.outputTo && result.output) {
          const parsed = z.record(z.string(), z.unknown()).safeParse(result.output);
          const data = parsed.success ? parsed.data : { value: result.output };
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
          duration: result.duration,
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
          jobName: this.definition.id,
          actionType: action.type,
          actionId:
            action.type === "agent"
              ? action.agentId
              : action.type === "code"
                ? action.function
                : undefined,
          state: currentState,
          status: "completed",
          duration: Date.now() - actionStartTime,
          timestamp: Date.now(),
        },
      });
    }
  }

  private buildContextPrompt(
    basePrompt: string,
    documents: Map<string, Document> = this._documents,
  ): string {
    // Inject document context into prompt
    const docs = Array.from(documents.values());
    if (docs.length === 0) {
      return basePrompt;
    }

    const docsContext = docs
      .map((doc) => `Document ${doc.id} (${doc.type}): ${JSON.stringify(doc.data, null, 2)}`)
      .join("\n\n");

    return `${basePrompt}\n\nAvailable Documents:\n${docsContext}`;
  }

  /**
   * Build AI SDK Tool objects for LLM action
   * FSM tools: JSONSchema → Zod → Tool (one conversion)
   * MCP tools: Already Tool objects (pass through)
   */
  private async buildTools(toolNames: string[], context: Context): Promise<Record<string, Tool>> {
    const tools: Record<string, Tool> = {};

    const fsmToolNames = toolNames.filter((name) => this.definition.tools?.[name]);
    const mcpServerIds = toolNames.filter((name) => !this.definition.tools?.[name]);

    // FSM tools: compile code, wrap in Tool
    for (const toolName of fsmToolNames) {
      const toolDef = this.definition.tools?.[toolName];
      if (!toolDef) {
        throw new Error(`Tool ${toolName} not found in FSM definition`);
      }
      const zodSchema = jsonSchemaToZod(toolDef.inputSchema);
      const toolFn = await this.compileFunctionCode(toolDef.code, toolName);

      tools[toolName] = {
        description: toolDef.description,
        inputSchema: zodSchema,
        execute: (args) => toolFn(context, { type: "__tool__", data: args }),
      };
    }

    // MCP tools: already Tool objects, just merge
    if (mcpServerIds.length > 0 && this.options.mcpToolProvider) {
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
      if (this.definition.documentTypes) {
        const availableTypes = Object.keys(this.definition.documentTypes).join(", ");
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
    await this.options.documentStore.saveState(this.options.scope, this.definition.id, {
      state: this._currentState,
    });
  }

  private async persistDocuments(): Promise<void> {
    for (const doc of this._documents.values()) {
      await this.options.documentStore.write(
        this.options.scope,
        this.definition.id,
        doc.id,
        { type: doc.type, data: doc.data },
        FSMDocumentDataSchema,
      );
    }
  }

  get state(): string {
    return this._currentState;
  }

  get documents(): Document[] {
    return Array.from(this._documents.values());
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
    logger.debug("Cleared all documents from FSM engine", { fsmId: this.definition.id });
  }

  get context(): Context {
    return {
      documents: this.documents,
      state: this._currentState,
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
    // No-op (no worker to stop yet)
  }

  /**
   * Reset FSM to initial state without re-initialization
   * Clears all runtime state (signals, events) and returns to initial state
   * Re-runs idle state entry actions to allow selective document cleanup
   * Used when workspace needs to start fresh for trigger signals
   */
  async reset(): Promise<void> {
    this._currentState = this.definition.initial;

    // DON'T clear documents - let idle state entry actions decide what to clean
    this._signalQueue = [];
    this._emittedEvents = [];
    this._recursionDepth = 0;
    this._processedSignalsCount = 0;
    this._processing = false;

    // Re-run idle entry actions (like initialize() does)
    const initialState = this.definition.states[this._currentState];
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
      fsmId: this.definition.id,
      initialState: this._currentState,
    });
  }
}
