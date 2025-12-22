/**
 * FSMBuilder - Fluent API for building FSM definitions
 *
 * Features:
 * - Error collection (doesn't throw, accumulates errors)
 * - Forgiving API (addState() auto-exits previous context)
 * - Function name normalization (kebab-case → snake_case)
 * - Build-time validation
 */

import type { Action, FSMDefinition, JSONSchema, StateDefinition } from "../fsm-engine/mod.ts";
import type {
  BuildError,
  FunctionConfig,
  Result,
  StateConfig,
  TransitionConfig,
  TransitionDefinition,
} from "./types.ts";

export class FSMBuilder {
  private readonly id: string;
  private initial?: string;
  private states = new Map<string, StateConfig>();
  private functions = new Map<string, FunctionConfig>();
  private documentTypes = new Map<string, JSONSchema>();
  private errors: BuildError[] = [];

  // Context tracking for fluent interface
  private currentState?: StateConfig;
  private currentTransition?: TransitionConfig;

  constructor(id: string) {
    this.id = id;
  }

  // ============================================================
  // State Management
  // ============================================================

  /**
   * Set the initial state for the FSM
   */
  setInitialState(stateName: string): this {
    this.initial = stateName;
    return this;
  }

  /**
   * Add a new state to the FSM
   * Auto-exits previous state context (forgiving API)
   */
  addState(name: string): this {
    if (this.states.has(name)) {
      this.errors.push({
        type: "duplicate_state",
        message: `State '${name}' already defined`,
        context: { stateName: name },
      });
      return this;
    }

    // Auto-exit previous context (forgiving API design)
    this.currentState = { name, entry: [], on: {} };
    this.currentTransition = undefined;

    this.states.set(name, this.currentState);
    return this;
  }

  /**
   * Explicitly exit state context
   * Optional - addState() will auto-exit, but available for explicit style
   */
  endState(): this {
    this.currentState = undefined;
    this.currentTransition = undefined;
    return this;
  }

  /**
   * Mark current state as final
   */
  final(): this {
    if (!this.currentState) {
      this.errors.push({
        type: "no_state_context",
        message: "final() called without addState() context",
      });
      return this;
    }

    this.currentState.final = true;
    return this;
  }

  // ============================================================
  // Entry Actions
  // ============================================================

  /**
   * Add entry action to current state
   */
  onEntry(action: Action): this {
    if (!this.currentState) {
      this.errors.push({
        type: "no_state_context",
        message: "onEntry() called without addState() context",
      });
      return this;
    }

    this.currentState.entry.push(action);
    return this;
  }

  // ============================================================
  // Transitions
  // ============================================================

  /**
   * Add transition from current state on event
   * Enters transition context for withGuard/withAction
   */
  onTransition(event: string, target: string): this {
    if (!this.currentState) {
      this.errors.push({
        type: "no_state_context",
        message: "onTransition() called without addState() context",
      });
      return this;
    }

    // Exit previous transition context if any
    this.currentTransition = { target, guards: [], actions: [] };
    this.currentState.on[event] = this.currentTransition;
    return this;
  }

  /**
   * Add guard to current transition
   */
  withGuard(guardName: string): this {
    if (!this.currentTransition) {
      this.errors.push({
        type: "no_transition_context",
        message: "withGuard() called without onTransition() context",
      });
      return this;
    }

    this.currentTransition.guards.push(guardName);
    return this;
  }

  /**
   * Add action to current transition
   */
  withAction(action: Action): this {
    if (!this.currentTransition) {
      this.errors.push({
        type: "no_transition_context",
        message: "withAction() called without onTransition() context",
      });
      return this;
    }

    this.currentTransition.actions.push(action);
    return this;
  }

  // ============================================================
  // Functions & Document Types
  // ============================================================

  /**
   * Add function definition to FSM
   * Automatically normalizes name to snake_case (replaces hyphens with underscores)
   */
  addFunction(name: string, type: "action" | "guard", code: string): this {
    // Normalize name to valid JS identifier (kebab-case → snake_case)
    const normalized = name.replace(/-/g, "_");

    if (this.functions.has(normalized)) {
      this.errors.push({
        type: "duplicate_function",
        message: `Function '${normalized}' already defined`,
        context: { functionName: normalized, originalName: name },
      });
      return this;
    }

    this.functions.set(normalized, { type, code });
    return this;
  }

