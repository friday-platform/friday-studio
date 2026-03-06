/**
 * Tests for agent-context skill injection
 *
 * Tests that buildAgentContext:
 * 1. Adds load_skill tool when skills exist AND agent.useWorkspaceSkills is true
 * 2. Appends <available_skills> to prompt when agent opts in
 * 3. Works correctly with empty skills list
 * 4. Skills NOT injected when agent.useWorkspaceSkills is false (default)
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasAgent } from "@atlas/agent-sdk";
import { SkillStorage } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Import LocalSkillAdapter directly from file since it's not exported from the package
import { LocalSkillAdapter } from "../../../skills/src/local-adapter.ts";
import { LinkCredentialNotFoundError } from "../mcp-registry/credential-resolver.ts";
import { createAgentContextBuilder } from "./index.ts";

// Mock createMCPTools — default returns empty tools with noop dispose
const mockDispose = vi.fn().mockResolvedValue(undefined);
const mockCreateMCPTools = vi.fn().mockResolvedValue({ tools: {}, dispose: mockDispose });

vi.mock("@atlas/mcp", () => ({
  createMCPTools: (...args: unknown[]) => mockCreateMCPTools(...args),
}));

// Mock logger
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
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
    mockDispose.mockResolvedValue(undefined);
    mockCreateMCPTools.mockResolvedValue({ tools: {}, dispose: mockDispose });

    // Create temp database for skills
    tempDbPath = join(tmpdir(), `skills-test-${Date.now()}.db`);
    tempAdapter = new LocalSkillAdapter(tempDbPath);

    // Mock fetch for workspace config
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockWorkspaceConfigFetch();
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
