import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "../types.ts";
import { stringifyError } from "../utils.ts";
import { resolveStore } from "./store-resolve.ts";

export const MemoryDedupAppendInput = z.object({
  store: z.string(),
  namespace: z.string(),
  entry: z.record(z.string(), z.unknown()),
  ttlHours: z.number().positive().optional(),
});

export const MemoryDedupFilterInput = z.object({
  store: z.string(),
  namespace: z.string(),
  field: z.string(),
  values: z.array(z.unknown()),
});

export function createMemoryDedupTools(ctx: AgentContext) {
  return {
    memory_dedup_append: tool({
      description: "Append an entry to a dedup store namespace with optional TTL.",
      inputSchema: jsonSchema<z.infer<typeof MemoryDedupAppendInput>>({
        type: "object",
        properties: {
          store: { type: "string", description: "Name of the dedup store" },
          namespace: { type: "string", description: "Dedup namespace" },
          entry: { type: "object", additionalProperties: true, description: "Entry fields" },
          ttlHours: { type: "number", exclusiveMinimum: 0, description: "Time-to-live in hours" },
        },
        required: ["store", "namespace", "entry"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryDedupAppendInput.parse(raw);
          const store = await resolveStore(ctx, input.store, "dedup");
          await store.append(input.namespace, input.entry, input.ttlHours);
          return { ok: true };
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    memory_dedup_filter: tool({
      description: "Filter values through a dedup store to remove duplicates.",
      inputSchema: jsonSchema<z.infer<typeof MemoryDedupFilterInput>>({
        type: "object",
        properties: {
          store: { type: "string", description: "Name of the dedup store" },
          namespace: { type: "string", description: "Dedup namespace" },
          field: { type: "string", description: "Field name to check for duplicates" },
          values: { type: "array", items: {}, description: "Values to filter" },
        },
        required: ["store", "namespace", "field", "values"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryDedupFilterInput.parse(raw);
          const store = await resolveStore(ctx, input.store, "dedup");
          return await store.filter(input.namespace, input.field, input.values);
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),
  };
}
