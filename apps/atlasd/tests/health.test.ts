/**
 * Health Endpoint Tests
 *
 * Tests the health endpoint functionality including status reporting,
 * version information, and daemon context integration.
 */

import { assert, assertEquals } from "@std/assert";
import { healthRoutes } from "../routes/health.ts";
import { type AppContext, createApp } from "../src/factory.ts";

function createMockContext(activeWorkspaces = 0, startTime = Date.now()): AppContext {
  const mockRuntimes = new Map();
  // Add mock workspaces
  for (let i = 0; i < activeWorkspaces; i++) {
    mockRuntimes.set(`workspace-${i}`, {});
  }

  return { runtimes: mockRuntimes, startTime: startTime, sseClients: new Map() };
}

function createTestApp(activeWorkspaces = 0, uptime = 0) {
  const mockContext = createMockContext(activeWorkspaces, Date.now() - uptime);
  const app = createApp(mockContext);
  app.route("/health", healthRoutes);
  return app;
}

Deno.test("Health Endpoint", async (t) => {
  await t.step("returns healthy status with all required fields", async () => {
    const app = createTestApp(3, 60000);
    const res = await app.request("/health");
    const json = await res.json();

    assertEquals(res.status, 200);
    assertEquals(json.activeWorkspaces, 3);
    // Check uptime is approximately correct (within 100ms)
    assert(Math.abs(json.uptime - 60000) < 100);
    assert(json.timestamp);
    assert(json.version?.deno);
  });

  await t.step("returns correct context values", async () => {
    const app = createTestApp(5, 123456);
    const res = await app.request("/health");
    const json = await res.json();

    assertEquals(json.activeWorkspaces, 5);
    assert(Math.abs(json.uptime - 123456) < 100);
  });

  await t.step("handles concurrent requests", async () => {
    const app = createTestApp(2, 30000);

    const responses = await Promise.all([
      app.request("/health"),
      app.request("/health"),
      app.request("/health"),
    ]);

    for (const res of responses) {
      assertEquals(res.status, 200);
    }
  });
});
