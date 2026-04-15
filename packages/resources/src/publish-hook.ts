import type { ActivityStorageAdapter } from "@atlas/activity";
import { generateResourceActivityTitle } from "@atlas/activity/title-generator";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import type { PlatformModels } from "@atlas/llm";
import { logger } from "@atlas/logger";

export interface PublishDirtyDraftsContext {
  jobId?: string;
  userId?: string;
  activityStorage?: ActivityStorageAdapter;
  platformModels?: PlatformModels;
}

/**
 * Publishes all dirty resource drafts for a workspace in a single pass.
 * Uses the adapter's `publishAllDirty()` to avoid N+1 HTTP round-trips.
 * Individual failures are logged and swallowed.
 */
export async function publishDirtyDrafts(
  adapter: ResourceStorageAdapter,
  workspaceId: string,
  context?: PublishDirtyDraftsContext,
): Promise<void> {
  try {
    const published = await adapter.publishAllDirty(workspaceId);
    if (published.length > 0) {
      logger.debug("Auto-published dirty drafts", { workspaceId, published: published.length });
    }

    // Create activity items for each published resource
    if (
      context?.activityStorage &&
      context.userId &&
      context.platformModels &&
      published.length > 0
    ) {
      const platformModels = context.platformModels;
      // Look up resource metadata for human-readable names and types
      let metadataBySlug: Map<string, { name: string; type: string }> = new Map();
      try {
        const allResources = await adapter.listResources(workspaceId);
        metadataBySlug = new Map(allResources.map((r) => [r.slug, { name: r.name, type: r.type }]));
      } catch (err) {
        logger.warn("Failed to look up resource metadata for activity titles", {
          workspaceId,
          error: String(err),
        });
      }

      for (const resource of published) {
        try {
          const meta = metadataBySlug.get(resource.slug);
          const title = await generateResourceActivityTitle({
            platformModels,
            resourceName: meta?.name ?? resource.slug,
            resourceSlug: resource.slug,
            resourceType: meta?.type ?? "document",
          });
          await context.activityStorage.create({
            type: "resource",
            source: "agent",
            referenceId: resource.resourceId,
            workspaceId,
            jobId: context.jobId ?? null,
            userId: context.userId,
            title,
          });
        } catch (err) {
          logger.warn("Failed to create resource activity", {
            workspaceId,
            slug: resource.slug,
            error: String(err),
          });
        }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // Connection-refused on the ledger service is the common local-dev case
    // (friday-starter doesn't run a Ledger). Demote to debug so it doesn't
    // dominate the log stream every agent turn.
    const isLocalNoLedger =
      message.includes("Connection refused") ||
      message.includes("ECONNREFUSED") ||
      message.includes("tcp connect error");
    if (isLocalNoLedger) {
      logger.debug("Auto-publish skipped (no ledger service)", { workspaceId });
    } else {
      logger.warn("Auto-publish failed for workspace", { workspaceId, error: message });
    }
  }
}
