/**
 * Resolves a workspace agent key to the runtime agent ID the orchestrator needs.
 * Atlas/system agents map via `agent` field; others pass through.
 *
 * @module
 */

import type { WorkspaceAgentConfig } from "./agents.ts";

/** Resolve a workspace agent key to the runtime agent ID. */
export function resolveRuntimeAgentId(
  agentConfig: WorkspaceAgentConfig | undefined,
  agentId: string,
): string {
  if (agentConfig?.type === "atlas") {
    return agentConfig.agent;
  }
  if (agentConfig?.type === "system") {
    return agentConfig.agent;
  }
  if (agentConfig?.type === "user") {
    return `user:${agentConfig.agent}`;
  }
  // LLM agents pass through — expansion should have converted them before
  // reaching the executor. Callers can log if this is unexpected.
  return agentId;
}
