/**
 * Query option factories for artifact metadata + content.
 *
 * Why this exists: the chat UI mounts N `<ArtifactCard>`s per turn
 * (one per `[attachment lifted...]` marker plus one per `display_artifact`
 * tool call). Without caching, every card fires its own
 * `fetch /api/daemon/api/artifacts/<id>` on mount. Heavy delegations
 * produce 30+ unique artifact IDs *and* the same id often appears in
 * more than one tool call — without dedup the browser exhausts its
 * per-origin connection budget and surfaces `ERR_INSUFFICIENT_RESOURCES`.
 *
 * `byId` returns metadata + (for small artifacts) inline contents.
 * `content` fetches just the raw bytes for tabular preview when
 * `byId.contents` is undefined.
 *
 * @module
 */

import { queryOptions, skipToken } from "@tanstack/svelte-query";
import { z } from "zod";

export const ArtifactResponseSchema = z.object({
  artifact: z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    data: z.object({
      type: z.literal("file"),
      mimeType: z.string(),
      size: z.number().int().nonnegative(),
      originalName: z.string().optional(),
    }),
  }),
  contents: z.string().optional(),
});

export type ArtifactResponse = z.infer<typeof ArtifactResponseSchema>;

export const artifactQueries = {
  /** Key-only entry for hierarchical invalidation. */
  all: () => ["daemon", "artifacts"] as const,

  /**
   * Metadata for a single artifact, with inline `contents` when the
   * server included them. Pass `null` to disable (via skipToken) —
   * useful while the parent is still streaming an id.
   */
  byId: (artifactId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "artifacts", artifactId] as const,
      queryFn: artifactId
        ? async (): Promise<ArtifactResponse> => {
            const res = await fetch(
              `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}`,
            );
            if (!res.ok) {
              throw new Error(`Failed to load artifact (${res.status})`);
            }
            const raw: unknown = await res.json();
            return ArtifactResponseSchema.parse(raw);
          }
        : skipToken,
      // Artifact bodies are content-addressed (revision-pinned) and
      // therefore immutable — caching aggressively is safe. 5 min is
      // long enough to span a single conversation; the cache evicts on
      // tab close.
      staleTime: 5 * 60 * 1000,
      retry: false,
    }),

  /**
   * Raw text for tabular artifacts that didn't ship inline. Used by
   * the artifact card's table preview when `byId.contents` is empty.
   * Keyed independently of `byId` so the metadata fetch stays light.
   */
  content: (artifactId: string | null) =>
    queryOptions({
      queryKey: ["daemon", "artifacts", artifactId, "content"] as const,
      queryFn: artifactId
        ? async (): Promise<string> => {
            const res = await fetch(
              `/api/daemon/api/artifacts/${encodeURIComponent(artifactId)}/content`,
            );
            if (!res.ok) {
              throw new Error(`Failed to load artifact content (${res.status})`);
            }
            return res.text();
          }
        : skipToken,
      staleTime: 5 * 60 * 1000,
      retry: false,
    }),
};