  /**
   * Add document type schema to FSM
   */
  addDocumentType(name: string, schema: JSONSchema): this {
    if (this.documentTypes.has(name)) {
      this.errors.push({
        type: "duplicate_document_type",
        message: `Document type '${name}' already defined`,
        context: { typeName: name },
      });
      return this;
    }

    this.documentTypes.set(name, schema);
    return this;
  }

  // ============================================================
  // Build
  // ============================================================

  /**
   * Build and validate FSM definition
   * Returns Result with either FSMDefinition or array of BuildErrors
   */
  build(): Result<FSMDefinition, BuildError[]> {
    // Return accumulated errors first
    if (this.errors.length > 0) {
      return { success: false, error: this.errors };
    }

    // Validate initial state
    if (!this.initial) {
      return {
        success: false,
        error: [
          {
            type: "missing_initial",
            message: "Initial state not set. Call setInitialState() before build().",
          },
        ],
      };
    }

    if (!this.states.has(this.initial)) {
      return {
        success: false,
        error: [
          {
            type: "invalid_initial",
            message: `Initial state '${this.initial}' not defined. Add this state with addState().`,
            context: { initialState: this.initial },
          },
        ],
      };
    }

    // Validate state references in transitions
    const validationErrors: BuildError[] = [];

    for (const [stateName, state] of this.states) {
      for (const [event, transition] of Object.entries(state.on)) {
        if (!this.states.has(transition.target)) {
          validationErrors.push({
            type: "invalid_state_reference",
            message: `State '${stateName}' has transition on '${event}' to undefined state '${transition.target}'`,
            context: { stateName, event, targetState: transition.target },
          });
        }

        // Validate guard references
        for (const guard of transition.guards) {
          if (!this.functions.has(guard)) {
            validationErrors.push({
              type: "invalid_guard_reference",
              message: `State '${stateName}' transition on '${event}' references undefined guard '${guard}'`,
              context: { stateName, event, guardName: guard },
            });
          } else if (this.functions.get(guard)?.type !== "guard") {
            validationErrors.push({
              type: "invalid_guard_reference",
              message: `State '${stateName}' transition on '${event}' references '${guard}' which is an action, not a guard`,
              context: { stateName, event, guardName: guard },
            });
          }
        }
      }

      // Validate function references in entry actions
      for (const action of state.entry) {
        if (action.type === "code") {
          const funcName = action.function;
          if (!this.functions.has(funcName)) {
            validationErrors.push({
              type: "invalid_function_reference",
              message: `State '${stateName}' entry action references undefined function '${funcName}'`,
              context: { stateName, functionName: funcName },
            });
          } else if (this.functions.get(funcName)?.type !== "action") {
            validationErrors.push({
              type: "invalid_function_reference",
              message: `State '${stateName}' entry action references '${funcName}' which is a guard, not an action`,
              context: { stateName, functionName: funcName },
            });
          }
        }
      }
    }

    if (validationErrors.length > 0) {
      return { success: false, error: validationErrors };
    }

    // Convert internal representation to FSMDefinition
    const states: Record<string, StateDefinition> = {};

    for (const [name, config] of this.states) {
      const state: StateDefinition = {};

      // Add entry actions if present
      if (config.entry.length > 0) {
        state.entry = config.entry;
      }

      // Add transitions if present
      if (Object.keys(config.on).length > 0) {
        state.on = {};
        for (const [event, transition] of Object.entries(config.on)) {
          const transitionDef: TransitionDefinition = { target: transition.target };

          // Only include guards/actions if they exist (avoid undefined for YAML serialization)
          if (transition.guards.length > 0) {
            transitionDef.guards = transition.guards;
          }
          if (transition.actions.length > 0) {
            transitionDef.actions = transition.actions;
          }

          state.on[event] = transitionDef;
        }
      }

      // Mark as final if needed
      if (config.final) {
        state.type = "final";
      }

      states[name] = state;
    }

    // Convert functions Map to Record
    const functions: Record<string, { type: "action" | "guard"; code: string }> = {};
    for (const [name, func] of this.functions) {
      functions[name] = { type: func.type, code: func.code };
    }

    // Convert document types Map to Record
    const documentTypes: Record<string, JSONSchema> = {};
    for (const [name, schema] of this.documentTypes) {
      documentTypes[name] = schema;
    }

    return {
      success: true,
      value: {
        id: this.id,
        initial: this.initial,
        states,
        functions,
        documentTypes,
        tools: {}, // Empty tools for now
      },
    };
  }
}
