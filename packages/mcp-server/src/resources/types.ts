/**
 * Shared types for MCP resources
 */

import type { Logger } from "../platform-server.ts";

/**
 * Context provided to all resource handlers
 */
export interface ResourceContext {
  logger: Logger;
}
