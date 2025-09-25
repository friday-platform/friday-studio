/**
 * Scratchpad storage for agent conversations.
 *
 * Agents use this to store notes during reasoning - like tracking intermediate
 * results, clarifications from users, or observations they need to remember.
 *
 * Each note is a separate KV entry (key: ["scratchpad", streamId, timestamp])
 * to avoid concurrent write conflicts. Notes persist for the conversation's
 * lifetime and can be recalled by agents as needed.
 *
 * @module scratchpad
 */

import { z } from "zod/v4";

export const NoteSchema = z.object({ note: z.string().describe("A note to track") });

export type Note = z.infer<typeof NoteSchema>;

export async function appendNote(streamId: string, note: string): Promise<void> {
  using db = await Deno.openKv();
  const timestamp = Date.now();
  const key = ["scratchpad", streamId, timestamp];
  await db.set(key, note);
}

export async function getNotes(streamId: string, limit = 100): Promise<Note[]> {
  using db = await Deno.openKv();
  const prefix = ["scratchpad", streamId];
  const notes: Note[] = [];

  const iter = db.list<string>({ prefix }, { limit });
  for await (const entry of iter) {
    notes.push({ note: entry.value });
  }

  return notes;
}
