/**
 * Mock server for testing the Atlas client
 */

import { Hono } from "hono";

export function createMockAtlasServer() {
  const app = new Hono();

  // Health endpoint
  app.get("/health", (c) => c.json({ status: "ok" }));

  // Daemon status
  app.get("/api/daemon/status", (c) =>
    c.json({
      status: "running",
      activeWorkspaces: 2,
      uptime: 3600,
      workspaces: ["workspace-1", "workspace-2"],
    }));

  // Workspaces
  app.get("/api/workspaces", (c) =>
    c.json([
      {
        id: "workspace-1",
        name: "Test Workspace",
        description: "A test workspace",
        status: "active",
        path: "/path/to/workspace",
        createdAt: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      },
    ]));

  // Sessions
  app.get("/api/sessions", (c) =>
    c.json([
      {
        id: "session-1",
        workspaceId: "workspace-1",
        status: "running",
        summary: "Test session",
        signal: "test-signal",
        startTime: new Date().toISOString(),
        progress: 50,
      },
    ]));

  return app;
}
