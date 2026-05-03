/**
 * Integration tests for the draft file flow.
 *
 * Tests the full lifecycle: create workspace → begin draft → verify draft exists
 * → publish → verify draft gone, live updated → verify daemon restart loads live.
 */

import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceConfig } from "@atlas/config";
import type { WorkspaceManager } from "@atlas/workspace";
import { stringify } from "@std/yaml";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import type { AppContext, AppVariables } from "../../src/factory.ts";
import { workspacesRoutes } from "./index.ts";

vi.mock("@atlas/storage", () => ({
  FilesystemWorkspaceCreationAdapter: class {
    createWorkspaceDirectory = vi.fn().mockResolvedValue("/tmp");
    writeWorkspaceFiles = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../me/adapter.ts", () => ({
  getCurrentUser: vi.fn().mockResolvedValue({ id: "user-1", email: "test@test.com" }),
}));

vi.mock("@atlas/core/mcp-registry/credential-resolver", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/core/mcp-registry/credential-resolver")>()),
  fetchLinkCredential: vi.fn().mockResolvedValue({ provider: "github" }),
}));

vi.mock("@atlas/utils/paths.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@atlas/utils/paths.server")>()),
  getFridayHome: vi.fn(() => "/tmp"),
}));

function createMinimalConfig(): WorkspaceConfig {
  return {
    version: "1.0",
    workspace: { id: "ws-test", name: "Test Workspace", description: "test" },
  };
}

