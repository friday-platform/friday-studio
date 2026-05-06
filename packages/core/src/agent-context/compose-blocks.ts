/**
 * Shared composition helpers for agent contexts (chat + FSM).
 *
 * Lives in `@atlas/core` so both `workspace-chat` (a bundled SDK agent)
 * and `@atlas/fsm-engine` (the FSM action runtime) can consume the same
 * implementation without one importing from the other. Layering rule:
 * fsm-engine cannot import from workspace-chat, so the canonical version
 * of this composition lives here.
 */

import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { z } from "zod";

const MemoryListSchema = z.array(
  z.object({ workspaceId: z.string(), name: z.string(), kind: z.string() }),
);

const NarrativeEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
});

/**
 * Build XML-wrapped memory blocks for a workspace (and optional foreground
 * workspaces). Each emitted block has the shape:
 *
 *   <memory workspace="<wsId>" store="<storeName>">
 *   - entry text
 *   - entry text
 *   </memory>
 *
 * Reads up to 20 most-recent entries per narrative store via the daemon
 * HTTP API. Stores that resolve to the same `(sourceWorkspace, name)`
 * pair via mounts/foreground are deduplicated. Failures fall through to
 * "no block for that workspace" — never throws.
 *
 * The chat supervisor calls this with `(primaryWorkspaceId, foregroundIds)`
 * to build the system prompt's memory section. FSM `type: llm` actions
 * call this with `(workspaceId, [])` to mirror the chat behavior at
 * action-start.
 */
export async function composeMemoryBlocks(
  primaryId: string,
  foregroundIds: string[],
  logger: Logger,
): Promise<string[]> {
  const daemonUrl = getAtlasDaemonUrl();
  const allIds = [primaryId, ...foregroundIds];
  const blocks: string[] = [];

  // Track which (source workspace, store name) pairs have already been emitted
  // so that mounts and explicit foreground IDs pointing to the same store don't
  // produce duplicate blocks.
  const emittedStoreKeys = new Set<string>();

  const results = await Promise.allSettled(
    allIds.map(async (workspaceId) => {
      const listRes = await fetch(`${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}`);
      if (!listRes.ok) return [];

      const listData = MemoryListSchema.safeParse(await listRes.json());
      if (!listData.success || listData.data.length === 0) return [];

      const narrativeStores = listData.data.filter((m) => m.kind === "narrative");
      if (narrativeStores.length === 0) return [];

      // Group stores by their source workspace. Own stores have
      // store.workspaceId === workspaceId; mounted stores point elsewhere.
      const bySource = new Map<string, z.infer<typeof MemoryListSchema>[number][]>();
      for (const store of narrativeStores) {
        const src = store.workspaceId;
        const existing = bySource.get(src) ?? [];
        existing.push(store);
        bySource.set(src, existing);
      }

      const wsBlocks: string[] = [];
      for (const [sourceId, stores] of bySource) {
        const storeResults = await Promise.allSettled(
          stores.map(async (store) => {
            const key = `${sourceId}:${store.name}`;
            if (emittedStoreKeys.has(key)) return null;
            emittedStoreKeys.add(key);

            const url = `${daemonUrl}/api/memory/${encodeURIComponent(
              store.workspaceId,
            )}/narrative/${encodeURIComponent(store.name)}?limit=20`;
            const res = await fetch(url);
            if (!res.ok) return null;
            const data = z.array(NarrativeEntrySchema).safeParse(await res.json());
            const entries = data.success ? data.data : [];
            if (entries.length === 0) return null;

            const lines = entries.map((e) => `- ${e.text}`);
            return `<memory workspace="${sourceId}" store="${store.name}">\n${lines.join(
              "\n",
            )}\n</memory>`;
          }),
        );

        for (const r of storeResults) {
          if (r.status === "fulfilled" && r.value !== null) {
            wsBlocks.push(r.value);
          }
        }
      }

      return wsBlocks;
    }),
  );

  for (const [i, result] of results.entries()) {
    if (result.status === "fulfilled") {
      blocks.push(...result.value);
    } else if (result.status === "rejected") {
      logger.warn("Failed to fetch memory for workspace", {
        workspaceId: allIds[i],
        error: result.reason,
      });
    }
  }

  return blocks;
}
