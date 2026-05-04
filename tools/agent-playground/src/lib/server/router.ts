import { Hono } from "hono";
import { agentsRoute } from "./routes/agents.ts";
import { discoverRoute } from "./routes/discover.ts";
import { executeRoute } from "./routes/execute.ts";
import { mcpRoute } from "./routes/mcp.ts";
import { shellRoute } from "./routes/shell.ts";
import { updatesRoute } from "./routes/updates.ts";

const api = new Hono()
  .basePath("/api")
  .get("/health", (c) => c.json({ ok: true }))
  .route("/agents", agentsRoute)
  .route("/discover", discoverRoute)
  .route("/execute", executeRoute)
  .route("/mcp", mcpRoute)
  .route("/shell", shellRoute)
  .route("/updates", updatesRoute);

export { api };
export type Router = typeof api;
