import { z } from "zod/v4";
import { daemonFactory } from "../src/factory.ts";
import { describeRoute } from "hono-openapi";
import { resolver } from "hono-openapi/zod";
import "@hono/zod-validator"; // Ensure this dependency is bundled
import "zod-openapi"; // Ensure this dependency is bundled

// TODO: Remove 'as any' once hono-openapi v0.5 is released with zod/v4 support
// See: https://github.com/rhinobase/hono-openapi/issues/97

export const healthResponseSchema = z.object({
  activeWorkspaces: z.int().min(0).meta({
    description: "Number of currently active workspaces",
  }),
  uptime: z.int().min(0).meta({
    description: "Daemon uptime in milliseconds",
  }),
  timestamp: z.iso.datetime().meta({
    description: "Current server timestamp in ISO 8601 format",
  }),
  version: z.object({
    deno: z.string().meta({
      description: "Deno runtime version",
    }),
    v8: z.string().meta({
      description: "V8 engine version",
    }),
    typescript: z.string().meta({
      description: "TypeScript version",
    }),
  }).meta({
    description: "Version information for runtime components",
  }),
}).meta({
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
          "application/json": { schema: resolver(healthResponseSchema as any) },
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
