import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "../types.ts";
import { stringifyError } from "../utils.ts";
import { resolveCorpus } from "./corpus-resolve.ts";

export const MemoryRetrievalIngestInput = z.object({
  corpus: z.string(),
  docs: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
  chunker: z.string().optional(),
  embedder: z.string().optional(),
});

export const MemoryRetrievalQueryInput = z.object({
  corpus: z.string(),
  text: z.string(),
  topK: z.number().int().positive().optional(),
  filter: z.record(z.string(), z.unknown()).optional(),
});

export function createMemoryRetrievalTools(ctx: AgentContext) {
  return {
    memory_retrieval_ingest: tool({
      description: "Ingest documents into a retrieval memory corpus for later semantic search.",
      inputSchema: jsonSchema<z.infer<typeof MemoryRetrievalIngestInput>>({
        type: "object",
        properties: {
          corpus: { type: "string", description: "Name of the retrieval corpus" },
          docs: {
            type: "array",
            description: "Documents to ingest",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                text: { type: "string" },
                metadata: { type: "object", additionalProperties: true },
              },
              required: ["id", "text"],
            },
          },
          chunker: { type: "string", description: "Chunking strategy name" },
          embedder: { type: "string", description: "Embedding model name" },
        },
        required: ["corpus", "docs"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryRetrievalIngestInput.parse(raw);
          const corpus = await resolveCorpus(ctx, input.corpus, "retrieval");
          return await corpus.ingest(
            { docs: input.docs },
            { chunker: input.chunker, embedder: input.embedder },
          );
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    memory_retrieval_query: tool({
      description: "Query a retrieval memory corpus with semantic search.",
      inputSchema: jsonSchema<z.infer<typeof MemoryRetrievalQueryInput>>({
        type: "object",
        properties: {
          corpus: { type: "string", description: "Name of the retrieval corpus" },
          text: { type: "string", description: "Query text for semantic search" },
          topK: { type: "integer", minimum: 1, description: "Number of results to return" },
          filter: { type: "object", additionalProperties: true, description: "Metadata filter" },
        },
        required: ["corpus", "text"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryRetrievalQueryInput.parse(raw);
          const corpus = await resolveCorpus(ctx, input.corpus, "retrieval");
          return await corpus.query(
            { text: input.text, topK: input.topK },
            { filter: input.filter },
          );
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),
  };
}
