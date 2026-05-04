import type { AtlasTools } from "@atlas/agent-sdk";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { tool } from "ai";
import { z } from "zod";
import { envelope, type ReadResponse } from "./envelope.ts";

const MemorySaveInput = z.object({
  memoryName: z
    .string()
    .describe(
      "Memory store name — pick the store from <memory_stores> in the workspace context that best fits the content",
    ),
  text: z.string().min(1),
  why: z
    .string()
    .min(1)
    .describe(
      "Why this is worth remembering — what future request would benefit. If you can't articulate why, don't save. Required.",
    ),
  id: z.string().optional().describe("UUID; auto-generated if omitted"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const MemoryReadInput = z.object({
  memoryName: z.string(),
  since: z.string().optional().describe("ISO 8601 — return entries after this timestamp"),
  limit: z.number().int().positive().optional(),
});

const MemoryRemoveInput = z.object({
  memoryName: z.string(),
  entryId: z.string().describe("The id field of the entry to remove"),
});

export function createMemorySaveTool(workspaceId: string, logger: Logger): AtlasTools {
  const daemonUrl = getAtlasDaemonUrl();

  return {
    memory_save: tool({
      description:
        "Save an entry to a named memory store in this workspace. " +
        "See <memory_writes> in your system prompt for trigger types and " +
        "anti-triggers. The `why` field is required and forces a sanity " +
        "check — if you can't articulate why this should be remembered, " +
        "don't save. Persists across sessions.",
      inputSchema: MemorySaveInput,
      execute: async ({ memoryName, text, why, id, metadata }) => {
        const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${encodeURIComponent(memoryName)}`;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              id: id ?? crypto.randomUUID(),
              text,
              createdAt: new Date().toISOString(),
              metadata: { ...metadata, why },
            }),
          });
          if (!res.ok) {
            const body = await res.text();
            logger.error("memory_save failed", {
              workspaceId,
              memoryName,
              status: res.status,
              body,
            });
            return { error: `Failed to save: HTTP ${res.status}` };
          }
          logger.info("memory_save succeeded", { workspaceId, memoryName });
          return { saved: true };
        } catch (err) {
          logger.error("memory_save fetch error", { workspaceId, memoryName, error: err });
          return { error: "Failed to save: network error" };
        }
      },
    }),

    memory_read: tool({
      description:
        "Read entries from a named memory store in this workspace, newest-first. " +
        "Use for explicit lookup of prior preferences/notes/facts, time-filtered " +
        "queries, or reading beyond the default auto-injection window. Returns " +
        "a ReadResponse envelope: {items, provenance: 'user-authored', ...}.",
      inputSchema: MemoryReadInput,
      execute: async ({
        memoryName,
        since,
        limit,
      }): Promise<ReadResponse<unknown> | { error: string }> => {
        const params = new URLSearchParams();
        if (since) params.set("since", since);
        if (limit !== undefined) params.set("limit", String(limit));
        const query = params.toString();
        const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${encodeURIComponent(memoryName)}${query ? `?${query}` : ""}`;
        try {
          const res = await fetch(url);
          if (!res.ok) return { error: `Failed to read: HTTP ${res.status}` };
          const raw: unknown = await res.json();
          const items = Array.isArray(raw) ? raw : [];
          return envelope({ items, source: "user-authored", origin: `memory:${memoryName}` });
        } catch (err) {
          logger.error("memory_read fetch error", { workspaceId, memoryName, error: err });
          return { error: "Failed to read: network error" };
        }
      },
    }),

    memory_remove: tool({
      description: "Remove a single entry from a named memory in this workspace by its id.",
      inputSchema: MemoryRemoveInput,
      execute: async ({ memoryName, entryId }) => {
        const url = `${daemonUrl}/api/memory/${encodeURIComponent(workspaceId)}/narrative/${encodeURIComponent(memoryName)}/${encodeURIComponent(entryId)}`;
        try {
          const res = await fetch(url, { method: "DELETE" });
          if (!res.ok) return { error: `Failed to remove: HTTP ${res.status}` };
          logger.info("memory_remove succeeded", { workspaceId, memoryName, entryId });
          return { removed: true };
        } catch (err) {
          logger.error("memory_remove fetch error", {
            workspaceId,
            memoryName,
            entryId,
            error: err,
          });
          return { error: "Failed to remove: network error" };
        }
      },
    }),
  };
}
