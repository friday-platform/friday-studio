/**
 * Session History Storage facade.
 *
 * Local-only since the Cortex variant was deleted 2026-05-02 (speculative
 * remote backend, never reached). All consumers import this facade.
 *
 * @module
 */

import { join } from "node:path";
import process from "node:process";
import { createLogger } from "@atlas/logger";
import { getFridayHome } from "@atlas/utils/paths.server";
import { LocalSessionHistoryAdapter } from "./local-session-history-adapter.ts";
import type { SessionHistoryAdapter } from "./session-history-adapter.ts";

const logger = createLogger({ component: "session-history-storage" });

const localDir = process.env.SESSION_STORAGE_PATH || join(getFridayHome(), "sessions-v2");
logger.info("Using LocalSessionHistoryAdapter", { localDir });
const adapter: SessionHistoryAdapter = new LocalSessionHistoryAdapter(localDir);

/**
 * Session history storage facade. Delegates to the local adapter.
 */
export const SessionHistoryStorage: SessionHistoryAdapter = {
  appendEvent: (sessionId, event) => adapter.appendEvent(sessionId, event),
  save: (sessionId, events, summary) => adapter.save(sessionId, events, summary),
  get: (sessionId) => adapter.get(sessionId),
  listByWorkspace: (workspaceId) => adapter.listByWorkspace(workspaceId),
  markInterruptedSessions: () => adapter.markInterruptedSessions(),
};
