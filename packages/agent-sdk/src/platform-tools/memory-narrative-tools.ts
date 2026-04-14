import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "../types.ts";
import { stringifyError } from "../utils.ts";
import { resolveCorpus } from "./corpus-resolve.ts";

export const MemoryNarrativeAppendInput = z.object({
  corpus: z.string(),
  entry: z.object({
    id: z.string(),
    text: z.string(),
    author: z.string().optional(),
    createdAt: z.string(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export const MemoryNarrativeReadInput = z.object({
  corpus: z.string(),
  since: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

export const MemoryNarrativeSearchInput = z.object({
  corpus: z.string(),
  query: z.string(),
  limit: z.number().int().positive().optional(),
});

export const MemoryNarrativeForgetInput = z.object({ corpus: z.string(), id: z.string() });

export function createMemoryNarrativeTools(ctx: AgentContext) {
  return {
    memory_narrative_append: tool({
      description: "Append an entry to a narrative memory corpus.",
      inputSchema: jsonSchema<z.infer<typeof MemoryNarrativeAppendInput>>({
        type: "object",
        properties: {
          corpus: { type: "string", description: "Name of the narrative corpus" },
          entry: {
            type: "object",
            properties: {
              id: { type: "string" },
              text: { type: "string" },
              author: { type: "string" },
              createdAt: { type: "string" },
              metadata: { type: "object", additionalProperties: true },
            },
            required: ["id", "text", "createdAt"],
          },
        },
        required: ["corpus", "entry"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryNarrativeAppendInput.parse(raw);
          const corpus = await resolveCorpus(ctx, input.corpus, "narrative");
          return await corpus.append(input.entry);
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    memory_narrative_read: tool({
      description:
        "Read entries from a narrative memory corpus, optionally filtered by time and limited.",
      inputSchema: jsonSchema<z.infer<typeof MemoryNarrativeReadInput>>({
        type: "object",
        properties: {
          corpus: { type: "string", description: "Name of the narrative corpus" },
          since: { type: "string", description: "ISO timestamp — return entries after this time" },
          limit: { type: "integer", minimum: 1, description: "Maximum entries to return" },
        },
        required: ["corpus"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryNarrativeReadInput.parse(raw);
          const corpus = await resolveCorpus(ctx, input.corpus, "narrative");
          return await corpus.read({ since: input.since, limit: input.limit });
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    memory_narrative_search: tool({
      description: "Semantic search over a narrative memory corpus.",
      inputSchema: jsonSchema<z.infer<typeof MemoryNarrativeSearchInput>>({
        type: "object",
        properties: {
          corpus: { type: "string", description: "Name of the narrative corpus" },
          query: { type: "string", description: "Search query" },
          limit: { type: "integer", minimum: 1, description: "Maximum results to return" },
        },
        required: ["corpus", "query"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryNarrativeSearchInput.parse(raw);
          const corpus = await resolveCorpus(ctx, input.corpus, "narrative");
          return await corpus.search(input.query, { limit: input.limit });
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    memory_narrative_forget: tool({
      description: "Remove an entry from a narrative memory corpus by ID.",
      inputSchema: jsonSchema<z.infer<typeof MemoryNarrativeForgetInput>>({
        type: "object",
        properties: {
          corpus: { type: "string", description: "Name of the narrative corpus" },
          id: { type: "string", description: "Entry ID to remove" },
        },
        required: ["corpus", "id"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryNarrativeForgetInput.parse(raw);
          const corpus = await resolveCorpus(ctx, input.corpus, "narrative");
          await corpus.forget(input.id);
          return { ok: true };
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),
  };
}
