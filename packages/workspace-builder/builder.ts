/**
 * Fluent API for building FSM definitions.
 *
 * Accumulates errors instead of throwing. addState() auto-exits previous context.
 * Function names are normalized from kebab-case to snake_case.
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

  private currentState?: StateConfig;
  private currentTransition?: TransitionConfig;

  constructor(id: string) {
    this.id = id;
  }

  setInitialState(stateName: string): this {
    this.initial = stateName;
    return this;
  }

  /** Auto-exits previous state context (forgiving API). */
  addState(name: string): this {
    if (this.states.has(name)) {
      this.errors.push({
        type: "duplicate_state",
        message: `State '${name}' already defined`,
        context: { stateName: name },
      });
      return this;
    }

    this.currentState = { name, entry: [], on: {} };
    this.currentTransition = undefined;

    this.states.set(name, this.currentState);
    return this;
  }

  endState(): this {
    this.currentState = undefined;
    this.currentTransition = undefined;
    return this;
  }

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

  /** Enters transition context for withGuard/withAction. */
  onTransition(event: string, target: string): this {
    if (!this.currentState) {
      this.errors.push({
        type: "no_state_context",
        message: "onTransition() called without addState() context",
      });
      return this;
    }

    this.currentTransition = { target, guards: [], actions: [] };
    this.currentState.on[event] = this.currentTransition;
    return this;
  }

  /** Registers multiple guarded transitions for a single event (conditional branches). */
  onTransitions(event: string, transitions: Array<{ target: string; guards: string[] }>): this {
    if (!this.currentState) {
      this.errors.push({
        type: "no_state_context",
        message: "onTransitions() called without addState() context",
      });
      return this;
    }

    this.currentTransition = undefined;
    this.currentState.on[event] = transitions.map((t) => ({
      target: t.target,
      guards: [...t.guards],
      actions: [],
    }));
    return this;
  }

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

  /** Normalizes name to snake_case (kebab-case hyphens become underscores). */
  addFunction(name: string, type: "action" | "guard", code: string): this {
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

  build(): Result<FSMDefinition, BuildError[]> {
    if (this.errors.length > 0) {
      return { success: false, error: this.errors };
    }

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

    const validationErrors: BuildError[] = [];

    for (const [stateName, state] of this.states) {
      for (const [event, transitionOrArray] of Object.entries(state.on)) {
        const transitions = Array.isArray(transitionOrArray)
          ? transitionOrArray
          : [transitionOrArray];

        for (const transition of transitions) {
          if (!this.states.has(transition.target)) {
            validationErrors.push({
              type: "invalid_state_reference",
              message: `State '${stateName}' has transition on '${event}' to undefined state '${transition.target}'`,
              context: { stateName, event, targetState: transition.target },
            });
          }

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
      }

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

    const states: Record<string, StateDefinition> = {};

    for (const [name, config] of this.states) {
      const state: StateDefinition = {};

      if (config.entry.length > 0) {
        state.entry = config.entry;
      }

      if (Object.keys(config.on).length > 0) {
        state.on = {};
        for (const [event, transitionOrArray] of Object.entries(config.on)) {
          if (Array.isArray(transitionOrArray)) {
            state.on[event] = transitionOrArray.map((t) => {
              const def: TransitionDefinition = { target: t.target };
              if (t.guards.length > 0) def.guards = t.guards;
              if (t.actions.length > 0) def.actions = t.actions;
              return def;
            });
          } else {
            const def: TransitionDefinition = { target: transitionOrArray.target };
            if (transitionOrArray.guards.length > 0) def.guards = transitionOrArray.guards;
            if (transitionOrArray.actions.length > 0) def.actions = transitionOrArray.actions;
            state.on[event] = def;
          }
        }
      }

      if (config.final) {
        state.type = "final";
      }

      states[name] = state;
    }

    const functions: Record<string, { type: "action" | "guard"; code: string }> = {};
    for (const [name, func] of this.functions) {
      functions[name] = { type: func.type, code: func.code };
    }

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
