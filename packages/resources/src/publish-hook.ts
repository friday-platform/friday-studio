import type { ActivityStorageAdapter } from "@atlas/activity";
import { generateResourceActivityTitle } from "@atlas/activity/title-generator";
import type { ResourceStorageAdapter } from "@atlas/ledger";
import { logger } from "@atlas/logger";

export interface PublishDirtyDraftsContext {
  jobId?: string;
  activityStorage?: ActivityStorageAdapter;
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
    if (context?.activityStorage && published.length > 0) {
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
            userId: null,
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
    logger.warn("Auto-publish failed for workspace", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
