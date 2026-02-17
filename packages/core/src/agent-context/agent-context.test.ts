/**
 * Tests for agent-context skill injection
 *
 * Tests that buildAgentContext:
 * 1. Adds load_skill tool when skills exist AND agent.useWorkspaceSkills is true
 * 2. Appends <available_skills> to prompt when agent opts in
 * 3. Works correctly with empty skills list
 * 4. Skills from wrong workspace not included
 * 5. Skills NOT injected when agent.useWorkspaceSkills is false (default)
 */

import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AtlasAgent } from "@atlas/agent-sdk";
import { SkillStorage } from "@atlas/skills";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// Import LocalSkillAdapter directly from file since it's not exported from the package
import { LocalSkillAdapter } from "../../../skills/src/local-adapter.ts";
import { createAgentContextBuilder } from "./index.ts";

// Store original methods for restoration
const originalList = SkillStorage.list.bind(SkillStorage);

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

// Mock MCP server pool - returns empty tools
const mockMcpServerPool = {
  getMCPManager: () => Promise.resolve({ getToolsForServers: () => Promise.resolve({}) }),
  releaseMCPManager: () => {},
} as unknown as Parameters<typeof createAgentContextBuilder>[0]["mcpServerPool"];

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
    // Create temp database for skills
    tempDbPath = join(tmpdir(), `skills-test-${Date.now()}.db`);
    tempAdapter = new LocalSkillAdapter(tempDbPath);

    // Mock fetch for workspace config
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockWorkspaceConfigFetch();
  });

  afterEach(() => {
    // Restore original SkillStorage.list
    SkillStorage.list = originalList;

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
    await tempAdapter.create("user-1", {
      name: "my-skill",
      description: "A useful skill",
      instructions: "Do the thing",
      workspaceId,
    });

    // Stub SkillStorage.list to use temp adapter
    SkillStorage.list = (wsId: string) => tempAdapter.list(wsId);

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpServerPool,
      logger: mockLogger,
    });

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
    await tempAdapter.create("user-1", {
      name: "debug-helper",
      description: "Helps with debugging",
      instructions: "Use this for debugging",
      workspaceId,
    });

    // Stub SkillStorage.list
    SkillStorage.list = (wsId: string) => tempAdapter.list(wsId);

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpServerPool,
      logger: mockLogger,
    });

    const { enrichedPrompt } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Original prompt",
    );

    // Prompt should contain <available_skills> section
    expect(enrichedPrompt).toContain("<available_skills>");
    expect(enrichedPrompt).toContain("</available_skills>");
    expect(enrichedPrompt).toContain('name="debug-helper"');
    expect(enrichedPrompt).toContain("Helps with debugging");
    // Original prompt should still be present
    expect(enrichedPrompt).toContain("Original prompt");
  });

  it("works correctly with empty skills list", async () => {
    const workspaceId = "ws-no-skills";

    // No skills created for this workspace - list returns empty array
    SkillStorage.list = (wsId: string) => tempAdapter.list(wsId);

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpServerPool,
      logger: mockLogger,
    });

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

  it("skills from wrong workspace not included", async () => {
    const workspace1 = "ws-1";
    const workspace2 = "ws-2";

    // Create skill in workspace 1
    await tempAdapter.create("user-1", {
      name: "ws1-skill",
      description: "Skill for workspace 1",
      instructions: "Instructions for ws1",
      workspaceId: workspace1,
    });

    // Create skill in workspace 2
    await tempAdapter.create("user-1", {
      name: "ws2-skill",
      description: "Skill for workspace 2",
      instructions: "Instructions for ws2",
      workspaceId: workspace2,
    });

    // Stub SkillStorage.list
    SkillStorage.list = (wsId: string) => tempAdapter.list(wsId);

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpServerPool,
      logger: mockLogger,
    });

    // Build context for workspace 1
    const { enrichedPrompt: prompt1 } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspace1),
      "Test prompt",
    );

    // Should contain ws1 skill, not ws2 skill
    expect(prompt1).toContain("ws1-skill");
    expect(prompt1).toContain("Skill for workspace 1");
    expect(prompt1.includes("ws2-skill")).toBe(false);
    expect(prompt1.includes("Skill for workspace 2")).toBe(false);

    // Build context for workspace 2
    const { enrichedPrompt: prompt2 } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspace2),
      "Test prompt",
    );

    // Should contain ws2 skill, not ws1 skill
    expect(prompt2).toContain("ws2-skill");
    expect(prompt2).toContain("Skill for workspace 2");
    expect(prompt2.includes("ws1-skill")).toBe(false);
    expect(prompt2.includes("Skill for workspace 1")).toBe(false);
  });

  it("load_skill tool is scoped to correct workspace", async () => {
    const workspaceId = "ws-tool-scope";

    await tempAdapter.create("user-1", {
      name: "scoped-skill",
      description: "Test scoping",
      instructions: "Scoped instructions",
      workspaceId,
    });

    // Stub SkillStorage methods
    SkillStorage.list = (wsId: string) => tempAdapter.list(wsId);

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpServerPool,
      logger: mockLogger,
    });

    const { context } = await buildAgentContext(
      createTestAgent({ useWorkspaceSkills: true }),
      createTestSessionData(workspaceId),
      "Test",
    );

    // The load_skill tool should exist and be a tool object
    expect("load_skill" in context.tools).toBe(true);
    const loadSkillTool = context.tools.load_skill;
    expect(typeof loadSkillTool).toBe("object");

    // Tool should have description and input schema
    if (loadSkillTool) {
      expect(typeof loadSkillTool.description).toBe("string");
      expect(loadSkillTool.description ?? "").toContain(
        "Load skill instructions BEFORE starting a task",
      );
    }
  });

  it("handles SkillStorage.list returning error gracefully", async () => {
    const workspaceId = "ws-error";

    // Stub SkillStorage.list to return an error
    SkillStorage.list = () => Promise.resolve({ ok: false, error: "Database error" });

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpServerPool,
      logger: mockLogger,
    });

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
    await tempAdapter.create("user-1", {
      name: "test-skill",
      description: "Test skill",
      instructions: "Test instructions",
      workspaceId,
    });

    // Stub SkillStorage.list
    SkillStorage.list = (wsId: string) => tempAdapter.list(wsId);

    // Create a mock "unified" load_skill tool with a distinctive description
    const unifiedLoadSkillTool = {
      description: "Unified load_skill that checks hardcoded skills first",
      parameters: { type: "object", properties: { name: { type: "string" } } },
      execute: () => Promise.resolve({ result: "unified tool" }),
    };

    // Mock MCP server pool that returns the unified tool
    const mockMcpPoolWithTool = {
      getMCPManager: () =>
        Promise.resolve({
          getToolsForServers: () => Promise.resolve({ load_skill: unifiedLoadSkillTool }),
        }),
      releaseMCPManager: () => {},
    } as unknown as Parameters<typeof createAgentContextBuilder>[0]["mcpServerPool"];

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpPoolWithTool,
      logger: mockLogger,
    });

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
    await tempAdapter.create("user-1", {
      name: "ignored-skill",
      description: "This skill should be ignored",
      instructions: "Agent did not opt in",
      workspaceId,
    });

    // Stub SkillStorage.list to use temp adapter
    SkillStorage.list = (wsId: string) => tempAdapter.list(wsId);

    const buildAgentContext = createAgentContextBuilder({
      mcpServerPool: mockMcpServerPool,
      logger: mockLogger,
    });

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
