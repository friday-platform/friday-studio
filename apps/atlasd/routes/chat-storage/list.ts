import { conversationStorage } from "@atlas/core";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import z from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";
import { TEMP_UI_MESSAGE_SCHEMA } from "./schemas.ts";

const listChat = daemonFactory.createApp();

/**
 * GET /:streamId - Retrieve conversation history for SessionSupervisor.
 *
 * Returns AI SDK formatted messages that SessionSupervisor uses as context
 * when analyzing signals and generating execution plans.
 */
listChat.get(
  "/",
  describeRoute({
    tags: ["Conversation Storage"],
    summary: "List past conversations",
    description: "List the complete conversation history for the given stream ID",
    responses: {
      200: {
        description: "Conversation list retrieved successfully",
        content: {
          "application/json": {
            schema: resolver(
              z.object({
                conversations: z.array(TEMP_UI_MESSAGE_SCHEMA),
                conversationCount: z.number(),
              }),
            ),
          },
        },
      },
      404: {
        description: "No conversations found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  (c) => {
    try {
      const conversations = conversationStorage.list();

      return c.json({ conversations, conversationCount: conversations.length });
    } catch (error) {
      return c.json({ error: stringifyError(error) }, 500);
    }
  },
);

export { listChat };
