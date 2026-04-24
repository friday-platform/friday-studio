import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "../types.ts";
import { stringifyError } from "../utils.ts";
import { resolveStore } from "./store-resolve.ts";

export const MemoryKVGetInput = z.object({ store: z.string(), key: z.string() });

export const MemoryKVSetInput = z.object({
  store: z.string(),
  key: z.string(),
  value: z.unknown(),
  ttlSeconds: z.number().int().nonnegative().optional(),
});

export const MemoryKVDeleteInput = z.object({ store: z.string(), key: z.string() });

export function createMemoryKVTools(ctx: AgentContext) {
  return {
    memory_kv_get: tool({
      description: "Get a value from a key-value memory store.",
      inputSchema: jsonSchema<z.infer<typeof MemoryKVGetInput>>({
        type: "object",
        properties: {
          store: { type: "string", description: "Name of the KV store" },
          key: { type: "string", description: "Key to look up" },
        },
        required: ["store", "key"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryKVGetInput.parse(raw);
          const store = await resolveStore(ctx, input.store, "kv");
          const value = await store.get(input.key);
          return { value: value ?? null };
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    memory_kv_set: tool({
      description: "Set a value in a key-value memory store with optional TTL.",
      inputSchema: jsonSchema<z.infer<typeof MemoryKVSetInput>>({
        type: "object",
        properties: {
          store: { type: "string", description: "Name of the KV store" },
          key: { type: "string", description: "Key to set" },
          value: { description: "Value to store" },
          ttlSeconds: { type: "integer", minimum: 0, description: "Time-to-live in seconds" },
        },
        required: ["store", "key", "value"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryKVSetInput.parse(raw);
          const store = await resolveStore(ctx, input.store, "kv");
          await store.set(input.key, input.value, input.ttlSeconds);
          return { ok: true };
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    memory_kv_delete: tool({
      description: "Delete a key from a key-value memory store.",
      inputSchema: jsonSchema<z.infer<typeof MemoryKVDeleteInput>>({
        type: "object",
        properties: {
          store: { type: "string", description: "Name of the KV store" },
          key: { type: "string", description: "Key to delete" },
        },
        required: ["store", "key"],
      }),
      execute: async (raw) => {
        try {
          const input = MemoryKVDeleteInput.parse(raw);
          const store = await resolveStore(ctx, input.store, "kv");
          await store.delete(input.key);
          return { ok: true };
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),
  };
}
