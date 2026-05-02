import type { AtlasTool, AtlasTools } from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  filterWorkspaceAgentTools,
  LLM_AGENT_ALLOWED_PLATFORM_TOOLS,
  PLATFORM_TOOL_NAMES,
  SCOPE_INJECTED_PLATFORM_TOOLS,
  wrapPlatformToolsWithScope,
} from "./agent-tool-filters.ts";

const stubLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
} as unknown as Parameters<typeof filterWorkspaceAgentTools>[1];

function makeTool(name: string): AtlasTool {
  return {
    description: name,
    inputSchema: { type: "object", properties: {} },
  } as unknown as AtlasTool;
}

function makeTools(names: string[]): AtlasTools {
  return Object.fromEntries(names.map((n) => [n, makeTool(n)]));
}

describe("filterWorkspaceAgentTools", () => {
  it("blocks platform management tools", () => {
    const tools = makeTools([
      "workspace_list",
      "workspace_delete",
      "session_describe",
      "workspace_agents_list",
      "system_version",
      "fs_read_file",
      "bash",
    ]);

    const result = filterWorkspaceAgentTools(tools, stubLogger);

    expect(result).not.toHaveProperty("workspace_list");
    expect(result).not.toHaveProperty("workspace_delete");
    expect(result).not.toHaveProperty("session_describe");
    expect(result).not.toHaveProperty("workspace_agents_list");
    expect(result).not.toHaveProperty("system_version");
  });

  it("allows permitted platform tools", () => {
    const tools = makeTools([
      "fs_read_file",
      "fs_write_file",
      "bash",
      "csv",
      "webfetch",
      "artifacts_create",
      "convert_task_to_workspace",
      "workspace_signal_trigger",
    ]);

    const result = filterWorkspaceAgentTools(tools, stubLogger);

    expect(Object.keys(result)).toEqual(Object.keys(tools));
  });

  it("passes through external MCP server tools", () => {
    const tools = makeTools([
      "my_custom_tool",
      "github_create_issue",
      "slack_post_message",
      "workspace_list", // blocked platform tool mixed in
    ]);

    const result = filterWorkspaceAgentTools(tools, stubLogger);

    expect(result).toHaveProperty("my_custom_tool");
    expect(result).toHaveProperty("github_create_issue");
    expect(result).toHaveProperty("slack_post_message");
    expect(result).not.toHaveProperty("workspace_list");
  });

  it("tools not in PLATFORM_TOOL_NAMES pass through as external", () => {
    // Tools not recognized as platform tools are treated as external MCP tools
    // and pass through unfiltered. To block a new platform tool, add it to
    // PLATFORM_TOOL_NAMES in @atlas/agent-sdk/src/platform-tools.ts.
    const tools = makeTools(["hypothetical_new_tool"]);
    const result = filterWorkspaceAgentTools(tools, stubLogger);
    expect(result).toHaveProperty("hypothetical_new_tool");
  });

  it("PLATFORM_TOOL_NAMES is non-empty and contains expected entries", () => {
    expect(PLATFORM_TOOL_NAMES.size).toBeGreaterThan(20);
    expect(PLATFORM_TOOL_NAMES.has("workspace_list")).toBe(true);
    expect(PLATFORM_TOOL_NAMES.has("bash")).toBe(true);
    expect(PLATFORM_TOOL_NAMES.has("webfetch")).toBe(true);
  });
});

describe("allowlist/wrap-list invariant", () => {
  // Invariant: SCOPE_INJECTED ⊂ LLM_AGENT_ALLOWED. The wrap-list (tools that
  // need workspaceId injection) is a strict subset of the allow-list (tools
  // an LLM agent is permitted to call). Conflating them — using the
  // wrap-list as the filter — silently strips fs_*, bash, csv from one or
  // more execution paths. Past regression: fsm-engine.ts aliased
  // PLATFORM_TOOL_ALLOWLIST = SCOPE_INJECTED_PLATFORM_TOOLS, breaking the
  // canonical write-file-then-artifacts_create pattern in FSM LLM actions.
  it("SCOPE_INJECTED is a strict subset of LLM_AGENT_ALLOWED", () => {
    for (const tool of SCOPE_INJECTED_PLATFORM_TOOLS) {
      expect(LLM_AGENT_ALLOWED_PLATFORM_TOOLS.has(tool)).toBe(true);
    }
    expect(LLM_AGENT_ALLOWED_PLATFORM_TOOLS.size).toBeGreaterThan(
      SCOPE_INJECTED_PLATFORM_TOOLS.size,
    );
  });

  it("LLM_AGENT_ALLOWED includes the broad surface (fs_*, bash, csv)", () => {
    // Pin specific tools that have to stay in the allow-list — these are
    // the ones the writing-to-memory and writing-friday-python-agents
    // skills depend on.
    const required = ["fs_write_file", "fs_read_file", "fs_glob", "fs_grep", "bash", "csv"];
    for (const tool of required) {
      expect(LLM_AGENT_ALLOWED_PLATFORM_TOOLS.has(tool)).toBe(true);
    }
  });

  it("SCOPE_INJECTED holds only tools that need workspace-id injection", () => {
    // These tools are scope-bound to a workspace at the runtime layer; the
    // LLM never passes workspaceId. Other LLM-allowed tools (bash, fs_*,
    // csv) operate on the host directly and don't carry
    // workspace identity.
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("memory_save")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("artifacts_create")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("state_append")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("webfetch")).toBe(true);
    // These are explicitly NOT scope-injected — they don't operate on
    // workspace-scoped state.
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("fs_write_file")).toBe(false);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("bash")).toBe(false);
  });
});

