import type { ResourceStorageAdapter } from "@atlas/ledger";
import { logger } from "@atlas/logger";

/**
 * Publishes all dirty resource drafts for a workspace in a single pass.
 * Uses the adapter's `publishAllDirty()` to avoid N+1 HTTP round-trips.
 * Individual failures are logged and swallowed.
 */
export async function publishDirtyDrafts(
  adapter: ResourceStorageAdapter,
  workspaceId: string,
): Promise<void> {
  try {
    const published = await adapter.publishAllDirty(workspaceId);
    if (published > 0) {
      logger.debug("Auto-published dirty drafts", { workspaceId, published });
    }
  } catch (error) {
    logger.warn("Auto-publish failed for workspace", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
