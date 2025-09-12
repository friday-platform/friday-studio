import { conversationStorage } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { TEMP_UI_MESSAGE_SCHEMA } from "./schemas.ts";

const getChat = daemonFactory.createApp();

/**
 * GET /:streamId - Retrieve conversation history for SessionSupervisor.
 *
 * Returns AI SDK formatted messages that SessionSupervisor uses as context
 * when analyzing signals and generating execution plans.
 */
getChat.get(
  "/",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "Retrieve conversation history",
    description: "Get the complete conversation history for the given stream ID",
    responses: {
      200: {
        description: "Conversation history retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(
              z.object({ messages: z.array(TEMP_UI_MESSAGE_SCHEMA), messageCount: z.number() }),
            ),
          },
        },
      },
      404: {
        description: "Conversation not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ streamId: z.string() })),
  (c) => {
    try {
      const { streamId } = c.req.valid("param");
      const messages = conversationStorage.get(streamId);

      return c.json({ messages, messageCount: messages.length });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { getChat };
