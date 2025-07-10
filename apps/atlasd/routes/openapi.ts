import { OpenAPIHono } from "@hono/zod-openapi";
import { Scalar } from "@scalar/hono-api-reference";
import type { Hono } from "hono";
import type { AppVariables } from "../src/factory.ts";
import { OPENAPI_DOCUMENTATION } from "../src/openapi-config.ts";

// Export handlers that need to be configured with the main app
export const createOpenAPIHandlers = (
  mainApp: OpenAPIHono<AppVariables>,
  options: { hostname?: string; port?: number } = {},
) => {
  const hostname = options.hostname || "localhost";
  const port = options.port || 8080;

  // OpenAPI spec handler
  const openAPIHandler = (c: any) => {
    return c.json(mainApp.getOpenAPIDocument({
      ...OPENAPI_DOCUMENTATION,
      servers: [
        {
          url: `http://${hostname}:${port}`,
          description: "Atlas Daemon Server",
        },
      ],
    }));
  };

  // Scalar UI handler
  const scalarHandler = Scalar({
    url: "/openapi.json",
    theme: "alternate",
  });

  return { openAPIHandler, scalarHandler };
};
