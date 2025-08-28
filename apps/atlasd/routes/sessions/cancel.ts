import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver, validator } from "hono-openapi";
import z from "zod/v4";
import { daemonFactory } from "../../src/factory.ts";
import { errorResponseSchema } from "../../src/utils.ts";

const cancelSession = daemonFactory.createApp();

/**
 * DELETE /:sessionId - Cancel a running session.
 * Searches across all workspace runtimes for the session and cancels it.
 */
cancelSession.delete(
  "/",
  describeRoute({
    tags: ["Sessions"],
    summary: "Cancel session",
    description: "Cancel a running session across any workspace",
    responses: {
      200: {
        description: "Session cancelled successfully",
        content: {
          "application/json": {
            schema: resolver(z.object({ message: z.string(), workspaceId: z.string() })),
          },
        },
      },
      404: {
        description: "Session not found",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      500: {
        description: "Internal server error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  validator("param", z.object({ sessionId: z.string() })),
  async (c) => {
    const { sessionId } = c.req.valid("param");
    const ctx = c.get("app");
    const { runtimes } = ctx;

    // Find session across all runtimes
    for (const [workspaceId, runtime] of runtimes) {
      const session = runtime.getSession(sessionId);
      if (session) {
        try {
          await runtime.cancelSession(sessionId);
          return c.json({ message: `Session ${sessionId} cancelled`, workspaceId });
        } catch (error) {
          logger.error("Failed to cancel session", { error, sessionId, workspaceId });
          return c.json({ error: stringifyError(error) }, 500);
        }
      }
    }

    return c.json({ error: `Session not found: ${sessionId}` }, 404);
  },
);

export { cancelSession };
