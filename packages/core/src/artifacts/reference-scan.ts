/**
 * Phase 6.B — promotion-by-reference scan.
 *
 * An ephemeral artifact is promoted to durable when something else in
 * the workspace points at it. The "decide" signal is implicit — the
 * supervisor's choice to remember it (memory_save), or to surface it as
 * a key result (aiSummary.keyDetails url), or the user's choice to view
 * it (display_artifact). No author opt-in required.
 *
 * v1 implementation is naive: substring-match the artifact ID against
 * memory entry text and aiSummary key-detail URLs. The match is wide
 * (includes ID anywhere in the text), which is fine — IDs are UUIDs and
 * coincidental substring collisions in human-readable narrative text
 * are vanishingly unlikely.
 *
 * v2 path: index inbound edges in a KV bucket (`ARTIFACT_REFS`) keyed
 * by artifactId, populated at memory_save / aiSummary write time. That
 * turns this into an O(1) lookup, but is unnecessary at expected
 * cardinality (low thousands of artifacts per workspace, dozens of
 * memory stores).
 *
 * `display_artifact` events are out of scope for v1 — the chat path
 * doesn't emit a queryable trail today. When/if the chat surface
 * publishes display events to a NATS subject, this helper grows a
 * third signal source. Until then, an artifact viewed only via chat
 * UI but never re-referenced will be swept; the user's recourse is to
 * ask the supervisor to remember it (which writes a memory entry,
 * which trips the first signal).
 */

import type { MemoryAdapter } from "@atlas/agent-sdk";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";

const logger = createLogger({ component: "artifact-reference-scan" });

export interface KeyDetailLike {
  url?: string;
}

/**
 * Surface for the aiSummary scan. Returns key-detail entries across
 * sessions in the workspace whose `keyDetails[].url` may reference an
 * artifact ID. Implementations can keep an in-memory snapshot
 * (workspace-runtime side) or hit JetStream (cross-process).
 *
 * Returns an empty array if no scan source is available — caller
 * treats absence-of-source as absence-of-signal (artifact gets swept).
 */
export type AiSummaryProvider = (workspaceId: string) => Promise<KeyDetailLike[]>;

export interface PromotionScanContext {
  /** Memory adapter for the workspace (narrative store reads). */
  memoryAdapter?: MemoryAdapter;
  /** Names of memory stores configured for this workspace. */
  memoryStoreNames: string[];
  /**
   * Optional aiSummary key-details enumerator. When omitted, the
   * aiSummary signal is skipped — sweep falls back to the memory-only
   * path. Wired by the daemon to a snapshot of recent completed
   * sessions (workspace-runtime keeps `completedSessionMetadata`).
   */
  aiSummary?: AiSummaryProvider;
}

/**
 * Returns true if the artifact has any inbound reference signal that
 * promotes it to durable. Lazy: short-circuits on first match.
 *
 * Substring match. Cheap. The artifact ID is a UUIDv4 (per
 * {@link crypto.randomUUID}); collision with arbitrary text is not a
 * realistic concern.
 */
export async function hasPromotionSignal(
  artifactId: string,
  workspaceId: string,
  ctx: PromotionScanContext,
): Promise<boolean> {
  // Signal 1 — memory entry text contains the artifact ID. Walks each
  // configured store and checks every entry. Stops at first hit.
  if (ctx.memoryAdapter && ctx.memoryStoreNames.length > 0) {
    for (const name of ctx.memoryStoreNames) {
      try {
        const store = await ctx.memoryAdapter.store(workspaceId, name);
        const entries = await store.read();
        for (const entry of entries) {
          if (entry.text.includes(artifactId)) return true;
        }
      } catch (err) {
        // One bad store doesn't poison the scan — keep going. The
        // sweeper will retry next tick if a transient failure was
        // masking a real signal.
        logger.warn("Memory store scan failed during promotion check", {
          artifactId,
          workspaceId,
          storeName: name,
          error: stringifyError(err),
        });
      }
    }
  }

  // Signal 2 — aiSummary key-detail URL references the artifact ID.
  // The URL convention isn't formalized; substring match against the
  // raw URL string is the safe baseline (covers `/artifacts/<id>`,
  // `?artifactId=<id>`, and any other shape).
  if (ctx.aiSummary) {
    try {
      const details = await ctx.aiSummary(workspaceId);
      for (const detail of details) {
        if (detail.url && detail.url.includes(artifactId)) return true;
      }
    } catch (err) {
      logger.warn("aiSummary scan failed during promotion check", {
        artifactId,
        workspaceId,
        error: stringifyError(err),
      });
    }
  }

  return false;
}
