import type { AtlasTool, AtlasTools } from "@atlas/agent-sdk";
import { describe, expect, it, vi } from "vitest";
import { filterWorkspaceAgentTools, PLATFORM_TOOL_NAMES } from "./agent-tool-filters.ts";

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
      "library_list",
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
