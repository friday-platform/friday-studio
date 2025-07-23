import { openAPIRouteHandler } from "hono-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { Hono } from "hono";
import type { AppVariables } from "../src/factory.ts";
import { OPENAPI_DOCUMENTATION } from "../src/openapi-config.ts";

// Export handlers that need to be configured with the main app
export const createOpenAPIHandlers = (
  mainApp: Hono<AppVariables>,
  options: { hostname?: string; port?: number } = {},
) => {
  const hostname = options.hostname || "localhost";
  const port = options.port || 8080;

  // OpenAPI spec handler
  const openAPIHandler = openAPIRouteHandler(mainApp, {
    documentation: {
      ...OPENAPI_DOCUMENTATION,
      servers: [
        {
          url: `http://${hostname}:${port}`,
          description: "Atlas Daemon Server",
        },
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
