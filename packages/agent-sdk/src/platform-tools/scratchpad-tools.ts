import { jsonSchema, tool } from "ai";
import { z } from "zod";
import type { AgentContext } from "../types.ts";
import { stringifyError } from "../utils.ts";

const ScratchpadAppendInput = z.object({
  sessionKey: z.string(),
  chunk: z.object({ id: z.string(), kind: z.string(), body: z.string(), createdAt: z.string() }),
});

const ScratchpadReadInput = z.object({ sessionKey: z.string(), since: z.string().optional() });

const ScratchpadClearInput = z.object({ sessionKey: z.string() });

function getScratchpad(ctx: AgentContext) {
  if (!ctx.memory?.scratchpad) {
    throw new Error("ScratchpadAdapter not available on agent context");
  }
  return ctx.memory.scratchpad;
}

export function createScratchpadTools(ctx: AgentContext) {
  return {
    scratchpad_append: tool({
      description: "Append a chunk to the session scratchpad.",
      inputSchema: jsonSchema<z.infer<typeof ScratchpadAppendInput>>({
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key for the scratchpad" },
          chunk: {
            type: "object",
            properties: {
              id: { type: "string" },
              kind: { type: "string" },
              body: { type: "string" },
              createdAt: { type: "string" },
            },
            required: ["id", "kind", "body", "createdAt"],
          },
        },
        required: ["sessionKey", "chunk"],
      }),
      execute: async (raw) => {
        try {
          const input = ScratchpadAppendInput.parse(raw);
          const adapter = getScratchpad(ctx);
          await adapter.append(input.sessionKey, input.chunk);
          return { ok: true };
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    scratchpad_read: tool({
      description: "Read chunks from the session scratchpad, optionally filtered by time.",
      inputSchema: jsonSchema<z.infer<typeof ScratchpadReadInput>>({
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key for the scratchpad" },
          since: { type: "string", description: "ISO timestamp — return chunks after this time" },
        },
        required: ["sessionKey"],
      }),
      execute: async (raw) => {
        try {
          const input = ScratchpadReadInput.parse(raw);
          const adapter = getScratchpad(ctx);
          return await adapter.read(input.sessionKey, { since: input.since });
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),

    scratchpad_clear: tool({
      description: "Clear all chunks from the session scratchpad.",
      inputSchema: jsonSchema<z.infer<typeof ScratchpadClearInput>>({
        type: "object",
        properties: {
          sessionKey: { type: "string", description: "Session key for the scratchpad" },
        },
        required: ["sessionKey"],
      }),
      execute: async (raw) => {
        try {
          const input = ScratchpadClearInput.parse(raw);
          const adapter = getScratchpad(ctx);
          await adapter.clear(input.sessionKey);
          return { ok: true };
        } catch (err) {
          return { error: stringifyError(err) };
        }
      },
    }),
  };
}
