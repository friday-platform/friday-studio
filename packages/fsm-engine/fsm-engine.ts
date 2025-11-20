/**
 * FSMEngine - FSM execution engine using code-based guards and actions
 *
 * Executes FSMDefinition with TypeScript code for guards and actions.
 * Guards and actions are executed via dynamic import from code strings.
 */

import type { DocumentScope, DocumentStore } from "@atlas/document-store";
import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { z } from "zod";
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
  TransitionDefinition,
} from "./types.ts";

const FSMStateSchema = z.object({ state: z.string() });

export interface FSMEngineOptions {
  llmProvider?: LLMProvider;
  documentStore: DocumentStore;
  scope: DocumentScope;
}

export class FSMEngine {
  private _currentState: string;
  private _documents = new Map<string, Document>();
  private _signalQueue: Signal[] = [];
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
          const docType = doc.data.type as string;
          const docData = doc.data.data as Record<string, unknown>;
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
        await this.executeActions(
          initialState.entry,
          { type: "__init__" },
          this._documents,
          this._emittedEvents,
          this._signalQueue,
          this._currentState,
        );
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
   * Uses dynamic import with data URL for code execution
   */
  private async compileFunctionCode<
    T = (context: Context, event: Signal, ...args: unknown[]) => unknown,
  >(code: string, name: string): Promise<T> {
    // Wrap code in module format if it's not already
    const moduleCode = code.includes("export default") ? code : `export default ${code}`;

    // Create data URL for dynamic import
    const dataUrl = `data:text/javascript;base64,${btoa(moduleCode)}`;

    try {
      const module = await import(dataUrl);
      if (!module.default || typeof module.default !== "function") {
        throw new Error(`Function "${name}" must export a default function`);
      }
      return module.default as T;
    } catch (error) {
      throw new Error(`Failed to compile function "${name}": ${stringifyError(error)}`);
    }
  }

  async signal(sig: Signal): Promise<void> {
    this._signalQueue.push(sig);
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

  private async processSingleSignal(sig: Signal): Promise<void> {
    const state = this.definition.states[this._currentState];
    if (!state) throw new Error(`Invalid state: ${this._currentState}`);

    if (!state.on || !state.on[sig.type]) {
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
        await this.executeActions(
          newStateDefinition.entry,
          sig,
          pendingDocuments,
          pendingEvents,
          pendingSignals,
          pendingState,
        );
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
    } catch (error) {
      logger.error(`FSM error in state ${this._currentState}, signal ${sig.type}`, { error });
      throw error;
    }
  }

  private async executeActions(
    actions: Action[],
    sig: Signal,
    documents: Map<string, Document>,
    events: EmittedEvent[],
    signals: Signal[],
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
    sig: Signal,
    documents: Map<string, Document>,
    events: EmittedEvent[],
    signals: Signal[],
    currentState: string,
  ): Promise<void> {
    // Create a context bound to the pending documents/signals
    const context: Context = {
      documents: Array.from(documents.values()),
      state: currentState,
      emit: (s: Signal) => {
        signals.push(s);
        return Promise.resolve();
      },
      updateDoc: this.makeUpdateDocFn(documents),
      createDoc: this.makeCreateDocFn(documents, currentState),
    };

    switch (action.type) {
      case "code": {
        const actionFn = this._actionFunctions.get(action.function);
        if (!actionFn) {
          throw new Error(`Action function "${action.function}" not found`);
        }

        try {
          await actionFn(context, sig, context.updateDoc);
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

        // Build context prompt with documents
        const contextPrompt = this.buildContextPrompt(action.prompt, documents);

        // Get tool executors if tools are specified
        const toolExecutors = action.tools
          ? await this.buildToolExecutors(action.tools)
          : undefined;

        const response = await this.options.llmProvider.call({
          model: action.model,
          prompt: contextPrompt,
          tools: action.tools
            ? action.tools.map((toolName) => {
                const tool = this.definition.tools?.[toolName];
                if (!tool) {
                  throw new Error(`Tool "${toolName}" not found in FSM definition`);
                }
                return {
                  name: toolName,
                  description: tool.description,
                  input_schema: tool.inputSchema as Record<string, unknown>,
                };
              })
            : undefined,
          toolExecutors,
        });

        // Store result in document if outputTo is specified
        if (action.outputTo) {
          const outputDoc = documents.get(action.outputTo);
          if (outputDoc) {
            outputDoc.data = { ...outputDoc.data, ...response.data, content: response.content };
          } else {
            // Create new document for output
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
        // Agent execution is handled externally via orchestrator
        // This is a placeholder that will be filled in when integrated with Atlas
        logger.warn("Agent action not yet integrated with Atlas orchestrator", {
          agentId: action.agentId,
        });

        // Create placeholder result document
        if (action.outputTo) {
          documents.set(action.outputTo, {
            id: action.outputTo,
            type: "AgentResult",
            data: { agentId: action.agentId, status: "pending" },
          });
        }
        break;
      }

      default: {
        const exhaustive: never = action;
        throw new Error(`Unknown action type: ${(exhaustive as Action).type}`);
      }
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

  private async buildToolExecutors(
    toolNames: string[],
  ): Promise<
    Record<string, (args: Record<string, unknown>, context: Context) => Promise<unknown>>
  > {
    const executors: Record<
      string,
      (args: Record<string, unknown>, context: Context) => Promise<unknown>
    > = {};

    for (const toolName of toolNames) {
      const tool = this.definition.tools?.[toolName];
      if (!tool) {
        throw new Error(`Tool "${toolName}" not found in FSM definition`);
      }

      // Compile tool code
      const toolFn = await this.compileFunctionCode(tool.code, toolName);
      executors[toolName] = async (args: Record<string, unknown>, context: Context) => {
        return await toolFn(context, { type: "__tool__", data: args });
      };
    }

    return executors;
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

  get context(): Context {
    return {
      documents: this.documents,
      state: this._currentState,
      emit: (s: Signal) => this.signal(s),
      updateDoc: this.makeUpdateDocFn(),
      createDoc: this.makeCreateDocFn(),
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
}
