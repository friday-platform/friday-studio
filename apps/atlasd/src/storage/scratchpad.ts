/**
 * Scratchpad storage for agent conversations.
 *
 * Agents use this to record notes during reasoning — intermediate
 * results, clarifications from users, observations to remember. Notes
 * persist for the conversation's lifetime; agents call `getNotes`
 * later to recall.
 *
 * **JS-KV-backed since 2026-05-02** — was Deno KV at `~/.atlas/storage.db`
 * with bare-string values and `Deno.openKv` opened directly (skipping
 * the `@atlas/storage/kv` interface). Migration moves entries to the
 * `SCRATCHPAD` JetStream KV bucket through the same `JetStreamKVStorage`
 * adapter every other surface uses; abstraction leak fixed in the same
 * pass.
 *
 * Storage layout:
 *   key   = `["scratchpad", <streamId>, <noteId>]` (noteId = randomUUID)
 *   value = `{ note: string, ts: string (ISO 8601) }`
 *
 * The timestamp moved out of the key into the value because JS KV
 * keys sort lexicographically; numeric ms-timestamps in keys would
 * have needed zero-padding to keep stable order. Cardinality per
 * stream is low (~tens of notes per conversation), so in-JS sort
 * after fetch is cheaper than the encoding contortions.
 *
 * @module scratchpad
 */

import type { KVStorage } from "@atlas/storage/kv";
import { z } from "zod";

export const NoteSchema = z.object({ note: z.string().describe("A note to track") });

export type Note = z.infer<typeof NoteSchema>;

const StoredNoteSchema = z.object({ note: z.string(), ts: z.iso.datetime() });
type StoredNote = z.infer<typeof StoredNoteSchema>;

let storage: KVStorage | null = null;

/**
 * Wire scratchpad to a JS-KV-backed `KVStorage` instance. Daemon
 * calls this once at startup. Subsequent `appendNote` / `getNotes`
 * calls go through the configured backend.
 */
export function initScratchpadStorage(s: KVStorage): void {
  storage = s;
}

function requireStorage(): KVStorage {
  if (!storage) {
    throw new Error(
      "Scratchpad storage not initialized — call initScratchpadStorage(storage) at daemon startup",
    );
  }
  return storage;
}

export async function appendNote(streamId: string, note: string): Promise<void> {
  const s = requireStorage();
  const noteId = crypto.randomUUID();
  const stored: StoredNote = { note, ts: new Date().toISOString() };
  await s.set(["scratchpad", streamId, noteId], stored);
}

export async function getNotes(streamId: string, limit = 100): Promise<Note[]> {
  const s = requireStorage();
  const collected: StoredNote[] = [];
  for await (const { value } of s.list<unknown>(["scratchpad", streamId])) {
    const parsed = StoredNoteSchema.safeParse(value);
    if (parsed.success) collected.push(parsed.data);
    // Skip malformed entries silently — operator can clean up via
    // `nats kv del SCRATCHPAD <key>` if needed.
  }
  // Sort by timestamp (oldest first); slice to limit.
  collected.sort((a, b) => a.ts.localeCompare(b.ts));
  return collected.slice(0, limit).map((n) => ({ note: n.note }));
}
