import { z } from "zod";

const PROXY_BASE = "/api/daemon";

export const NarrativeEntrySchema = z.object({
  id: z.string(),
  text: z.string(),
  author: z.string().optional(),
  createdAt: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export type NarrativeEntry = z.infer<typeof NarrativeEntrySchema>;

export const StoreMetadataSchema = z.object({
  name: z.string(),
  kind: z.enum(["narrative", "retrieval", "dedup", "kv"]),
  workspaceId: z.string(),
});

export type StoreMetadata = z.infer<typeof StoreMetadataSchema>;

const NarrativeStoreResponseSchema = z.array(NarrativeEntrySchema);

const StoreListResponseSchema = z.array(StoreMetadataSchema);


export const EntryMetaSchema = z.object({
  status: z.enum(["pending", "completed", "blocked"]).optional(),
  // Backlog entries serialize priority as a number (per the autopilot
  // planner's expected shape). Older docs/specs implied string. Accept
  // both and coerce to a display string in the table component.
  priority: z.union([z.number(), z.string()]).optional(),
  kind: z.string().optional(),
  blocked_by: z.array(z.string()).optional(),
});

export type EntryMeta = z.infer<typeof EntryMetaSchema>;

export function parseEntryMeta(entry: NarrativeEntry): EntryMeta {
  if (!entry.metadata) return {};
  const parsed = EntryMetaSchema.safeParse(entry.metadata);
  return parsed.success ? parsed.data : {};
}

export async function fetchWorkspacesWithMemory(): Promise<string[]> {
  const res = await globalThis.fetch(`${PROXY_BASE}/api/memory`);
  if (!res.ok) return [];
  const data: unknown = await res.json();
  const parsed = z.array(z.string()).safeParse(data);
  return parsed.success ? parsed.data : [];
}

export async function fetchMemories(
  workspaceId: string,
): Promise<StoreMetadata[]> {
  const res = await globalThis.fetch(
    `${PROXY_BASE}/api/memory/${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) return [];
  const data: unknown = await res.json();
  return StoreListResponseSchema.parse(data);
}

export async function fetchNarrativeStore(
  workspaceId: string,
  memoryName: string,
): Promise<NarrativeEntry[]> {
  const res = await globalThis.fetch(
    `${PROXY_BASE}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${encodeURIComponent(memoryName)}`,
  );
  if (!res.ok) {
    throw new Error(
      `Failed to fetch memory ${memoryName}: ${res.status}`,
    );
  }
  const data: unknown = await res.json();
  return NarrativeStoreResponseSchema.parse(data);
}
