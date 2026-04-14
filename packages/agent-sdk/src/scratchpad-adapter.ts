/**
 * Scratchpad Adapter Interface
 *
 * Session-scoped reasoning state. Default backend is an in-memory ring
 * buffer — ephemeral scratchpad should never hit disk in the common case.
 * Opt-in md backend for debuggability.
 *
 * From parity plan v6, lines 653-667.
 */

import { z } from "zod";
import type { NarrativeEntry } from "./memory-adapter.ts";

// ── Zod schemas ─────────────────────────────────────────────────────────────

export const ScratchpadChunkSchema = z.object({
  id: z.string(),
  kind: z.string(),
  body: z.string(),
  createdAt: z.string(),
});

// ── TypeScript types ────────────────────────────────────────────────────────

export interface ScratchpadChunk {
  id: string;
  kind: string;
  body: string;
  createdAt: string;
}

export interface ScratchpadAdapter {
  append(sessionKey: string, chunk: ScratchpadChunk): Promise<void>;
  read(sessionKey: string, opts?: { since?: string }): Promise<ScratchpadChunk[]>;
  clear(sessionKey: string): Promise<void>;
  /** Promote a chunk into a narrative corpus. Agent-gated by config. */
  promote(
    sessionKey: string,
    chunkId: string,
    target: { workspaceId: string; corpus: string },
  ): Promise<NarrativeEntry>;
}