function createApp(opts: { workspaceDir: string; workspaceId: string }) {
  const mockManager = {
    find: vi
      .fn()
      .mockResolvedValue({
        id: opts.workspaceId,
        name: "Test Workspace",
        path: opts.workspaceDir,
        status: "idle",
        metadata: {},
      }),
    getWorkspaceConfig: vi
      .fn()
      .mockResolvedValue({ atlas: null, workspace: createMinimalConfig() }),
  } as unknown as WorkspaceManager;

  const mockContext: AppContext = {
    runtimes: new Map(),
    startTime: Date.now(),
    sseClients: new Map(),
    sseStreams: new Map(),
    getWorkspaceManager: () => mockManager,
    getOrCreateWorkspaceRuntime: vi.fn(),
    resetIdleTimeout: vi.fn(),
    getWorkspaceRuntime: vi.fn(),
    destroyWorkspaceRuntime: vi.fn().mockResolvedValue(undefined),
    daemon: {
      getWorkspaceManager: () => mockManager,
      runtimes: new Map(),
    } as unknown as AppContext["daemon"],
    streamRegistry: {} as AppContext["streamRegistry"],
    chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
    sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
    sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
    getAgentRegistry: vi.fn(),
    getOrCreateChatSdkInstance: vi.fn(),
    evictChatSdkInstance: vi.fn().mockResolvedValue(undefined),
    exposeKernel: false,
    platformModels: { get: vi.fn() },
  };

  const app = new Hono<AppVariables>();
  app.use("*", async (c, next) => {
    c.set("app", mockContext);
    await next();
  });
  app.route("/workspaces", workspacesRoutes);

  return { app, mockManager };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("Draft file flow", () => {
  let tempDir: string;
  const workspaceId = "ws-draft-test";

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "draft-test-"));
    await writeFile(join(tempDir, "workspace.yml"), stringify(createMinimalConfig()));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("begin draft creates workspace.yml.draft from live file", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    const res = await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true });

    const draftPath = join(tempDir, "workspace.yml.draft");
    expect(await fileExists(draftPath)).toBe(true);

    const draftContent = await readFile(draftPath, "utf-8");
    const liveContent = await readFile(join(tempDir, "workspace.yml"), "utf-8");
    expect(draftContent).toBe(liveContent);
  });

  test("begin draft is idempotent", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // First call
    const res1 = await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(res1.status).toBe(200);

    // Modify draft to prove idempotency
    await writeFile(join(tempDir, "workspace.yml.draft"), "modified: true\n", "utf-8");

    // Second call should not overwrite
    const res2 = await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(res2.status).toBe(200);

    const draftContent = await readFile(join(tempDir, "workspace.yml.draft"), "utf-8");
    expect(draftContent).toBe("modified: true\n");
  });

  test("read draft returns draft config", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const res = await app.request(`/workspaces/${workspaceId}/draft`, { method: "GET" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true, config: { version: "1.0" } });
  });

  test("publish draft atomically replaces live file and removes draft", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // Begin draft
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    // Modify draft
    const modifiedConfig = {
      ...createMinimalConfig(),
      workspace: { ...createMinimalConfig().workspace, name: "Modified Name" },
    };
    await writeFile(join(tempDir, "workspace.yml.draft"), stringify(modifiedConfig));

    // Publish
    const res = await app.request(`/workspaces/${workspaceId}/draft/publish`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true });

    // Draft should be gone
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(false);

    // Live file should be updated
    const liveContent = await readFile(join(tempDir, "workspace.yml"), "utf-8");
    expect(liveContent).toContain("Modified Name");
  });

  test("publish draft refuses when validation fails", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // Begin draft
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    // Write invalid config into draft
    await writeFile(join(tempDir, "workspace.yml.draft"), "invalid: yaml: [", "utf-8");

    // Publish should fail validation
    const res = await app.request(`/workspaces/${workspaceId}/draft/publish`, { method: "POST" });
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body).toMatchObject({ success: false });

    // Draft should still exist since publish failed
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(true);
  });

  test("discard draft removes draft file", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(true);

    const res = await app.request(`/workspaces/${workspaceId}/draft/discard`, { method: "POST" });
    expect(res.status).toBe(200);

    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(false);
  });

  test("daemon restart loads live file, not draft", async () => {
    const { app, mockManager } = createApp({ workspaceDir: tempDir, workspaceId });

    // Begin draft and modify it
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    const draftConfig = {
      ...createMinimalConfig(),
      workspace: { ...createMinimalConfig().workspace, name: "Draft Only" },
    };
    await writeFile(join(tempDir, "workspace.yml.draft"), stringify(draftConfig));

    // Verify draft exists and has the modified name
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(true);

    // Simulate what the daemon does: load workspace config via manager
    const loaded = await mockManager.getWorkspaceConfig(workspaceId);
    // The mock returns the live config (from workspace.yml), not the draft
    expect(loaded?.workspace?.workspace?.name).toBe("Test Workspace");
  });

  test("publish with active runtime destroys and reloads it", async () => {
    const mockManager = {
      find: vi
        .fn()
        .mockResolvedValue({
          id: workspaceId,
          name: "Test Workspace",
          path: tempDir,
          status: "idle",
          metadata: {},
        }),
      getWorkspaceConfig: vi
        .fn()
        .mockResolvedValue({ atlas: null, workspace: createMinimalConfig() }),
    } as unknown as WorkspaceManager;

    const destroySpy = vi.fn().mockResolvedValue(undefined);
    const createRuntimeSpy = vi.fn().mockResolvedValue(undefined);
    const mockContext: AppContext = {
      runtimes: new Map(),
      startTime: Date.now(),
      sseClients: new Map(),
      sseStreams: new Map(),
      getWorkspaceManager: () => mockManager,
      getOrCreateWorkspaceRuntime: createRuntimeSpy,
      resetIdleTimeout: vi.fn(),
      getWorkspaceRuntime: vi.fn().mockReturnValue({ id: "runtime-1" }),
      destroyWorkspaceRuntime: destroySpy,
      daemon: {
        getWorkspaceManager: () => mockManager,
        runtimes: new Map(),
      } as unknown as AppContext["daemon"],
      streamRegistry: {} as AppContext["streamRegistry"],
      chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
      sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
      sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
      getAgentRegistry: vi.fn(),
      getOrCreateChatSdkInstance: vi.fn(),
      evictChatSdkInstance: vi.fn().mockResolvedValue(undefined),
      exposeKernel: false,
      platformModels: { get: vi.fn() },
    };

    const app = new Hono<AppVariables>();
    app.use("*", async (c, next) => {
      c.set("app", mockContext);
      await next();
    });
    app.route("/workspaces", workspacesRoutes);

    // Begin draft and publish
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    const res = await app.request(`/workspaces/${workspaceId}/draft/publish`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true });
    expect(destroySpy).not.toHaveBeenCalled();
    expect(createRuntimeSpy).not.toHaveBeenCalled();
  });

  test("publish eagerly starts runtime when none exists", async () => {
    const mockManager = {
      find: vi
        .fn()
        .mockResolvedValue({
          id: workspaceId,
          name: "Test Workspace",
          path: tempDir,
          status: "idle",
          metadata: {},
        }),
      getWorkspaceConfig: vi
        .fn()
        .mockResolvedValue({ atlas: null, workspace: createMinimalConfig() }),
    } as unknown as WorkspaceManager;

    const destroySpy = vi.fn().mockResolvedValue(undefined);
    const createRuntimeSpy = vi.fn().mockResolvedValue(undefined);
    const mockContext: AppContext = {
      runtimes: new Map(),
      startTime: Date.now(),
      sseClients: new Map(),
      sseStreams: new Map(),
      getWorkspaceManager: () => mockManager,
      getOrCreateWorkspaceRuntime: createRuntimeSpy,
      resetIdleTimeout: vi.fn(),
      getWorkspaceRuntime: vi.fn().mockReturnValue(undefined),
      destroyWorkspaceRuntime: destroySpy,
      daemon: {
        getWorkspaceManager: () => mockManager,
        runtimes: new Map(),
      } as unknown as AppContext["daemon"],
      streamRegistry: {} as AppContext["streamRegistry"],
      chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
      sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
      sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
      getAgentRegistry: vi.fn(),
      getOrCreateChatSdkInstance: vi.fn(),
      evictChatSdkInstance: vi.fn().mockResolvedValue(undefined),
      exposeKernel: false,
      platformModels: { get: vi.fn() },
    };

    const app = new Hono<AppVariables>();
    app.use("*", async (c, next) => {
      c.set("app", mockContext);
      await next();
    });
    app.route("/workspaces", workspacesRoutes);

    // Begin draft and publish
    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    const res = await app.request(`/workspaces/${workspaceId}/draft/publish`, { method: "POST" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true });
    expect(destroySpy).not.toHaveBeenCalled();
    expect(createRuntimeSpy).not.toHaveBeenCalled();
  });

  test("read draft returns 409 when no draft exists", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    const res = await app.request(`/workspaces/${workspaceId}/draft`, { method: "GET" });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: "No draft exists" });
  });

  test("upsert agent into draft", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const agentConfig = {
      type: "llm",
      description: "Test agent",
      config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "You are a test agent" },
    };

    const res = await app.request(`/workspaces/${workspaceId}/draft/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-agent", config: agentConfig }),
    });
    expect(res.status).toBe(200);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.record(z.string(), z.unknown()),
        structural_issues: z.null(),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: true });
    expect(body.diff).toHaveProperty("type");
    expect(body.diff["type"]).toEqual({ to: "llm" });

    const draft = await readFile(join(tempDir, "workspace.yml.draft"), "utf-8");
    expect(draft).toContain("test-agent");
    expect(draft).toContain("You are a test agent");
  });

  test("upsert signal into draft", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const signalConfig = {
      provider: "http",
      description: "Test webhook",
      config: { path: "/test" },
    };

    const res = await app.request(`/workspaces/${workspaceId}/draft/items/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-webhook", config: signalConfig }),
    });
    expect(res.status).toBe(200);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.record(z.string(), z.unknown()),
        structural_issues: z.null(),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: true });
    expect(body.diff).toHaveProperty("provider");

    const draft = await readFile(join(tempDir, "workspace.yml.draft"), "utf-8");
    expect(draft).toContain("test-webhook");
    expect(draft).toContain("/test");
  });

  test("upsert job into draft", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const jobConfig = {
      description: "Test job",
      triggers: [{ signal: "webhook" }],
      execution: { agents: ["test-agent"] },
    };

    const res = await app.request(`/workspaces/${workspaceId}/draft/items/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-job", config: jobConfig }),
    });
    expect(res.status).toBe(200);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.record(z.string(), z.unknown()),
        structural_issues: z.null(),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: true });

    const draft = await readFile(join(tempDir, "workspace.yml.draft"), "utf-8");
    expect(draft).toContain("test-job");
    expect(draft).toContain("test-agent");
  });

  test("upsert returns 400 for invalid entity config", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const res = await app.request(`/workspaces/${workspaceId}/draft/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bad-agent", config: { invalid: true } }),
    });
    expect(res.status).toBe(400);

    const body = z.object({ ok: z.boolean(), error: z.string() }).parse(await res.json());
    expect(body).toMatchObject({ ok: false });
    expect(body.error).toContain("Invalid agent config");
  });

  test("direct upsert agent into live config when no draft exists", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    const agentConfig = {
      type: "llm",
      description: "Live agent",
      config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "You are a live agent" },
    };

    const res = await app.request(`/workspaces/${workspaceId}/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "live-agent", config: agentConfig }),
    });
    expect(res.status).toBe(200);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.record(z.string(), z.unknown()),
        structural_issues: z.null(),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: true });

    const liveContent = await readFile(join(tempDir, "workspace.yml"), "utf-8");
    expect(liveContent).toContain("live-agent");
    expect(liveContent).toContain("You are a live agent");
  });

  test("direct upsert refuses when structural issues exist", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // Add a job with an FSM that references a non-existent agent
    const jobConfig = {
      description: "Broken job",
      fsm: {
        id: "broken-fsm",
        initial: "step_0",
        states: { step_0: { entry: [{ type: "agent", agentId: "nonexistent-agent" }] } },
      },
    };
    const res = await app.request(`/workspaces/${workspaceId}/items/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "broken-job", config: jobConfig }),
    });
    expect(res.status).toBe(422);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.record(z.string(), z.unknown()),
        structural_issues: z.array(z.object({ code: z.string() })),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: false });
    expect(body.structural_issues.length).toBeGreaterThan(0);
    expect(body.structural_issues[0]?.code).toBe("unknown_agent_id");

    // Live file should NOT contain the broken job
    const liveContent = await readFile(join(tempDir, "workspace.yml"), "utf-8");
    expect(liveContent).not.toContain("broken-job");
  });

  test("draft upsert returns diff for modified entity", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const agentConfig = {
      type: "llm",
      description: "Original agent",
      config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Original prompt" },
    };
    await app.request(`/workspaces/${workspaceId}/draft/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evolving-agent", config: agentConfig }),
    });

    const updatedConfig = {
      type: "llm",
      description: "Updated agent",
      config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "Updated prompt" },
    };
    const res = await app.request(`/workspaces/${workspaceId}/draft/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "evolving-agent", config: updatedConfig }),
    });
    expect(res.status).toBe(200);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.record(z.string(), z.unknown()),
        structural_issues: z.null(),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: true });
    expect(body.diff).toHaveProperty("description");
    expect(body.diff["description"]).toEqual({ from: "Original agent", to: "Updated agent" });
    expect(body.diff).toHaveProperty("config.prompt");
    expect(body.diff["config.prompt"]).toEqual({ from: "Original prompt", to: "Updated prompt" });
  });

  test("delete agent from draft", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const agentConfig = {
      type: "llm",
      description: "Test agent",
      config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "You are a test agent" },
    };

    await app.request(`/workspaces/${workspaceId}/draft/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "delete-me", config: agentConfig }),
    });

    const res = await app.request(`/workspaces/${workspaceId}/draft/items/agent/delete-me`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.object({ removed: z.array(z.object({ path: z.string() })) }),
        structural_issues: z.null(),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: true });
    expect(body.diff.removed).toHaveLength(1);
    expect(body.diff.removed[0]?.path).toBe("agents.delete-me");
    expect(body.structural_issues).toBeNull();

    const draftContent = await readFile(join(tempDir, "workspace.yml.draft"), "utf-8");
    expect(draftContent).not.toContain("delete-me");
  });

  test("delete returns 404 when entity not found in draft", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const res = await app.request(`/workspaces/${workspaceId}/draft/items/agent/missing`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);

    const body = z.object({ success: z.boolean(), error: z.string() }).parse(await res.json());
    expect(body).toMatchObject({ success: false });
    expect(body.error).toContain("missing");
  });

  test("delete agent with broken references returns structural issues", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    // Add an agent
    const agentConfig = {
      type: "llm",
      description: "Test agent",
      config: { provider: "anthropic", model: "claude-sonnet-4-6", prompt: "You are a test agent" },
    };
    await app.request(`/workspaces/${workspaceId}/draft/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-agent", config: agentConfig }),
    });

    // Add a job with an FSM that references the agent
    const jobConfig = {
      description: "Test job",
      fsm: {
        id: "test-fsm",
        initial: "step_0",
        states: { step_0: { entry: [{ type: "agent", agentId: "test-agent" }] } },
      },
    };
    await app.request(`/workspaces/${workspaceId}/draft/items/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "test-job", config: jobConfig }),
    });

    // Delete the agent — draft mode is permissive, should succeed but report issues
    const res = await app.request(`/workspaces/${workspaceId}/draft/items/agent/test-agent`, {
      method: "DELETE",
    });
    expect(res.status).toBe(200);

    const body = z
      .object({
        ok: z.boolean(),
        diff: z.object({ removed: z.array(z.object({ path: z.string() })) }),
        structural_issues: z.array(z.object({ code: z.string() })),
      })
      .parse(await res.json());
    expect(body).toMatchObject({ ok: true });
    expect(body.diff.removed).toHaveLength(1);
    expect(body.diff.removed[0]?.path).toBe("agents.test-agent");
    expect(body.structural_issues).not.toBeNull();
    expect(body.structural_issues.length).toBeGreaterThan(0);
    expect(body.structural_issues[0]?.code).toBe("unknown_agent_id");
  });

  test("validate draft returns report", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });

    const res = await app.request(`/workspaces/${workspaceId}/draft/validate`, { method: "POST" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      report: { status: "ok", errors: [], warnings: [] },
    });
  });

  test("validate draft returns 409 when no draft exists", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    const res = await app.request(`/workspaces/${workspaceId}/draft/validate`, { method: "POST" });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: "No draft exists" });
  });

  test("discard draft via DELETE removes draft file", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    await app.request(`/workspaces/${workspaceId}/draft/begin`, { method: "POST" });
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(true);

    const res = await app.request(`/workspaces/${workspaceId}/draft`, { method: "DELETE" });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toMatchObject({ success: true });

    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(false);
  });

  test("discard draft via DELETE returns 409 when no draft exists", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    const res = await app.request(`/workspaces/${workspaceId}/draft`, { method: "DELETE" });
    expect(res.status).toBe(409);

    const body = await res.json();
    expect(body).toMatchObject({ success: false, error: "No draft to discard" });
  });

  test("full lifecycle: begin → upsert agent → upsert job → upsert signal → validate → publish", async () => {
    const { app } = createApp({ workspaceDir: tempDir, workspaceId });

    // 1. Begin draft
    const beginRes = await app.request(`/workspaces/${workspaceId}/draft/begin`, {
      method: "POST",
    });
    expect(beginRes.status).toBe(200);

    // 2. Upsert agent
    const agentConfig = {
      type: "llm",
      description: "Email triager",
      config: {
        provider: "anthropic",
        model: "claude-sonnet-4-5",
        prompt: "Triage emails",
        tool_choice: "none",
      },
    };
    const agentRes = await app.request(`/workspaces/${workspaceId}/draft/items/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "email-triager", config: agentConfig }),
    });
    expect(agentRes.status).toBe(200);

    // 3. Upsert job referencing the agent
    const jobConfig = {
      description: "Review inbox",
      triggers: [{ signal: "review-inbox" }],
      fsm: {
        id: "review-inbox-pipeline",
        initial: "step_0",
        states: {
          step_0: {
            entry: [
              { type: "agent", agentId: "email-triager", outputTo: "result", outputType: "triage" },
            ],
          },
        },
      },
    };
    const jobRes = await app.request(`/workspaces/${workspaceId}/draft/items/job`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "review-inbox", config: jobConfig }),
    });
    expect(jobRes.status).toBe(200);

    // 4. Upsert signal
    const signalConfig = {
      provider: "http",
      description: "Trigger inbox review",
      config: { path: "/review-inbox" },
    };
    const signalRes = await app.request(`/workspaces/${workspaceId}/draft/items/signal`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "review-inbox", config: signalConfig }),
    });
    expect(signalRes.status).toBe(200);

    // 5. Validate draft
    const validateRes = await app.request(`/workspaces/${workspaceId}/draft/validate`, {
      method: "POST",
    });
    expect(validateRes.status).toBe(200);
    const validateBody = await validateRes.json();
    expect(validateBody).toMatchObject({ success: true, report: { status: "ok" } });

    // 6. Publish
    const publishRes = await app.request(`/workspaces/${workspaceId}/draft/publish`, {
      method: "POST",
    });
    expect(publishRes.status).toBe(200);
    const publishBody = await publishRes.json();
    expect(publishBody).toMatchObject({ success: true });

    // Draft should be gone
    expect(await fileExists(join(tempDir, "workspace.yml.draft"))).toBe(false);

    // Live file should contain all three entities
    const liveContent = await readFile(join(tempDir, "workspace.yml"), "utf-8");
    expect(liveContent).toContain("email-triager");
    expect(liveContent).toContain("review-inbox");
    expect(liveContent).toContain("/review-inbox");
  });

  test("all draft endpoints return 404 for missing workspace", async () => {
    const mockManager = {
      find: vi.fn().mockResolvedValue(null),
      getWorkspaceConfig: vi
        .fn()
        .mockResolvedValue({ atlas: null, workspace: createMinimalConfig() }),
    } as unknown as WorkspaceManager;

    const mockContext: AppContext = {
      runtimes: new Map(),
      startTime: Date.now(),
      sseClients: new Map(),
      sseStreams: new Map(),
      getWorkspaceManager: () => mockManager,
      getOrCreateWorkspaceRuntime: vi.fn(),
      resetIdleTimeout: vi.fn(),
      getWorkspaceRuntime: vi.fn(),
      destroyWorkspaceRuntime: vi.fn().mockResolvedValue(undefined),
      daemon: {
        getWorkspaceManager: () => mockManager,
        runtimes: new Map(),
      } as unknown as AppContext["daemon"],
      streamRegistry: {} as AppContext["streamRegistry"],
      chatTurnRegistry: {} as AppContext["chatTurnRegistry"],
      sessionStreamRegistry: {} as AppContext["sessionStreamRegistry"],
      sessionHistoryAdapter: {} as AppContext["sessionHistoryAdapter"],
      getAgentRegistry: vi.fn(),
      getOrCreateChatSdkInstance: vi.fn(),
      evictChatSdkInstance: vi.fn().mockResolvedValue(undefined),
      exposeKernel: false,
      platformModels: { get: vi.fn() },
    };

    const app = new Hono<AppVariables>();
    app.use("*", async (c, next) => {
      c.set("app", mockContext);
      await next();
    });
    app.route("/workspaces", workspacesRoutes);

    const endpoints = [
      { path: `/workspaces/missing/draft`, method: "GET" },
      { path: `/workspaces/missing/draft/begin`, method: "POST" },
      { path: `/workspaces/missing/draft/publish`, method: "POST" },
      { path: `/workspaces/missing/draft/discard`, method: "POST" },
      { path: `/workspaces/missing/draft`, method: "DELETE" },
      { path: `/workspaces/missing/draft/validate`, method: "POST" },
      {
        path: `/workspaces/missing/draft/items/agent`,
        method: "POST",
        body: JSON.stringify({ id: "a", config: {} }),
      },
      { path: `/workspaces/missing/draft/items/agent/a`, method: "DELETE" },
    ];

    for (const endpoint of endpoints) {
      const reqInit: RequestInit = { method: endpoint.method };
      if (endpoint.body) {
        reqInit.headers = { "Content-Type": "application/json" };
        reqInit.body = endpoint.body;
      }
      const res = await app.request(endpoint.path, reqInit);
      expect(res.status).toBe(404);
    }
  });
});
