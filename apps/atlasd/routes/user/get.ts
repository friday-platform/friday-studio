import { env } from "node:process";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema, userGetResponseSchema } from "./schemas.ts";

const getUser = daemonFactory.createApp();

getUser.get(
  "/",
  describeRoute({
    tags: ["User"],
    summary: "Retrieve current user",
    description: "Get the current user for the session",
    responses: {
      200: {
        description: "User retrieved successfully",
        content: { "application/json": { schema: resolver(userGetResponseSchema) } },
      },
      404: {
        description: "User not found",
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
      const currentUser = env.USER || env.USERNAME || "You";

      // get the current user
      return c.json({ success: true, currentUser });
    } catch (error) {
      return c.json({ success: false, error: stringifyError(error) }, 500);
    }
  },
);

export { getUser };
