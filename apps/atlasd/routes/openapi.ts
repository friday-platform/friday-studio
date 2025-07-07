import { openAPISpecs } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { Hono } from "hono";
import type { AppVariables } from "../src/factory.ts";

// Export handlers that need to be configured with the main app
export const createOpenAPIHandlers = (
  mainApp: Hono<AppVariables>,
  options: { hostname?: string; port?: number } = {},
) => {
  const hostname = options.hostname || "localhost";
  const port = options.port || 8080;

  // OpenAPI spec handler
  const openAPIHandler = openAPISpecs(mainApp, {
    documentation: {
      info: {
        title: "Atlas Daemon API",
        version: "1.0.0",
        description: "API for managing workspaces, sessions, and AI agent orchestration",
      },
      servers: [
        {
          url: `http://${hostname}:${port}`,
          description: "Atlas Daemon Server",
        },
      ],
      tags: [
        { name: "System", description: "System health and status endpoints" },
        { name: "Workspaces", description: "Workspace management operations" },
        { name: "Sessions", description: "Session management operations" },
        { name: "Library", description: "Library storage operations" },
        { name: "Daemon", description: "Daemon control operations" },
      ],
    },
  });

  // Scalar UI handler
  const scalarHandler = Scalar({
    url: "/openapi.json",
    theme: "alternate",
  });

  return { openAPIHandler, scalarHandler };
};
