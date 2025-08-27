import { daemonFactory } from "../../src/factory.ts";
import { describeRoute, resolver, validator } from "hono-openapi";
import { TEMP_UI_MESSAGE_SCHEMA } from "./schemas.ts";
import type { AtlasUIMessage } from "@atlas/agent-sdk";
import { conversationStorage } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { errorResponseSchema } from "../../src/utils.ts";
import z from "zod/v4";

const updateChat = daemonFactory.createApp();

/**
 * PUT /:streamId - Update conversation state with new message history.
 *
 * Called by SessionSupervisor after processing signals to persist
 * the updated conversation including agent responses and tool results.
 */
updateChat.put(
  "/",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "Replace conversation messages",
    description: "Replace entire conversation history for the given stream ID",
    responses: {
      200: {
        description: "Conversation updated successfully",
        content: { "application/json": { schema: resolver(z.object({})) } },
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
  validator("json", z.object({ messages: z.array(TEMP_UI_MESSAGE_SCHEMA) })),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const data = c.req.valid("json");

      // @ts-expect-error AI SDK doesn't export Zod schemas for UIMessage/UIMessageChunk
      // so we accept z.array(z.unknown()) and cast to AtlasUIMessage[]
      // @see: https://github.com/vercel/ai/issues/8100
      const messages: AtlasUIMessage[] = data.messages;

      conversationStorage.replace(streamId, messages);
      return c.json({});
    } catch (error) {
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  },
);

export { updateChat };
