import { Hono } from "hono";
import { agentsRoute } from "./routes/agents.ts";
import { executeRoute } from "./routes/execute.ts";
import { mcpRoute } from "./routes/mcp.ts";
import { workspaceRoute } from "./routes/workspace.ts";

const api = new Hono()
  .basePath("/api")
  .get("/health", (c) => c.json({ ok: true }))
  .route("/agents", agentsRoute)
  .route("/execute", executeRoute)
  .route("/mcp", mcpRoute)
  .route("/workspace", workspaceRoute);

export { api };
export type Router = typeof api;
