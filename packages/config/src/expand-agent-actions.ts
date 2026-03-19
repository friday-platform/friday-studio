/**
 * Expands workspace agent references in FSM definitions at load time.
 * Pure function — returns a new object without mutating the input.
 *
 * @module
 */

import type { Action, FSMDefinition, LLMAction, StateDefinition } from "@atlas/fsm-engine";
import type { WorkspaceAgentConfig } from "./agents.ts";

/**
 * Expand `type: agent` entry actions in a parsed FSM definition.
 *
 * LLM workspace agents become `type: llm` with provider/model/tools.
 * Atlas, system, and unknown agents pass through unchanged.
 */
export function expandAgentActions(
  fsmDefinition: FSMDefinition,
  workspaceAgents: Record<string, WorkspaceAgentConfig>,
): FSMDefinition {
  const expandedStates: Record<string, StateDefinition> = {};

  for (const [stateId, state] of Object.entries(fsmDefinition.states)) {
    if (!state.entry || state.entry.length === 0) {
      expandedStates[stateId] = { ...state };
      continue;
    }

    expandedStates[stateId] = {
      ...state,
      entry: state.entry.map((action) => expandAction(action, workspaceAgents)),
    };
  }

  return { ...fsmDefinition, states: expandedStates };
}

/** Expand a single action if it's an LLM workspace agent reference. */
function expandAction(
  action: Action,
  workspaceAgents: Record<string, WorkspaceAgentConfig>,
): Action {
  if (action.type !== "agent") return action;

  const agentConfig = workspaceAgents[action.agentId];
  if (!agentConfig || agentConfig.type !== "llm") return action;

  const { config } = agentConfig;
  const prompt = action.prompt ? `${config.prompt}\n\n${action.prompt}` : config.prompt;

  const expanded: LLMAction = {
    type: "llm",
    provider: config.provider,
    model: config.model,
    prompt,
    tools: config.tools,
  };
  if (action.outputTo !== undefined) expanded.outputTo = action.outputTo;
  if (action.outputType !== undefined) expanded.outputType = action.outputType;

  return expanded;
}
