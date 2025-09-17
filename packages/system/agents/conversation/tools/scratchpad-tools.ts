import { createAtlasClient } from "@atlas/oapi-client";
import { tool } from "ai";
import { z } from "zod/v4";

export const takeNoteTool = tool({
  name: "take_note",
  description:
    "Store a note for later. Use when you need to remember intermediate results, track clarifications, or save observations during reasoning.",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier"),
    note: z.string().describe("A note to remember"),
  }),
  execute: async ({ streamId, note }) => {
    const client = createAtlasClient();
    const response = await client.POST("/api/scratchpad/{streamId}", {
      params: { path: { streamId } },
      body: { note },
    });

    if (response.error) {
      throw new Error(`Failed to store note: ${response.error.error}`);
    }

    return { stored: true };
  },
});

export const recallNotesTool = tool({
  name: "recall_notes",
  description: "Get notes stored during this conversation.",
  inputSchema: z.object({
    streamId: z.string().describe("Stream identifier"),
    limit: z.number().optional().default(50).describe("Maximum notes to retrieve"),
  }),
  execute: async ({ streamId, limit }) => {
    const client = createAtlasClient();
    const response = await client.GET("/api/scratchpad/{streamId}", {
      params: { path: { streamId }, query: { limit } },
    });

    if (response.error) {
      throw new Error(`Failed to retrieve notes: ${response.error.error}`);
    }

    return { notes: response.data.notes, count: response.data.count };
  },
});
