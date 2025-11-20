/**
 * FSM Definition Validator
 *
 * Validates FSM definitions against constraints before execution.
 * Returns detailed validation results with actionable error messages.
 */

import type { FSMDefinition } from "./types.ts";

/**
 * Complete validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Validate FSM definition against all constraints
 */
export function validateFSMStructure(fsm: FSMDefinition): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check initial state exists
  if (!fsm.states[fsm.initial]) {
    errors.push(
      `No initial state defined. Fix: Set "initial" field to a valid state name (e.g., "initial": "idle").`,
    );
  }

  // Check for final state
  const hasFinalState = Object.values(fsm.states).some((s) => s.type === "final");
  if (!hasFinalState) {
    errors.push(
      `No final state defined. Fix: Add at least one state with 'type: "final"' (e.g., "done": {"type": "final"}).`,
    );
  }

  // Check reachability
  const { unreachable } = checkReachability(fsm);
  if (unreachable.length > 0) {
    errors.push(
      `Unreachable states: ${unreachable.join(", ")}. ` +
        `Fix: Add transitions from other states to these states, or remove them if not needed.`,
    );
  }

  // Check all transition targets exist
  for (const [stateName, state] of Object.entries(fsm.states)) {
    if (state.on) {
      for (const [event, transitionsOrSingle] of Object.entries(state.on)) {
        const transitions = Array.isArray(transitionsOrSingle)
          ? transitionsOrSingle
          : [transitionsOrSingle];

        for (const transition of transitions) {
          if (!fsm.states[transition.target]) {
            errors.push(
              `Invalid transition in state "${stateName}" on event "${event}": target "${transition.target}" does not exist. ` +
                `Fix: Either add state "${transition.target}" to states object, or change the transition target to an existing state.`,
            );
          }

          // Check guard references
          if (transition.guards) {
            for (const guardName of transition.guards) {
              if (!fsm.functions || !fsm.functions[guardName]) {
                errors.push(
                  `State "${stateName}" transition references undefined guard "${guardName}". ` +
                    `Fix: Add function "${guardName}" to functions object with type: "guard" and code.`,
                );
              } else if (fsm.functions[guardName]?.type !== "guard") {
                errors.push(
                  `State "${stateName}" transition references "${guardName}" but it is not a guard function. ` +
                    `Fix: Set function "${guardName}" type to "guard".`,
                );
              }
            }
          }

          // Check action references for code actions
          if (transition.actions) {
            for (const action of transition.actions) {
              if (action.type === "code") {
                const functionName = (action as { function: string }).function;
                if (!fsm.functions || !fsm.functions[functionName]) {
                  errors.push(
                    `State "${stateName}" transition references undefined action function "${functionName}". ` +
                      `Fix: Add function "${functionName}" to functions object with type: "action" and code.`,
                  );
                } else if (fsm.functions[functionName]?.type !== "action") {
                  errors.push(
                    `State "${stateName}" transition references "${functionName}" but it is not an action function. ` +
                      `Fix: Set function "${functionName}" type to "action".`,
                  );
                }
              }
            }
          }
        }
      }
    }
  }

  // Check for stuck states (non-final states with no transitions)
  const stuckStates: string[] = [];
  for (const [stateName, state] of Object.entries(fsm.states)) {
    if (state.type !== "final" && (!state.on || Object.keys(state.on).length === 0)) {
      stuckStates.push(stateName);
    }
  }

  if (stuckStates.length > 0) {
    errors.push(
      `States with no outgoing transitions: ${stuckStates.join(", ")}. ` +
        `Fix: Add transitions from these states, or mark them as final with 'type: "final"' if they are terminal states.`,
    );
  }

  // Check document types referenced in states
  const referencedTypes = new Set<string>();
  for (const state of Object.values(fsm.states)) {
    if (state.documents) {
      for (const doc of state.documents) {
        referencedTypes.add(doc.type);
      }
    }
  }

  if (fsm.documentTypes) {
    for (const typeName of referencedTypes) {
      if (!fsm.documentTypes[typeName]) {
        errors.push(
          `Document type "${typeName}" is referenced but not defined in documentTypes. ` +
            `Fix: Add "${typeName}" to documentTypes with a JSON Schema definition.`,
        );
      }
    }
  } else if (referencedTypes.size > 0) {
    warnings.push(
      `Document types are referenced but documentTypes is not defined. Consider adding documentTypes for validation.`,
    );
  }

  // Check function code is not empty
  if (fsm.functions) {
    for (const [name, func] of Object.entries(fsm.functions)) {
      if (!func.code || func.code.trim().length === 0) {
        errors.push(`Function "${name}" has empty code. Fix: Add function implementation code.`);
      }
    }
  }

  // Check tool code is not empty
  if (fsm.tools) {
    for (const [name, tool] of Object.entries(fsm.tools)) {
      if (!tool.code || tool.code.trim().length === 0) {
        errors.push(`Tool "${name}" has empty code. Fix: Add tool implementation code.`);
      }
    }
  }

  // Warnings for error handling
  const hasAgentActions = Object.values(fsm.states).some(
    (state) =>
      state.on &&
      Object.values(state.on).some((t) => {
        const transitions = Array.isArray(t) ? t : [t];
        return transitions.some((tr) => tr.actions?.some((a) => a.type === "agent"));
      }),
  );

  if (hasAgentActions) {
    warnings.push(
      "Agent actions detected but no AGENT_FAILED event handling found. Consider adding error handling transitions.",
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Check reachability via BFS
 */
function checkReachability(fsm: FSMDefinition): { reachable: Set<string>; unreachable: string[] } {
  const visited = new Set<string>();
  const queue = [fsm.initial];

  while (queue.length > 0) {
    const state = queue.shift();
    if (!state || visited.has(state)) continue;
    visited.add(state);

    const stateObj = fsm.states[state];
    if (!stateObj || !stateObj.on) continue;

    for (const transitionsOrSingle of Object.values(stateObj.on)) {
      const transitions = Array.isArray(transitionsOrSingle)
        ? transitionsOrSingle
        : [transitionsOrSingle];

      for (const trans of transitions) {
        if (!visited.has(trans.target)) {
          queue.push(trans.target);
        }
      }
    }
  }

  const allStates = Object.keys(fsm.states);
  const unreachable = allStates.filter((s) => !visited.has(s));

  return { reachable: visited, unreachable };
}
