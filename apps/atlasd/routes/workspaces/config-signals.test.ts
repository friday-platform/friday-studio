/**
 * Integration tests for workspace config signal routes.
 *
 * Tests PUT /config/signals/:signalId, DELETE /config/signals/:signalId,
 * and POST /config/signals.
 *
 * GET tests removed - extraction logic unit tested in @atlas/config/mutations.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { httpSignal } from "@atlas/config/testing";
import { stringify } from "@std/yaml";
import { describe, expect, test } from "vitest";
import {
  createMergedConfig,
  createMockWorkspace,
  createTestApp,
  createTestConfig,
  type JsonBody,
  useTempDir,
} from "./config.test-fixtures.ts";

describe("PUT /config/signals/:signalId", () => {
  const getTestDir = useTempDir();

  test("returns 404 when signal does not exist", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    await writeFile(join(testDir, "workspace.yml"), stringify(createTestConfig()));
    const config = createMergedConfig(createTestConfig());
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/signals/nonexistent", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "http",
        description: "Test signal",
        config: { path: "/hook" },
      }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ error: "not_found", entityType: "signal" });
  });

  test("allows changing provider type (http → schedule)", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({ signals: { webhook: httpSignal({ path: "/hook" }) } });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/signals/webhook", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "schedule",
        description: "Changed to schedule",
        config: { schedule: "0 9 * * *" },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(true);
  });

  test("updates signal successfully without eagerly destroying runtime", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({ signals: { webhook: httpSignal({ path: "/old" }) } });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config,
      runtimeActive: true,
    });

    const response = await app.request("/ws-test-id/config/signals/webhook", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: "http",
        description: "Updated webhook",
        config: { path: "/new" },
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(true);
    expect(destroyWorkspaceRuntime).not.toHaveBeenCalled();
  });
});

describe("DELETE /config/signals/:signalId", () => {
  const getTestDir = useTempDir();

  test("returns 404 when signal not found", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    await writeFile(join(testDir, "workspace.yml"), stringify(createTestConfig()));
    const config = createMergedConfig(createTestConfig());
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/signals/nonexistent", {
      method: "DELETE",
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ error: "not_found", entityType: "signal" });
  });

  test("returns 409 conflict when signal has job references", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      signals: { webhook: httpSignal({ path: "/hook" }) },
      jobs: {
        "my-job": {
          description: "A job",
          triggers: [{ signal: "webhook" }],
          execution: { strategy: "sequential", agents: ["agent"] },
        },
      },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/signals/webhook", { method: "DELETE" });

    expect(response.status).toBe(409);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ error: "conflict" });
    expect(body).toHaveProperty("willUnlinkFrom");
    expect(body.message).toContain("force=true");
  });

  test("deletes signal with force flag despite job references", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      signals: { webhook: httpSignal({ path: "/hook" }) },
      jobs: {
        "my-job": {
          description: "A job",
          triggers: [{ signal: "webhook" }],
          execution: { strategy: "sequential", agents: ["agent"] },
        },
      },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/signals/webhook?force=true", {
      method: "DELETE",
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(true);
  });

  test("deletes signal successfully", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({ signals: { webhook: httpSignal({ path: "/hook" }) } });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/signals/webhook", { method: "DELETE" });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(true);
  });
});

describe("POST /config/signals", () => {
  const getTestDir = useTempDir();

  test("returns 400 for invalid input", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    await writeFile(join(testDir, "workspace.yml"), stringify(createTestConfig()));
    const { app } = createTestApp({ workspace });

    const response = await app.request("/ws-test-id/config/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ signal: { provider: "http" } }), // Missing signalId and description
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body.success).toBe(false);
  });

  test("returns 409 conflict when signal already exists", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      signals: { existing: httpSignal({ path: "/existing" }) },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signalId: "existing",
        signal: {
          provider: "http",
          description: "Duplicate signal",
          config: { path: "/duplicate" },
        },
      }),
    });

    expect(response.status).toBe(409);
    const body = (await response.json()) as JsonBody;
    expect(body.error).toBe("conflict");
    expect(body.message).toContain("already exists");
  });

  test("creates signal successfully with 201 status without eagerly destroying runtime", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    await writeFile(join(testDir, "workspace.yml"), stringify(createTestConfig()));
    const config = createMergedConfig(createTestConfig());
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config,
      runtimeActive: true,
    });

    const response = await app.request("/ws-test-id/config/signals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signalId: "new-webhook",
        signal: { provider: "http", description: "New webhook signal", config: { path: "/new" } },
      }),
    });

    expect(response.status).toBe(201);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(true);
    expect(destroyWorkspaceRuntime).not.toHaveBeenCalled();
  });
});
