/**
 * Share route - proxies chat HTML uploads to internal gist service
 */

import { logger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { describeRoute, resolver } from "hono-openapi";
import z from "zod";
import { daemonFactory } from "../src/factory.ts";

const GIST_SERVICE_URL = Deno.env.get("GIST_SERVICE_URL") || "https://share.atlas.tempestdx.com";
const ATLAS_KEY = Deno.env.get("ATLAS_KEY");
const GIST_SERVICE_TIMEOUT_MS = 10_000;

const shareResponseSchema = z.object({ id: z.string(), url: z.string() });
const errorResponseSchema = z.object({ error: z.string() });

const shareRoutes = daemonFactory.createApp();

shareRoutes.post(
  "/",
  describeRoute({
    tags: ["Share"],
    summary: "Share chat content",
    description: "Proxy chat HTML to gist service and return public URL",
    responses: {
      201: {
        description: "Chat shared successfully",
        content: { "application/json": { schema: resolver(shareResponseSchema) } },
      },
      502: {
        description: "Gist service unavailable or error",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
      504: {
        description: "Gist service timeout",
        content: { "application/json": { schema: resolver(errorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    try {
      const headers: Record<string, string> = {
        "Content-Type": c.req.header("Content-Type") || "text/html",
      };
      if (ATLAS_KEY) {
        headers.Authorization = `Bearer ${ATLAS_KEY}`;
      }

      const response = await fetch(`${GIST_SERVICE_URL}/space`, {
        method: "POST",
        headers,
        body: await c.req.arrayBuffer(),
        signal: AbortSignal.timeout(GIST_SERVICE_TIMEOUT_MS),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error("Gist service error", { status: response.status, error: errorText });
        return c.json({ error: errorText }, 502);
      }

      const data = (await response.json()) as { id: string; url: string };
      logger.info("Chat shared", { id: data.id, url: data.url });
      return c.json(data, 201);
    } catch (error) {
      if (error instanceof DOMException && error.name === "TimeoutError") {
        logger.error("Gist service timeout", { timeoutMs: GIST_SERVICE_TIMEOUT_MS });
        return c.json({ error: "Gist service timeout" }, 504);
      }
      logger.error("Failed to share chat", { error: stringifyError(error) });
      return c.json({ error: "Gist service unavailable" }, 502);
    }
  },
);

export { shareRoutes };
export type ShareRoutes = typeof shareRoutes;
