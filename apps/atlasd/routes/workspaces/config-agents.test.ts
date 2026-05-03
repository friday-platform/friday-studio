/**
 * Integration tests for workspace config agent routes.
 *
 * Tests PUT /config/agents/:agentId and 405 for POST/DELETE (agents are FSM-embedded).
 *
 * GET tests removed - extraction logic unit tested in @atlas/config/mutations.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkspaceConfigSchema } from "@atlas/config";
import { parse, stringify } from "@std/yaml";
import { describe, expect, test } from "vitest";
import {
  createMergedConfig,
  createMockWorkspace,
  createTestApp,
  createTestConfig,
  type JsonBody,
  useTempDir,
} from "./config.test-fixtures.ts";

/**
 * Create an FSM job config with agent/llm actions in state entries.
 */
function createFSMJob(actions: Array<{ type: string; [key: string]: unknown }>) {
  return {
    description: "Test FSM job",
    triggers: [{ signal: "test-signal" }],
    fsm: {
      id: "test-fsm",
      initial: "idle",
      states: {
        idle: { on: { start: { target: "step_0" } } },
        step_0: { entry: actions },
        completed: { type: "final" },
      },
    },
  };
}

describe("PUT /config/agents/:agentId", () => {
  const getTestDir = useTempDir();

  test("returns 404 when agent path does not exist", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    await writeFile(join(testDir, "workspace.yml"), stringify(createTestConfig()));
    const config = createMergedConfig(createTestConfig());
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/agents/nonexistent:state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm", prompt: "New prompt" }),
    });

    expect(response.status).toBe(404);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ error: "not_found", entityType: "agent" });
  });

  test("returns 400 for invalid path ID format", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      jobs: {
        "my-job": createFSMJob([
          { type: "llm", provider: "anthropic", model: "test", prompt: "Test" },
        ]),
      },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/agents/invalid-format", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm", prompt: "New prompt" }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as JsonBody;
    expect(body.error).toBe("validation");
  });

  test("returns 422 when attempting to change agent type", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      jobs: {
        "my-job": createFSMJob([
          { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Original" },
        ]),
      },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/agents/my-job:step_0", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agent", prompt: "Try to change type" }),
    });

    expect(response.status).toBe(422);
    const body = (await response.json()) as JsonBody;
    expect(body.error).toBe("invalid_operation");
    expect(body.message).toContain("action type");
  });

  test("updates FSM inline LLM successfully without eagerly destroying runtime", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      jobs: {
        "my-job": createFSMJob([
          {
            type: "llm",
            provider: "anthropic",
            model: "claude-sonnet-4-6",
            prompt: "Original prompt",
          },
        ]),
      },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app, destroyWorkspaceRuntime } = createTestApp({
      workspace,
      config,
      runtimeActive: true,
    });

    const response = await app.request("/ws-test-id/config/agents/my-job:step_0", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "llm",
        prompt: "Updated prompt",
        model: "claude-opus-4-6",
        tools: ["filesystem"],
      }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(true);
    expect(destroyWorkspaceRuntime).not.toHaveBeenCalled();
  });

  test("updates FSM bundled agent prompt successfully", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      jobs: {
        "my-job": createFSMJob([{ type: "agent", agentId: "research", prompt: "Original task" }]),
      },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    const response = await app.request("/ws-test-id/config/agents/my-job:step_0", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "agent", prompt: "Updated task" }),
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as JsonBody;
    expect(body.ok).toBe(true);
  });

  test("persists changes to workspace.yml (verified via API round-trip)", async () => {
    const testDir = getTestDir();
    const workspace = createMockWorkspace({ path: testDir });
    const configData = createTestConfig({
      jobs: {
        "my-job": createFSMJob([
          { type: "llm", provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Original" },
        ]),
      },
    });
    await writeFile(join(testDir, "workspace.yml"), stringify(configData));
    const config = createMergedConfig(configData);
    const { app } = createTestApp({ workspace, config });

    // PUT to update the agent
    const putResponse = await app.request("/ws-test-id/config/agents/my-job:step_0", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "llm", prompt: "Updated prompt" }),
    });
    expect(putResponse.status).toBe(200);

    // Verify via GET (fresh app with config reloaded from disk)
    const savedContent = await readFile(join(testDir, "workspace.yml"), "utf8");
    const savedConfig = WorkspaceConfigSchema.parse(parse(savedContent));
    const freshApp = createTestApp({ workspace, config: createMergedConfig(savedConfig) });
    const getResponse = await freshApp.app.request("/ws-test-id/config/agents/my-job:step_0");

    expect(getResponse.status).toBe(200);
    const agent = (await getResponse.json()) as JsonBody;
    expect(agent.prompt).toBe("Updated prompt");
  });
});

// ==============================================================================
// AGENT METHOD NOT ALLOWED TESTS (405)
// ==============================================================================

describe("POST /config/agents", () => {
  test("returns 405 Method Not Allowed", async () => {
    const config = createMergedConfig(createTestConfig());
    const { app } = createTestApp({ config });

    const response = await app.request("/ws-test-id/config/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: "new-agent", agent: { type: "llm" } }),
    });

    expect(response.status).toBe(405);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ success: false, error: "method_not_allowed" });
    expect(body.message).toContain("cannot be created");
    expect(body.message).toContain("FSM states");
  });
});

describe("DELETE /config/agents/:agentId", () => {
  test("returns 405 Method Not Allowed", async () => {
    const config = createMergedConfig(createTestConfig());
    const { app } = createTestApp({ config });

    const response = await app.request("/ws-test-id/config/agents/some-agent", {
      method: "DELETE",
    });

    expect(response.status).toBe(405);
    const body = (await response.json()) as JsonBody;
    expect(body).toMatchObject({ success: false, error: "method_not_allowed" });
    expect(body.message).toContain("cannot be deleted");
    expect(body.message).toContain("FSM states");
  });
});
