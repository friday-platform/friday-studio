/**
 * Integration tests for workspace config routes - shared error patterns.
 *
 * Tests common error handling across all config endpoints:
 * - Workspace not found (404)
 * - Entity not found (404)
 * - Validation errors (400)
 * - System workspace protection (403)
 *
 * Resource-specific tests are in:
 * - config-signals.test.ts
 * - config-agents.test.ts
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "@std/yaml";
import { describe, expect, test } from "vitest";
import {
  assert404WorkspaceNotFound,
  createMergedConfig,
  createMockWorkspace,
  createTestApp,
  createTestConfig,
  type JsonBody,
  useTempDir,
} from "./config.test-fixtures.ts";

// ==============================================================================
// PARAMETERIZED ERROR TESTS - Common 404/400 patterns across endpoints
// ==============================================================================

describe("Workspace not found (404)", () => {
  const getEndpoints = [
    "/config/signals",
    "/config/signals/webhook",
    "/config/agents",
    "/config/agents/planner",
    "/config/credentials",
  ] as const;

  // Mutation endpoints need valid bodies — zValidator rejects invalid input
  // before the handler can check workspace existence.
  const mutationEndpoints = [
    {
      method: "PUT" as const,
      path: "/config/signals/webhook",
      body: { provider: "http", description: "test", config: { path: "/test" } },
    },
    { method: "DELETE" as const, path: "/config/signals/webhook" },
    {
      method: "POST" as const,
      path: "/config/signals",
      body: {
        signalId: "new",
        signal: { provider: "http", description: "test", config: { path: "/test" } },
      },
    },
    {
      method: "PUT" as const,
      path: "/config/agents/planner",
      body: { type: "llm", prompt: "test" },
    },
  ];

  test.each(getEndpoints)("GET %s returns 404", async (path) => {
    const { app } = createTestApp({ workspace: null });
    await assert404WorkspaceNotFound(app, `/ws-unknown${path}`);
  });

  test.each(mutationEndpoints)("$method $path returns 404", async ({ method, path, body }) => {
    const { app } = createTestApp({ workspace: null });
    await assert404WorkspaceNotFound(app, `/ws-unknown${path}`, method, body);
  });
});

describe("Entity not found (404)", () => {
  const entities = [
    { endpoint: "/config/signals/nonexistent", entityType: "signal" },
    { endpoint: "/config/agents/nonexistent", entityType: "agent" },
  ] as const;

  test.each(entities)("GET $endpoint returns 404 with entityType=$entityType", async ({
    endpoint,
    entityType,
  }) => {
    const config = createMergedConfig(createTestConfig());
    const { app } = createTestApp({ config });

    const response = await app.request(`/ws-test-id${endpoint}`);

    expect(response.status).toBe(404);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({
      success: false,
      error: "not_found",
      entityType,
      entityId: "nonexistent",
    });
  });
});

describe("Validation error (400)", () => {
  const getTestDir = useTempDir();

  const mutationConfigs = [
    { method: "PUT" as const, path: "/config/signals/webhook", entity: "signal" },
    { method: "PUT" as const, path: "/config/agents/planner", entity: "agent" },
  ] as const;

  test.each(mutationConfigs)("$method $path returns 400 for invalid $entity config", async ({
    method,
    path,
  }) => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    await writeFile(join(testDir, "workspace.yml"), stringify(createTestConfig()));
    const { app } = createTestApp({ workspace });

    const response = await app.request(`/ws-test-id${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ invalid: "config" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body).toHaveProperty("success", false);
    expect(body).toHaveProperty("error");
  });
});

// ==============================================================================
// SYSTEM WORKSPACE PROTECTION (403) - Comprehensive Test
// ==============================================================================

describe("System workspace protection", () => {
  test("blocks all mutation endpoints on system workspaces", async () => {
    const workspace = createMockWorkspace({ metadata: { system: true } });
    const { app } = createTestApp({ workspace });

    // Valid bodies required — zValidator rejects invalid input before handler runs.
    const mutations = [
      {
        method: "PUT",
        path: "/ws-test-id/config/signals/any",
        body: { provider: "http", description: "test", config: { path: "/test" } },
      },
      { method: "DELETE", path: "/ws-test-id/config/signals/any", body: {} },
      {
        method: "POST",
        path: "/ws-test-id/config/signals",
        body: {
          signalId: "new",
          signal: { provider: "http", description: "test", config: { path: "/test" } },
        },
      },
      {
        method: "PUT",
        path: "/ws-test-id/config/agents/any",
        body: { type: "llm", prompt: "test" },
      },
    ];

    for (const { method, path, body } of mutations) {
      const response = await app.request(path, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(403);
      const json = (await response.json()) as JsonBody;
      expect(json).toMatchObject({ error: "forbidden" });
    }
  });
});
