/**
 * User agents discovery for the playground.
 *
 * Discovers registered NATS-subprocess agents from ~/.atlas/agents/ via the UserAdapter.
 */

import { join } from "node:path";
import type { AgentSummary } from "@atlas/core/agent-loader";
import { UserAdapter } from "@atlas/core/agent-loader";
import { getFridayHome } from "@atlas/utils/paths.server";

const AGENTS_DIR = join(getFridayHome(), "agents");

/** List registered user agents from disk. Re-scans on every call (no caching). */
export function listUserAgents(): Promise<AgentSummary[]> {
  const adapter = new UserAdapter(AGENTS_DIR);
  return adapter.listAgents();
}

/** Check if a registered user agent exists by ID */
export function userAgentExists(id: string): Promise<boolean> {
  const adapter = new UserAdapter(AGENTS_DIR);
  return adapter.exists(id);
}
