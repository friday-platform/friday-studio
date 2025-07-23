import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute, resolver } from "hono-openapi";

export const healthResponseSchema = z
  .object({
    activeWorkspaces: z.number().int().min(0).meta({
      description: "Number of currently active workspaces",
    }),
    uptime: z.number().int().min(0).meta({
      description: "Daemon uptime in milliseconds",
    }),
    timestamp: z.iso.datetime().meta({
      description: "Current server timestamp in ISO 8601 format",
    }),
    version: z
      .object({
        deno: z.string().meta({
          description: "Deno runtime version",
        }),
        v8: z.string().meta({
          description: "V8 engine version",
        }),
        typescript: z.string().meta({
          description: "TypeScript version",
        }),
      })
      .meta({
        description: "Version information for runtime components",
      }),
  })
  .meta({
    id: "HealthResponse",
    description: "Health check response containing daemon status and metrics",
  });

// Type inference from schema
type HealthResponse = z.infer<typeof healthResponseSchema>;

const healthRoutes = daemonFactory.createApp();

healthRoutes.get(
  "/",
  describeRoute({
    tags: ["System"],
    summary: "Health check",
    description: "Returns the current health status of the Atlas daemon including runtime metrics",
    responses: {
      200: {
        description: "Daemon is healthy and operational",
        content: {
          "application/json": { schema: resolver(healthResponseSchema) },
        },
      },
    },
  }),
  (c) => {
    const ctx = c.get("app");

    const response: HealthResponse = {
      activeWorkspaces: ctx.runtimes.size,
      uptime: Date.now() - ctx.startTime,
      timestamp: new Date().toISOString(),
      version: {
        deno: Deno.version.deno,
        v8: Deno.version.v8,
        typescript: Deno.version.typescript,
      },
    };
    return c.json(response);
  },
);

export { healthRoutes };
