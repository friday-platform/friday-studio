import { generateSpecs } from "hono-openapi";
import { stringify } from "@std/yaml";
import { type AppContext, createApp } from "../src/factory.ts";
import { healthRoutes } from "../routes/health.ts";
import { createOpenAPIHandlers } from "../routes/openapi.ts";

// Create a minimal app context for spec generation
const mockContext: AppContext = {
  runtimes: new Map(),
  startTime: Date.now(),
  sseClients: new Map(),
};

// Create the app with all routes
const app = createApp(mockContext);

// Mount health routes
app.route("/health", healthRoutes);

// Create OpenAPI handlers with the app
const { openAPIHandler } = createOpenAPIHandlers(app, {
  hostname: "localhost",
  port: 8080,
});

// Mount the OpenAPI handler
app.get("/openapi.json", openAPIHandler);

// Generate the OpenAPI spec
generateSpecs(app, {
  documentation: {
    info: {
      title: "Atlas Daemon API",
      version: "1.0.0",
      description: "API for managing workspaces, sessions, and AI agent orchestration",
    },
    servers: [
      {
        url: "http://localhost:8080",
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
})
  .then((spec) => {
    // Convert to YAML
    const yamlContent = stringify(spec, {
      lineWidth: 120,
    });

    // Write to file
    const outputPath = "openapi.yaml";
    Deno.writeTextFileSync(outputPath, yamlContent);
    console.log(`OpenAPI spec written to ${outputPath}`);
  })
  .catch((error) => {
    console.error("Failed to generate OpenAPI spec:", error);
    Deno.exit(1);
  });
