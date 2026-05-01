/**
 * Shared types for MCP resources
 */

import type { Logger } from "@atlas/logger";

/**
 * Context provided to all resource handlers
 */
export interface ResourceContext {
  logger: Logger;
}
