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

import { getAtlasHome } from "@atlas/utils/paths.server";
import { join } from "@std/path";
import { z } from "zod";

export const NoteSchema = z.object({ note: z.string().describe("A note to track") });

export type Note = z.infer<typeof NoteSchema>;

const kvPath = join(getAtlasHome(), "storage.db");

export async function appendNote(streamId: string, note: string): Promise<void> {
  using db = await Deno.openKv(kvPath);
  const timestamp = Date.now();
  const key = ["scratchpad", streamId, timestamp];
  await db.set(key, note);
}

export async function getNotes(streamId: string, limit = 100): Promise<Note[]> {
  using db = await Deno.openKv(kvPath);
  const prefix = ["scratchpad", streamId];
  const notes: Note[] = [];

  const iter = db.list<string>({ prefix }, { limit });
  for await (const entry of iter) {
    notes.push({ note: entry.value });
  }

  return notes;
}
