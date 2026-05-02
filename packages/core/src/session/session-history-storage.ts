/**
 * Session History Storage facade.
 *
 * Selects the correct adapter at module load based on environment:
 * - CORTEX_URL present → CortexSessionHistoryAdapter
 * - CORTEX_URL absent  → LocalSessionHistoryAdapter (filesystem)
 *
 * All consumers import this facade, not adapters directly.
 *
 * @module
 */

import { join } from "node:path";
import process from "node:process";
import { createLogger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { CortexSessionHistoryAdapter } from "./cortex-session-history-adapter.ts";
import { LocalSessionHistoryAdapter } from "./local-session-history-adapter.ts";
import type { SessionHistoryAdapter } from "./session-history-adapter.ts";

const logger = createLogger({ component: "session-history-storage" });

const DEFAULT_LOCAL_DIR = join(getFridayHome(), "sessions-v2");

function createAdapter(): SessionHistoryAdapter {
  const cortexUrl = process.env.CORTEX_URL;

  if (cortexUrl) {
    logger.info("Using CortexSessionHistoryAdapter", { cortexUrl });
    return new CortexSessionHistoryAdapter(cortexUrl);
  }

  const localDir = process.env.SESSION_STORAGE_PATH || DEFAULT_LOCAL_DIR;
  logger.info("Using LocalSessionHistoryAdapter", { localDir });
  return new LocalSessionHistoryAdapter(localDir);
}

const adapter = createAdapter();

/**
 * Session history storage facade.
 * Delegates to the environment-selected adapter (local or cortex).
 */
export const SessionHistoryStorage: SessionHistoryAdapter = {
  appendEvent: (sessionId, event) => adapter.appendEvent(sessionId, event),
  save: (sessionId, events, summary) => adapter.save(sessionId, events, summary),
  get: (sessionId) => adapter.get(sessionId),
  listByWorkspace: (workspaceId) => adapter.listByWorkspace(workspaceId),
  markInterruptedSessions: () => adapter.markInterruptedSessions(),
};
