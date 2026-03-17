/**
 * Resolves a workspace agent key to the runtime agent ID the orchestrator needs.
 *
 * Pure function — maps workspace agent configs to their underlying runtime IDs.
 * Atlas and system agents carry an `agent` field pointing to the runtime ID.
 * Unknown/missing configs pass through for backward compatibility.
 *
 * @module
 */

import type { WorkspaceAgentConfig } from "./agents.ts";

/**
 * Resolve a workspace agent key to the runtime agent ID.
 *
 * @param agentConfig - Workspace agent config, or undefined if no matching agent
 * @param agentId - The workspace agent key (or direct runtime ID for legacy workspaces)
 * @returns The runtime agent ID for the orchestrator
 */
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
  // LLM agents pass through — expansion should have converted them before
  // reaching the executor. Callers can log if this is unexpected.
  return agentId;
}
