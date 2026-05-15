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
import { discardBody, stringifyError } from "@atlas/utils";
import { z } from "zod";
import type { ArtifactSummary } from "../artifacts/model.ts";
import { ArtifactStorage } from "../artifacts/storage.ts";
import { composePreface } from "./compose-preface.ts";

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
      if (!listRes.ok) {
        await discardBody(listRes);
        return [];
      }

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
            if (!res.ok) {
              await discardBody(res);
              return null;
            }
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

/**
 * Maximum artifacts surfaced per session into the retrieval-gated injection
 * envelope. Bounds the prompt cost — long-running FSM jobs can produce dozens
 * of intermediate artifacts; the LLM only needs the most recent few to
 * orient. Anything older it can `parse_artifact` for on demand.
 *
 * Phase 9 default. A future per-workspace knob can override it; today the
 * cap is a constant to keep injection bounded.
 */
export const ARTIFACT_INJECTION_LIMIT = 10;

/**
 * Build retrieval-gated `<retrieved_content>` envelopes for recent artifacts
 * bound to the current chat or FSM session. Phase 9.
 *
 * Each emitted block has the eval-described shape:
 *
 *   <retrieved_content
 *     provenance="artifact:<id>"
 *     origin="workspace:<wsId>/session:<sId>"
 *     fetched_at="<iso>">
 *   <summary text>
 *   </retrieved_content>
 *
 * Scope semantics (user decision 2026-05-05):
 *   - **chat path** — `chatId` is set; lists via `ArtifactStorage.listByChat`.
 *     The chat tools persist artifacts with `chatId`, so chat-session scope
 *     is "all artifacts that share this chatId".
 *   - **FSM path** — `sessionId` is set, `chatId` undefined; lists via
 *     `ArtifactStorage.listBySession`. The runtime tags ephemeral FSM
 *     artifacts with `lifecycle.boundTo.sessionId`, so session scope is
 *     "all artifacts whose ephemeral binding matches this sessionId".
 *
 * Returns `[]` when there are no artifacts, when storage isn't initialized
 * (unit-test environments), or when the underlying call fails — never
 * throws. Bounded at {@link ARTIFACT_INJECTION_LIMIT} entries by default.
 *
 * The block carries the artifact's **summary** plus its `id` (via
 * `provenance`), not the full content. The LLM can call `parse_artifact`
 * to expand any reference it needs.
 */
export async function composeArtifactBlocks(
  input: { workspaceId: string; sessionId?: string; chatId?: string; limit?: number },
  logger: Logger,
): Promise<string[]> {
  const limit = input.limit ?? ARTIFACT_INJECTION_LIMIT;
  if (!input.chatId && !input.sessionId) return [];

  let artifacts: ArtifactSummary[] = [];
  try {
    if (input.chatId) {
      const result = await ArtifactStorage.listByChat({
        chatId: input.chatId,
        limit,
        includeData: false,
      });
      if (!result.ok) {
        logger.warn("listByChat failed in composeArtifactBlocks", {
          chatId: input.chatId,
          error: result.error,
        });
        return [];
      }
      artifacts = result.data;
    } else if (input.sessionId) {
      const result = await ArtifactStorage.listBySession({
        sessionId: input.sessionId,
        limit,
        includeData: false,
      });
      if (!result.ok) {
        logger.warn("listBySession failed in composeArtifactBlocks", {
          sessionId: input.sessionId,
          error: result.error,
        });
        return [];
      }
      artifacts = result.data;
    }
  } catch (err) {
    // Storage might not be initialized in some unit-test paths. Treat as
    // "no artifacts" rather than blocking the action.
    logger.warn("composeArtifactBlocks: artifact storage unavailable", {
      error: stringifyError(err),
    });
    return [];
  }

  if (artifacts.length === 0) return [];

  // Already sorted desc by createdAt in the adapter; honour the cap here too
  // so callers passing a custom limit get exactly that many.
  const trimmed = artifacts.slice(0, limit);
  const fetchedAt = new Date().toISOString();
  const scopeId = input.sessionId ?? input.chatId ?? "";

  return trimmed.map((a) => {
    const provenance = `artifact:${a.id}`;
    const origin = `workspace:${input.workspaceId}/session:${scopeId}`;
    // The summary is the LLM-facing one-liner; carries the gist without the
    // bytes. The artifact id is in `provenance` so the model can call
    // `parse_artifact` for the full content if it needs more.
    const body = a.summary.trim();
    return composePreface([{ source: provenance, origin, body, fetched_at: fetchedAt }]);
  });
}
