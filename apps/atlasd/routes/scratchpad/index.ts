import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod";
import { daemonFactory } from "../../src/factory.ts";
import { appendNote, getNotes, NoteSchema } from "../../src/storage/scratchpad.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const scratchpadApp = daemonFactory.createApp();

// GET /:streamId - Retrieve scratchpad notes
scratchpadApp.get(
  "/:streamId",
  describeRoute({
    tags: ["Scratchpad"],
    summary: "Retrieve scratchpad notes",
    description: "Get notes for a stream",
    responses: {
      200: {
        description: "Notes retrieved",
        content: {
          "application/json": {
            schema: resolver(z.object({ notes: z.array(NoteSchema), count: z.number() })),
          },
        },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  validator("query", z.object({ limit: z.number().optional().default(100) })),
  async (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const { limit } = c.req.valid("query");

      const notes = await getNotes(streamId, limit);

      return c.json({ notes, count: notes.length });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

// POST /:streamId - Append note to scratchpad
scratchpadApp.post(
  "/:streamId",
  describeRoute({
    tags: ["Scratchpad"],
    summary: "Append note to scratchpad",
    description: "Add a note to the scratchpad",
    responses: {
      200: {
        description: "Note stored",
        content: { "application/json": { schema: resolver(z.object({ success: z.boolean() })) } },
      },
      400: {
        description: "Invalid request data",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  validator("json", z.object({ note: z.string() })),
  async (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const { note } = c.req.valid("json");

      await appendNote(streamId, note);

      return c.json({ success: true });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { scratchpadApp };
