/**
 * User agents discovery for the playground.
 *
 * Discovers user-built WASM agents from ~/.atlas/agents/ via the UserAdapter.
 * Replaces the previous hardcoded proto import.
 */

import { join } from "node:path";
import process from "node:process";
import type { AgentSummary } from "@atlas/core/agent-loader";
import { UserAdapter } from "@atlas/core/agent-loader";
import { getFridayHome } from "@atlas/utils/paths.server";

function resolveAgentSourceDir(): string {
  return process.env.AGENT_SOURCE_DIR ?? join(getFridayHome(), "agents");
}

/** List user-built agents from disk. Re-scans on every call (no caching). */
export function listUserAgents(): Promise<AgentSummary[]> {
  const adapter = new UserAdapter(resolveAgentSourceDir());
  return adapter.listAgents();
}

/** Check if a user agent exists by ID */
export function userAgentExists(id: string): Promise<boolean> {
  const adapter = new UserAdapter(resolveAgentSourceDir());
  return adapter.exists(id);
}
