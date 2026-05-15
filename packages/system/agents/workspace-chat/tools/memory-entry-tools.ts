/**
 * Memory entry retrieval tools — list / describe over the per-store
 * narrative entries in this workspace.
 *
 * Supersedes the prior `memory_read` tool. The shape adds substring query,
 * since/until time filters, exact-match metadata filters, pagination, and
 * a configurable truncation cap so big stores stay tractable. The
 * companion `describe_memory_entry` returns the full record without the
 * truncation cap — escape hatch for "I need the full text past 500
 * chars".
 *
 * Today Friday only ships the narrative store backend; semantic /
 * retrieval / dedup / kv stores are unwired (`upsert-tools.ts:285`). The
 * `query` parameter therefore does case-insensitive substring matching
 * client-side. A semantic `search_memory_entries` ships when those
 * backends do.
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { discardBody, stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

const ListMemoryEntriesInput = z.object({
  memoryName: z
    .string()
    .min(1)
    .describe(
      "Memory store name. Use list_memory_stores to see which stores this workspace declares.",
    ),
  query: z
    .string()
    .optional()
    .describe("Case-insensitive substring matched against entry text. Optional."),
  since: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp — return entries created at or after this time."),
  until: z
    .string()
    .optional()
    .describe("ISO 8601 timestamp — return entries created before this time."),
  metadata: z
    .record(z.string(), z.string())
    .optional()
    .describe("Exact-match metadata filter — every key/value must match an entry's metadata."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .default(20)
    .optional()
    .describe("Max entries to return after filtering. Defaults to 20, hard cap 200."),
  cursor: z
    .string()
    .optional()
    .describe("Opaque pagination cursor returned as `next_cursor` from a prior call."),
  order: z
    .enum(["newest", "oldest"])
    .default("newest")
    .optional()
    .describe("Sort order. Defaults to newest-first."),
  truncate: z
    .number()
    .int()
    .refine((n) => n >= 1 || n === -1, { message: "truncate must be >= 1, or -1 to disable" })
    .default(500)
    .optional()
    .describe(
      "Max characters per entry's text in the response. Defaults to 500. " +
        "Set to -1 to disable truncation. Truncated entries flag `truncated: true`; " +
        "use describe_memory_entry to fetch the full text for a single id.",
    ),
});

const DescribeMemoryEntryInput = z.object({
  memoryName: z.string().min(1).describe("Memory store name."),
  entryId: z.string().min(1).describe("Entry id from a list_memory_entries result."),
});

interface RawEntry {
  id?: unknown;
  text?: unknown;
  createdAt?: unknown;
  metadata?: unknown;
}

interface MemoryEntry {
  id: string;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
  truncated?: boolean;
}

function normalize(raw: RawEntry): MemoryEntry | null {
  if (typeof raw.id !== "string" || typeof raw.text !== "string") return null;
  const out: MemoryEntry = {
    id: raw.id,
    text: raw.text,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
  };
  if (raw.metadata && typeof raw.metadata === "object") {
    out.metadata = raw.metadata as Record<string, unknown>;
  }
  return out;
}

function metadataMatches(
  entryMeta: Record<string, unknown> | undefined,
  filter: Record<string, string>,
): boolean {
  if (!entryMeta) return false;
  for (const [k, v] of Object.entries(filter)) {
    if (entryMeta[k] !== v) return false;
  }
  return true;
}

function applyFilters(
  entries: MemoryEntry[],
  filters: { query?: string; since?: string; until?: string; metadata?: Record<string, string> },
): MemoryEntry[] {
  let result = entries;
  if (filters.query) {
    const q = filters.query.toLowerCase();
    result = result.filter((e) => e.text.toLowerCase().includes(q));
  }
  if (filters.since) {
    const sinceTs = new Date(filters.since).getTime();
    result = result.filter((e) => {
      const t = new Date(e.createdAt).getTime();
      return Number.isFinite(t) && t >= sinceTs;
    });
  }
  if (filters.until) {
    const untilTs = new Date(filters.until).getTime();
    result = result.filter((e) => {
      const t = new Date(e.createdAt).getTime();
      return Number.isFinite(t) && t < untilTs;
    });
  }
  if (filters.metadata) {
    const f = filters.metadata;
    result = result.filter((e) => metadataMatches(e.metadata, f));
  }
  return result;
}

function applyTruncate(entries: MemoryEntry[], cap: number): MemoryEntry[] {
  if (cap < 0) return entries.map((e) => ({ ...e, truncated: false }));
  return entries.map((e) =>
    e.text.length > cap
      ? { ...e, text: e.text.slice(0, cap), truncated: true }
      : { ...e, truncated: false },
  );
}

function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const n = Number.parseInt(cursor, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function encodeCursor(offset: number): string {
  return String(offset);
}

export function createListMemoryEntriesTool(
  defaultWorkspaceId: string,
  logger: Logger,
): AtlasTools {
  return {
    list_memory_entries: tool({
      description:
        "Read entries from a named memory store in the current chat's workspace. " +
        "Filters: substring `query`, ISO `since` / `until` time " +
        "windows, exact-match `metadata`. Pagination: `limit` + `cursor` (opaque token). " +
        "Output: `truncate` caps entries' text at 500 chars by default — entries flag " +
        "`truncated: true` when cut. Use describe_memory_entry to pull a single entry's " +
        "untruncated text.",
      inputSchema: ListMemoryEntriesInput,
      execute: async ({
        memoryName,
        query,
        since,
        until,
        metadata,
        limit,
        cursor,
        order,
        truncate,
      }) => {
        // Validate ISO time filters upfront. `new Date("garbage").getTime()`
        // is NaN, and a comparison against NaN silently filters every entry
        // out — the worst LLM failure mode (empty result with no signal).
        if (since !== undefined && !Number.isFinite(new Date(since).getTime())) {
          return {
            ok: false as const,
            error: `list_memory_entries: invalid \`since\` (expected ISO 8601, got ${JSON.stringify(since)})`,
          };
        }
        if (until !== undefined && !Number.isFinite(new Date(until).getTime())) {
          return {
            ok: false as const,
            error: `list_memory_entries: invalid \`until\` (expected ISO 8601, got ${JSON.stringify(until)})`,
          };
        }

        const url =
          `${getAtlasDaemonUrl()}/api/memory/${encodeURIComponent(defaultWorkspaceId)}/narrative/` +
          `${encodeURIComponent(memoryName)}`;
        let res: Response;
        try {
          res = await fetch(url);
        } catch (err) {
          logger.warn("list_memory_entries fetch threw", {
            workspaceId: defaultWorkspaceId,
            memoryName,
            error: stringifyError(err),
          });
          return { ok: false as const, error: "list_memory_entries failed: network error" };
        }
        if (!res.ok) {
          await discardBody(res);
          return { ok: false as const, error: `list_memory_entries failed: HTTP ${res.status}` };
        }
        const raw = (await res.json()) as unknown;
        const all = Array.isArray(raw)
          ? raw.map((r) => normalize(r as RawEntry)).filter((e): e is MemoryEntry => e !== null)
          : [];

        const sortOrder = order ?? "newest";
        const sorted = [...all].sort((a, b) => {
          const ta = new Date(a.createdAt).getTime();
          const tb = new Date(b.createdAt).getTime();
          return sortOrder === "newest" ? tb - ta : ta - tb;
        });

        const filtered = applyFilters(sorted, { query, since, until, metadata });

        const cap = limit ?? 20;
        const offset = decodeCursor(cursor);
        const slice = filtered.slice(offset, offset + cap);
        const hasMore = offset + cap < filtered.length;

        const truncCap = truncate ?? 500;
        const items = applyTruncate(slice, truncCap);

        return {
          ok: true as const,
          items,
          has_more: hasMore,
          ...(hasMore ? { next_cursor: encodeCursor(offset + cap) } : {}),
          total_filtered: filtered.length,
        };
      },
    }),
  };
}

export function createDescribeMemoryEntryTool(
  defaultWorkspaceId: string,
  logger: Logger,
): AtlasTools {
  return {
    describe_memory_entry: tool({
      description:
        "Return the full text and metadata for a single memory entry. The escape hatch when " +
        "list_memory_entries truncated the body and you need the rest — describe never truncates.",
      inputSchema: DescribeMemoryEntryInput,
      execute: async ({ memoryName, entryId }) => {
        const url =
          `${getAtlasDaemonUrl()}/api/memory/${encodeURIComponent(defaultWorkspaceId)}/narrative/` +
          `${encodeURIComponent(memoryName)}`;
        let res: Response;
        try {
          res = await fetch(url);
        } catch (err) {
          logger.warn("describe_memory_entry fetch threw", {
            workspaceId: defaultWorkspaceId,
            memoryName,
            entryId,
            error: stringifyError(err),
          });
          return { ok: false as const, error: "describe_memory_entry failed: network error" };
        }
        if (!res.ok) {
          await discardBody(res);
          return { ok: false as const, error: `describe_memory_entry failed: HTTP ${res.status}` };
        }
        const raw = (await res.json()) as unknown;
        const entries = Array.isArray(raw)
          ? raw.map((r) => normalize(r as RawEntry)).filter((e): e is MemoryEntry => e !== null)
          : [];
        const match = entries.find((e) => e.id === entryId);
        if (!match) {
          return {
            ok: false as const,
            error: `Memory entry "${entryId}" not found in store "${memoryName}".`,
          };
        }
        return { ok: true as const, entry: match };
      },
    }),
  };
}
