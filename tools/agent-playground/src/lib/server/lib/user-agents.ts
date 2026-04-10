/**
 * User agents discovery for the playground.
 *
 * Discovers user-built WASM agents from ~/.atlas/agents/ via the UserAdapter.
 * Replaces the previous hardcoded proto import.
 */

import { join } from "node:path";
import type { AgentSummary } from "@atlas/core/agent-loader";
import { UserAdapter } from "@atlas/core/agent-loader";
import { getAtlasHome } from "@atlas/utils/paths.server";

const adapter = new UserAdapter(join(getAtlasHome(), "agents"));

/** List user-built agents from disk. Re-scans on every call (no caching). */
export function listUserAgents(): Promise<AgentSummary[]> {
  return adapter.listAgents();
}

/** Check if a user agent exists by ID */
export function userAgentExists(id: string): Promise<boolean> {
  return adapter.exists(id);
}