describe("wrapPlatformToolsWithScope", () => {
  function makeExecutableTool(name: string, capture: { args?: unknown }): AtlasTool {
    return {
      description: name,
      inputSchema: { type: "object", properties: {} },
      execute: (args: unknown) => {
        capture.args = args;
        return Promise.resolve({ ok: true });
      },
    } as unknown as AtlasTool;
  }

  it("injects workspaceId on allowlisted platform tools", async () => {
    const capture: { args?: unknown } = {};
    const tools: AtlasTools = { memory_save: makeExecutableTool("memory_save", capture) };

    const wrapped = wrapPlatformToolsWithScope(tools, { workspaceId: "young_kale" });
    await wrapped.memory_save?.execute?.(
      { memoryName: "notes", text: "hi" },
      { toolCallId: "t1", messages: [] },
    );

    expect(capture.args).toEqual({ memoryName: "notes", text: "hi", workspaceId: "young_kale" });
  });

  it("injects workspaceName when provided", async () => {
    const capture: { args?: unknown } = {};
    const tools: AtlasTools = { state_append: makeExecutableTool("state_append", capture) };

    const wrapped = wrapPlatformToolsWithScope(tools, {
      workspaceId: "ws_1",
      workspaceName: "Inbox Zero",
    });
    await wrapped.state_append?.execute?.(
      { key: "k", entry: "e" },
      { toolCallId: "t1", messages: [] },
    );

    expect(capture.args).toEqual({
      key: "k",
      entry: "e",
      workspaceId: "ws_1",
      workspaceName: "Inbox Zero",
    });
  });

  it("overrides caller-supplied workspaceId (defense in depth)", async () => {
    const capture: { args?: unknown } = {};
    const tools: AtlasTools = { memory_read: makeExecutableTool("memory_read", capture) };

    const wrapped = wrapPlatformToolsWithScope(tools, { workspaceId: "real_ws" });
    await wrapped.memory_read?.execute?.(
      { memoryName: "notes", workspaceId: "spoofed_ws" },
      { toolCallId: "t1", messages: [] },
    );

    expect((capture.args as { workspaceId: string }).workspaceId).toBe("real_ws");
  });

  it("does not wrap non-allowlisted platform tools", async () => {
    const capture: { args?: unknown } = {};
    const tools: AtlasTools = {
      // bash is in PLATFORM_TOOL_NAMES but NOT in SCOPE_INJECTED_PLATFORM_TOOLS
      bash: makeExecutableTool("bash", capture),
    };

    const wrapped = wrapPlatformToolsWithScope(tools, { workspaceId: "ws_1" });
    await wrapped.bash?.execute?.({ cmd: "ls" }, { toolCallId: "t1", messages: [] });

    expect(capture.args).toEqual({ cmd: "ls" });
  });

  it("passes external MCP tools through untouched", async () => {
    const capture: { args?: unknown } = {};
    const tools: AtlasTools = {
      github_create_issue: makeExecutableTool("github_create_issue", capture),
    };

    const wrapped = wrapPlatformToolsWithScope(tools, { workspaceId: "ws_1" });
    await wrapped.github_create_issue?.execute?.(
      { title: "bug" },
      { toolCallId: "t1", messages: [] },
    );

    expect(capture.args).toEqual({ title: "bug" });
  });

  it("SCOPE_INJECTED_PLATFORM_TOOLS contains memory + artifacts + state + webfetch", () => {
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("memory_save")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("memory_read")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("memory_remove")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("artifacts_create")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("state_append")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("webfetch")).toBe(true);
  });
});
