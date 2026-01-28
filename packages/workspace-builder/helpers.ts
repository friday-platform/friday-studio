/**
 * Helper functions for creating actions with cleaner syntax
 */

import type { Action } from "../fsm-engine/mod.ts";

/**
 * Create a code action that calls a function
 *
 * @example
 * builder.onEntry(codeAction('initialize_workflow'))
 */
export function codeAction(functionName: string): Action {
  return { type: "code", function: functionName };
}

/**
 * Create an agent action
 *
 * @example
 * builder.onEntry(agentAction('quality-checker', { outputTo: 'quality_result' }))
 * builder.onEntry(agentAction('claude-code', { prompt: 'Implement the feature' }))
 */
export function agentAction(
  agentId: string,
  opts?: { outputTo?: string; prompt?: string },
): Action {
  const action: Action = { type: "agent", agentId };
  if (opts?.outputTo !== undefined) {
    action.outputTo = opts.outputTo;
  }
  if (opts?.prompt !== undefined) {
    action.prompt = opts.prompt;
  }
  return action;
}

/**
 * Create an LLM action
 *
 * @example
 * builder.onEntry(llmAction({
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-5',
 *   prompt: 'Analyze the data',
 *   tools: ['github.get_pr'],
 *   outputTo: 'analysis_result',
 *   outputType: 'AnalysisResult'
 * }))
 */
export function llmAction(opts: {
  provider: string;
  model: string;
  prompt: string;
  tools?: string[];
  outputTo?: string;
  /** Document type name for schema lookup (enables structured output via complete tool) */
  outputType?: string;
}): Action {
  const action: Action = {
    type: "llm",
    provider: opts.provider,
    model: opts.model,
    prompt: opts.prompt,
  };
  if (opts.tools !== undefined) {
    action.tools = opts.tools;
  }
  if (opts.outputTo !== undefined) {
    action.outputTo = opts.outputTo;
  }
  if (opts.outputType !== undefined) {
    action.outputType = opts.outputType;
  }
  return action;
}

/**
 * Create an emit action that triggers an event
 *
 * @example
 * builder.onEntry(emitAction('ADVANCE'))
 * builder.onEntry(emitAction('COMPLETE', { result: 'success' }))
 */
export function emitAction(event: string, data?: Record<string, unknown>): Action {
  const action: Action = { type: "emit", event };
  if (data !== undefined) {
    action.data = data;
  }
  return action;
}
