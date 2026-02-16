/**
 * Extract planned execution steps from an FSM definition by traversing
 * the state graph. Pure function — depends only on the definition.
 *
 * @module planned-steps
 */

import type { FSMDefinition } from "@atlas/fsm-engine";

export type PlannedStep = { agentName: string; actionType: "agent" | "llm" };

/**
 * Traverse the FSM definition graph from its initial state, collecting
 * agent and LLM entry actions in traversal order.
 *
 * Follows `ADVANCE` signal handlers when present, otherwise the first
 * signal key in the state's `on` map. Stops at final states or when a
 * cycle is detected.
 *
 * @param definition - The immutable FSM graph definition
 * @returns Ordered list of planned agent/LLM steps
 */
export function extractPlannedSteps(definition: FSMDefinition): PlannedStep[] {
  const steps: PlannedStep[] = [];
  const visited = new Set<string>();
  let currentStateName = definition.initial;

  while (currentStateName) {
    if (visited.has(currentStateName)) break;
    visited.add(currentStateName);

    const state = definition.states[currentStateName];
    if (!state) break;

    // Collect agent/llm entry actions from this state
    if (state.entry) {
      for (const action of state.entry) {
        if (action.type === "agent") {
          steps.push({ agentName: action.agentId, actionType: "agent" });
        } else if (action.type === "llm" && action.outputTo) {
          steps.push({ agentName: action.outputTo, actionType: "llm" });
        }
      }
    }

    // Stop at final states
    if (state.type === "final") break;

    // Follow transition to next state
    const on = state.on;
    if (!on) break;

    // Prefer ADVANCE signal, fall back to first key
    const signalKey = on.ADVANCE ? "ADVANCE" : Object.keys(on)[0];
    if (!signalKey) break;

    const transition = on[signalKey];
    if (!transition) break;

    // For array-valued transitions (guarded), take first element's target
    const target = Array.isArray(transition) ? transition[0]?.target : transition.target;
    if (!target) break;

    currentStateName = target;
  }

  return steps;
}
