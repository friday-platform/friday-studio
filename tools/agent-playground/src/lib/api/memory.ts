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

export const CorpusMetadataSchema = z.object({
  name: z.string(),
  kind: z.enum(["narrative", "retrieval", "dedup", "kv"]),
  workspaceId: z.string(),
});

export type CorpusMetadata = z.infer<typeof CorpusMetadataSchema>;

const NarrativeCorpusResponseSchema = z.array(NarrativeEntrySchema);

const CorpusListResponseSchema = z.array(CorpusMetadataSchema);

/**
 * Default workspace list when the daemon's list-workspaces-with-memory route
 * (GET /api/memory) doesn't exist. Override via VITE_KNOWN_WORKSPACES env var
 * (comma-separated). Treat the env value as unknown and validate via Zod
 * rather than casting (no `as` per CLAUDE.md hard rule).
 */
export const KNOWN_WORKSPACES: string[] = (() => {
  const envValue: unknown =
    typeof import.meta !== "undefined" && import.meta.env
      ? import.meta.env.VITE_KNOWN_WORKSPACES
      : undefined;
  const parsed = z.string().safeParse(envValue);
  if (parsed.success) return parsed.data.split(",").map((s) => s.trim()).filter(Boolean);
  return ["salted_granola"];
})();

/**
 * Fallback memories to surface when the daemon's list-memories endpoint
 * (GET /api/memory/{wsId}) doesn't exist. Each entry is a (workspaceId,
 * memoryName, kind) tuple of memories we know exist by convention. Lets the
 * viewer drill into known memories before the daemon gains a discovery API.
 */
const KNOWN_MEMORIES: ReadonlyArray<{
  workspaceId: string;
  name: string;
  kind: CorpusMetadata["kind"];
}> = [
  { workspaceId: "salted_granola", name: "autopilot-backlog", kind: "narrative" },
];

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

export type CorpusKind = CorpusMetadata["kind"];

export function parseEntryMeta(entry: NarrativeEntry): EntryMeta {
  if (!entry.metadata) return {};
  const parsed = EntryMetaSchema.safeParse(entry.metadata);
  return parsed.success ? parsed.data : {};
}

export async function fetchWorkspacesWithMemory(): Promise<string[]> {
  try {
    const res = await globalThis.fetch(`${PROXY_BASE}/api/memory`);
    if (!res.ok) return KNOWN_WORKSPACES;
    const data: unknown = await res.json();
    const parsed = z.array(z.string()).safeParse(data);
    return parsed.success && parsed.data.length > 0
      ? parsed.data
      : KNOWN_WORKSPACES;
  } catch {
    return KNOWN_WORKSPACES;
  }
}

export async function fetchMemories(
  workspaceId: string,
): Promise<CorpusMetadata[]> {
  try {
    const res = await globalThis.fetch(
      `${PROXY_BASE}/api/memory/${encodeURIComponent(workspaceId)}`,
    );
    if (!res.ok) {
      // List-memories endpoint missing — fall back to KNOWN_MEMORIES so the
      // user can still drill into memories we know exist by convention.
      return KNOWN_MEMORIES.filter((c) => c.workspaceId === workspaceId).map((c) => ({
        workspaceId: c.workspaceId,
        name: c.name,
        kind: c.kind,
      }));
    }
    const data: unknown = await res.json();
    return CorpusListResponseSchema.parse(data);
  } catch {
    return KNOWN_MEMORIES.filter((c) => c.workspaceId === workspaceId).map((c) => ({
      workspaceId: c.workspaceId,
      name: c.name,
      kind: c.kind,
    }));
  }
}

export async function fetchNarrativeCorpus(
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
  return NarrativeCorpusResponseSchema.parse(data);
}
