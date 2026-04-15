/**
 * Tests for agent-context skill injection
 *
 * Tests that buildAgentContext:
 * 1. Adds load_skill tool when skills exist AND agent.useWorkspaceSkills is true
 * 2. Appends <available_skills> to prompt when agent opts in
 * 3. Works correctly with empty skills list
 * 4. Skills NOT injected when agent.useWorkspaceSkills is false (default)
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasAgent } from "@atlas/agent-sdk";
import { packSkillArchive, SkillStorage } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Import LocalSkillAdapter directly from file since it's not exported from the package
import { LocalSkillAdapter } from "../../../skills/src/local-adapter.ts";
import { LinkCredentialNotFoundError } from "../mcp-registry/credential-resolver.ts";
import { clearMountContextRegistry, setMountContext } from "../mount-context-registry.ts";
import { createAgentContextBuilder } from "./index.ts";

// Mock createMCPTools — default returns empty tools with noop dispose
const mockDispose = vi.fn().mockResolvedValue(undefined);
const mockCreateMCPTools = vi.fn().mockResolvedValue({ tools: {}, dispose: mockDispose });

vi.mock("@atlas/mcp", () => ({
  createMCPTools: (...args: unknown[]) => mockCreateMCPTools(...args),
}));

// Mock logger — warn is a vi.fn() so tests can assert on warning calls
const mockWarn = vi.fn();
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: mockWarn,
  error: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => mockLogger,
} as Parameters<typeof createAgentContextBuilder>[0]["logger"];

// Minimal agent for testing
function createTestAgent(overrides: Partial<AtlasAgent> = {}): AtlasAgent {
  return {
    metadata: { id: "test-agent", name: "Test Agent", description: "Test agent for unit tests" },
    useWorkspaceSkills: false,
    ...overrides,
  } as AtlasAgent;
}

// Session data for testing
function createTestSessionData(workspaceId: string) {
  return { workspaceId, sessionId: "session-123" };
}

// Mock fetch for workspace config requests
function mockWorkspaceConfigFetch() {
  return () =>
    Promise.resolve(
      new Response(
        JSON.stringify({ config: { name: "test-workspace", tools: { mcp: { servers: {} } } } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
}

describe("buildAgentContext skill injection", () => {
  let tempDbPath: string;
  let tempAdapter: LocalSkillAdapter;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockWarn.mockClear();
    mockDispose.mockResolvedValue(undefined);
    mockCreateMCPTools.mockResolvedValue({ tools: {}, dispose: mockDispose });

    // Create temp database for skills
    tempDbPath = join(tmpdir(), `skills-test-${Date.now()}.db`);
    tempAdapter = new LocalSkillAdapter(tempDbPath);

    // Mock fetch for workspace config
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockWorkspaceConfigFetch();

    // Wire SkillStorage delegates that resolveVisibleSkills + agent-context use
    vi.spyOn(SkillStorage, "listUnassigned").mockImplementation(() => tempAdapter.listUnassigned());
    vi.spyOn(SkillStorage, "listAssigned").mockImplementation((wsId) =>
      tempAdapter.listAssigned(wsId),
    );
    vi.spyOn(SkillStorage, "get").mockImplementation((...args) => tempAdapter.get(...args));
  });

  afterEach(() => {
    vi.restoreAllMocks();

    // Restore fetch
    globalThis.fetch = originalFetch;

    // Clean up temp database
    try {
      rmSync(tempDbPath);
    } catch {
      // Ignore if file doesn't exist
    }
  });

  it("adds load_skill tool when skills exist", async () => {
    const workspaceId = "ws-with-skills";

    // Create a skill in the temp database
    await tempAdapter.publish("atlas", "my-skill", "user-1", {
      description: "A useful skill",
      instructions: "Do the thing",
    });

    // Stub SkillStorage.list to use temp adapter
    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Hello world",
    );

    // Should have load_skill tool
    expect("load_skill" in context.tools).toBe(true);
  });

  it("appends <available_skills> to prompt when skills exist", async () => {
    const workspaceId = "ws-with-skills-2";

    // Create a skill
    await tempAdapter.publish("atlas", "debug-helper", "user-1", {
      description: "Helps with debugging",
      instructions: "Use this for debugging",
    });

    // Stub SkillStorage.list
    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { enrichedPrompt } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Original prompt",
    );

    // Prompt should contain <available_skills> section
    expect(enrichedPrompt).toContain("<available_skills>");
    expect(enrichedPrompt).toContain("</available_skills>");
    expect(enrichedPrompt).toContain("@atlas/debug-helper");
    expect(enrichedPrompt).toContain("Helps with debugging");
    // Original prompt should still be present
    expect(enrichedPrompt).toContain("Original prompt");
  });

  it("works correctly with empty skills list", async () => {
    const workspaceId = "ws-no-skills";

    // No skills created — list returns empty array
    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context, enrichedPrompt } = await buildAgentContext(
      createTestAgent(),
      createTestSessionData(workspaceId),
      "Hello world",
    );

    // Should NOT have load_skill tool
    expect("load_skill" in context.tools).toBe(false);

    // Prompt should NOT contain <available_skills> section
    expect(enrichedPrompt.includes("<available_skills>")).toBe(false);
    expect(enrichedPrompt).toBe("Hello world");
  });

  it("load_skill tool is scoped to correct workspace", async () => {
    const workspaceId = "ws-tool-scope";

    await tempAdapter.publish("atlas", "scoped-skill", "user-1", {
      description: "Test scoping",
      instructions: "Scoped instructions",
    });

    // Stub SkillStorage methods
    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Test",
    );

    // The load_skill tool should exist with expected description
    const loadSkillTool = context.tools.load_skill;
    expect.assert(loadSkillTool !== undefined);
    expect(loadSkillTool.description).toContain("Load skill instructions BEFORE starting a task");
  });

  it("handles SkillStorage.list returning error gracefully", async () => {
    const workspaceId = "ws-error";

    // Stub SkillStorage.list to return an error
    vi.spyOn(SkillStorage, "list").mockResolvedValue({ ok: false, error: "Database error" });

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    // Should not throw, should proceed without skills
    const { context, enrichedPrompt } = await buildAgentContext(
      createTestAgent(),
      createTestSessionData(workspaceId),
      "Original prompt",
    );

    // Should NOT have load_skill tool
    expect("load_skill" in context.tools).toBe(false);

    // Prompt should be unchanged
    expect(enrichedPrompt).toBe("Original prompt");
  });

  it("does not overwrite existing load_skill tool", async () => {
    const workspaceId = "ws-existing-tool";

    // Create a skill so the injection code path runs
    await tempAdapter.publish("atlas", "test-skill", "user-1", {
      description: "Test skill",
      instructions: "Test instructions",
    });

    // Stub SkillStorage.list
    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());

    // Create a mock "unified" load_skill tool with a distinctive description
    const unifiedLoadSkillTool = {
      description: "Unified load_skill that checks hardcoded skills first",
      parameters: { type: "object", properties: { name: { type: "string" } } },
      execute: () => Promise.resolve({ result: "unified tool" }),
    };

    // Mock createMCPTools to return the unified tool
    mockCreateMCPTools.mockResolvedValue({
      tools: { load_skill: unifiedLoadSkillTool },
      dispose: mockDispose,
    });

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Test prompt",
    );

    // The load_skill tool should be preserved (not overwritten)
    expect("load_skill" in context.tools).toBe(true);
    const loadSkillTool = context.tools.load_skill;
    expect(loadSkillTool?.description).toBe(
      "Unified load_skill that checks hardcoded skills first",
    );
  });

  it("does not inject skills when useWorkspaceSkills is false (default)", async () => {
    const workspaceId = "ws-opt-out";

    // Create a skill in the temp database
    await tempAdapter.publish("atlas", "ignored-skill", "user-1", {
      description: "This skill should be ignored",
      instructions: "Agent did not opt in",
    });

    // Stub SkillStorage.list to use temp adapter
    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    // Agent does NOT opt in to workspace skills (default behavior)
    const { context, enrichedPrompt } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: false }),
      createTestSessionData(workspaceId),
      "Original prompt",
    );

    // Should NOT have load_skill tool
    expect("load_skill" in context.tools).toBe(false);

    // Prompt should NOT contain skills
    expect(enrichedPrompt).toBe("Original prompt");
    expect(enrichedPrompt.includes("<available_skills>")).toBe(false);
    expect(enrichedPrompt.includes("ignored-skill")).toBe(false);
  });

  it("resolves global skill refs into context.skills", async () => {
    const workspaceId = "ws-global-skills";

    // Workspace config includes a global skill ref
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              name: "test-workspace",
              tools: { mcp: { servers: {} } },
              skills: [{ name: "@atlas/review-skill" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    // Publish a skill so SkillStorage.get resolves it
    await tempAdapter.publish("atlas", "review-skill", "user-1", {
      description: "Reviews pull requests",
      instructions: "Review the PR diff carefully",
    });

    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());
    vi.spyOn(SkillStorage, "get").mockImplementation((...args) => tempAdapter.get(...args));

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Review this PR",
    );

    // context.skills should include the resolved global skill
    expect(context.skills).toBeDefined();
    expect(context.skills).toHaveLength(1);
    expect(context.skills?.[0]?.name).toBe("review-skill");
    expect(context.skills?.[0]?.instructions).toBe("Review the PR diff carefully");
  });

  it("handles failed global skill fetch gracefully", async () => {
    const workspaceId = "ws-skill-error";

    // Publish a skill so listUnassigned returns it, then make get() fail
    await tempAdapter.publish("atlas", "broken-skill", "user-1", {
      description: "A broken skill",
      instructions: "Will fail to load",
    });

    vi.spyOn(SkillStorage, "get").mockResolvedValue({
      ok: false,
      error: "Database connection failed",
    });

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    // Should not throw
    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Test prompt",
    );

    // Skills should be undefined (failed skill skipped)
    expect(context.skills).toBeUndefined();
  });

  it("handles missing global skill gracefully", async () => {
    const workspaceId = "ws-skill-missing";

    await tempAdapter.publish("atlas", "deleted-skill", "user-1", {
      description: "A skill that disappears",
      instructions: "Gone before fetch",
    });

    vi.spyOn(SkillStorage, "get").mockResolvedValue({ ok: true, data: null });

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Test prompt",
    );

    expect(context.skills).toBeUndefined();
  });

  it("resolves global skill with archive into referenceFiles", async () => {
    const workspaceId = "ws-archive-skills";

    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              name: "test-workspace",
              tools: { mcp: { servers: {} } },
              skills: [{ name: "@atlas/archive-skill" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    // Create a temp directory with reference files, then pack into archive
    const archiveDir = join(tmpdir(), `skill-archive-test-${Date.now()}`);
    const refsDir = join(archiveDir, "references");
    mkdirSync(refsDir, { recursive: true });
    writeFileSync(join(refsDir, "review-criteria.md"), "# Review Criteria\nCheck for bugs.");
    writeFileSync(join(refsDir, "output-format.md"), "# Output Format\nUse JSON.");
    const archive = await packSkillArchive(archiveDir);
    rmSync(archiveDir, { recursive: true, force: true });

    await tempAdapter.publish("atlas", "archive-skill", "user-1", {
      description: "Skill with archive",
      instructions: "Load [criteria](references/review-criteria.md) for review.",
      archive: new Uint8Array(archive),
    });

    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());
    vi.spyOn(SkillStorage, "get").mockImplementation((...args) => tempAdapter.get(...args));

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Review this PR",
    );

    expect(context.skills).toBeDefined();
    expect(context.skills).toHaveLength(1);

    const skill = context.skills?.[0];
    expect(skill?.name).toBe("archive-skill");
    // Instructions are passed through as-is (relative paths, no transformation)
    expect(skill?.instructions).toContain("references/review-criteria.md");
    // Reference files should be extracted from archive
    expect(skill?.referenceFiles).toBeDefined();
    expect(skill?.referenceFiles?.["references/review-criteria.md"]).toContain("Review Criteria");
    expect(skill?.referenceFiles?.["references/output-format.md"]).toContain("Output Format");
  });

  it("handles archive extraction failure gracefully", async () => {
    const workspaceId = "ws-bad-archive";

    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              name: "test-workspace",
              tools: { mcp: { servers: {} } },
              skills: [{ name: "@atlas/bad-archive-skill" }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    // Publish skill with invalid archive (not a valid tar.gz)
    await tempAdapter.publish("atlas", "bad-archive-skill", "user-1", {
      description: "Skill with bad archive",
      instructions: "Some instructions",
      archive: new Uint8Array([1, 2, 3, 4]),
    });

    vi.spyOn(SkillStorage, "list").mockImplementation(() => tempAdapter.list());
    vi.spyOn(SkillStorage, "get").mockImplementation((...args) => tempAdapter.get(...args));

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Test prompt",
    );

    // Skill should still be included but without referenceFiles
    expect(context.skills).toBeDefined();
    expect(context.skills).toHaveLength(1);
    expect(context.skills?.[0]?.name).toBe("bad-archive-skill");
    expect(context.skills?.[0]?.instructions).toBe("Some instructions");
    expect(context.skills?.[0]?.referenceFiles).toBeUndefined();

    // Should have logged a warning about the extraction failure
    expect(mockWarn).toHaveBeenCalledWith(
      "Failed to extract skill archive",
      expect.objectContaining({ skill: "@atlas/bad-archive-skill" }),
    );
  });
});

describe("buildAgentContext credential error propagation", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDispose.mockResolvedValue(undefined);
    mockCreateMCPTools.mockResolvedValue({ tools: {}, dispose: mockDispose });

    originalFetch = globalThis.fetch;
    globalThis.fetch = mockWorkspaceConfigFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("re-throws when createMCPTools rejects with LinkCredentialNotFoundError", async () => {
    // Simulate the cause-wrapped shape that production emits:
    // enriched LinkCredentialNotFoundError wraps the original as .cause
    const inner = new LinkCredentialNotFoundError("cred_deleted");
    const credError = new LinkCredentialNotFoundError(inner.credentialId, "some-server");
    credError.cause = inner;

    mockCreateMCPTools.mockRejectedValue(credError);

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    await expect(
      buildAgentContext(createTestAgent(), createTestSessionData("ws-cred-fail"), "test"),
    ).rejects.toThrow(credError);
  });

  it("swallows non-credential errors and returns empty tools", async () => {
    mockCreateMCPTools.mockRejectedValue(new Error("connection refused"));

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });

    const { context } = await buildAgentContext(
      createTestAgent(),
      createTestSessionData("ws-generic-fail"),
      "test",
    );

    expect(Object.keys(context.tools)).toHaveLength(0);
  });
});

describe("buildAgentContext mergeServerConfigs precedence", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDispose.mockReset().mockResolvedValue(undefined);
    mockCreateMCPTools.mockReset().mockResolvedValue({ tools: {}, dispose: mockDispose });

    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("agent MCP server overrides workspace server with same ID", async () => {
    // Workspace config has "shared-server" with workspace command
    globalThis.fetch = () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            config: {
              name: "test-workspace",
              tools: {
                mcp: {
                  servers: {
                    "shared-server": {
                      transport: { type: "stdio", command: "workspace-cmd", args: [] },
                    },
                    "workspace-only": {
                      transport: { type: "stdio", command: "ws-only-cmd", args: [] },
                    },
                  },
                },
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    // Agent config has "shared-server" with a DIFFERENT command
    const agentMCPConfig = {
      "shared-server": {
        transport: { type: "stdio" as const, command: "agent-cmd", args: ["--agent"] },
      },
    };

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });
    await buildAgentContext(
      createTestAgent({ mcpConfig: agentMCPConfig }),
      createTestSessionData("ws-merge-test"),
      "test",
    );

    expect(mockCreateMCPTools).toHaveBeenCalledOnce();
    const [configs] = mockCreateMCPTools.mock.calls[0] as [
      Record<string, { transport: { command: string } }>,
    ];

    // Agent's config wins for shared server ID
    const shared = configs["shared-server"];
    expect.assert(shared !== undefined);
    expect(shared.transport.command).toBe("agent-cmd");
    // Workspace-only server preserved
    const wsOnly = configs["workspace-only"];
    expect.assert(wsOnly !== undefined);
    expect(wsOnly.transport.command).toBe("ws-only-cmd");
    // atlas-platform always injected
    expect(configs["atlas-platform"]).toBeDefined();
  });
});

describe("buildAgentContext MCP dispose lifecycle", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockDispose.mockResolvedValue(undefined);
    mockCreateMCPTools.mockResolvedValue({ tools: {}, dispose: mockDispose });

    originalFetch = globalThis.fetch;
    globalThis.fetch = mockWorkspaceConfigFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
  });

  it("releaseMCPTools returns a Promise that awaits dispose()", async () => {
    // Track whether dispose has resolved
    let disposeResolved = false;
    mockDispose.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            disposeResolved = true;
            resolve();
          }, 10);
        }),
    );

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });
    const { releaseMCPTools } = await buildAgentContext(
      createTestAgent(),
      createTestSessionData("ws-dispose"),
      "test",
    );

    // releaseMCPTools should return a Promise we can await
    const result = releaseMCPTools();
    expect(result).toBeInstanceOf(Promise);

    // After awaiting, dispose should have completed
    await result;
    expect(disposeResolved).toBe(true);
  });
});

describe("buildAgentContext memory mount resolution", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockWarn.mockClear();
    mockDispose.mockResolvedValue(undefined);
    mockCreateMCPTools.mockResolvedValue({ tools: {}, dispose: mockDispose });

    originalFetch = globalThis.fetch;
    globalThis.fetch = mockWorkspaceConfigFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    globalThis.fetch = originalFetch;
    clearMountContextRegistry();
  });

  it("resolves memory from registry when memoryContextKey is in session data", async () => {
    const mockMount = {
      name: "backlog",
      source: "_global/narrative/backlog",
      mode: "ro" as const,
      scope: "workspace" as const,
      read: vi.fn().mockResolvedValue([]),
      append: vi.fn(),
    };

    const memoryCtx = { mounts: { backlog: mockMount } };
    const key = "sess-1:test-agent";
    setMountContext(key, memoryCtx);

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });
    const { context } = await buildAgentContext(
      createTestAgent(),
      { ...createTestSessionData("ws-mem"), memoryContextKey: key },
      "test prompt",
    );

    expect(context.memory).toBeDefined();
    expect(context.memory?.mounts.backlog).toBe(mockMount);
  });

  it("takeMountContext removes the entry after consumption", async () => {
    const memoryCtx = { mounts: {} };
    const key = "sess-2:test-agent";
    setMountContext(key, memoryCtx);

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });
    await buildAgentContext(
      createTestAgent(),
      { ...createTestSessionData("ws-consume"), memoryContextKey: key },
      "test",
    );

    // Second take should return undefined (already consumed)
    const { takeMountContext: take } = await import("../mount-context-registry.ts");
    expect(take(key)).toBeUndefined();
  });

  it("overrides.memory takes precedence over registry", async () => {
    const registryCtx = { mounts: { fromRegistry: {} as never } };
    const overrideCtx = { mounts: { fromOverride: {} as never } };
    const key = "sess-3:test-agent";
    setMountContext(key, registryCtx);

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });
    const { context } = await buildAgentContext(
      createTestAgent(),
      { ...createTestSessionData("ws-override"), memoryContextKey: key },
      "test",
      { memory: overrideCtx },
    );

    expect(context.memory).toBe(overrideCtx);
  });

  it("memory is undefined when no registry entry and no override", async () => {
    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });
    const { context } = await buildAgentContext(
      createTestAgent(),
      createTestSessionData("ws-no-mem"),
      "test",
    );

    expect(context.memory).toBeUndefined();
  });

  it("mount binding read/append closures remain callable through context", async () => {
    const mockEntries = [{ id: "1", text: "test entry", createdAt: "2026-04-14T00:00:00Z" }];
    const mockMount = {
      name: "persona",
      source: "ws1/narrative/persona",
      mode: "rw" as const,
      scope: "workspace" as const,
      read: vi.fn().mockResolvedValue(mockEntries),
      append: vi.fn().mockImplementation((entry: unknown) => Promise.resolve(entry)),
    };

    const key = "sess-4:test-agent";
    setMountContext(key, { mounts: { persona: mockMount } });

    const buildAgentContext = createAgentContextBuilder({ logger: mockLogger });
    const { context } = await buildAgentContext(
      createTestAgent(),
      { ...createTestSessionData("ws-closures"), memoryContextKey: key },
      "test",
    );

    const mount = context.memory?.mounts.persona;
    expect(mount).toBeDefined();

    const entries = await mount?.read();
    expect(entries).toEqual(mockEntries);
    expect(mockMount.read).toHaveBeenCalled();
  });
});
