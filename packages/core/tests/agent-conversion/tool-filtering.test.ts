/**
 * Tool Filtering Tests
 *
 * Tests the tool filtering logic used in agent conversion.
 * Covers allow/deny lists, tool merging, and edge cases.
 */

import { assertEquals } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { filterTools, mergeTools } from "../../src/agent-conversion/shared/tool-converter.ts";
import type { AtlasTool } from "@atlas/agent-sdk";

describe("Tool Filtering", () => {
  // Helper to create mock tools
  const createMockTools = (): Record<string, AtlasTool> => ({
    allowed_tool: {
      description: "This tool is allowed",
      execute: () => Promise.resolve({ result: "allowed" }),
    },
    denied_tool: {
      description: "This tool should be denied",
      execute: () => Promise.resolve({ result: "denied" }),
    },
    platform_tool: {
      description: "Platform supervision tool",
      execute: () => Promise.resolve({ result: "platform" }),
    },
    admin_tool: {
      description: "Administrative tool",
      execute: () => Promise.resolve({ result: "admin" }),
    },
    user_tool: {
      description: "Regular user tool",
      execute: () => Promise.resolve({ result: "user" }),
    },
  });

  describe("filterTools", () => {
    it("should allow all tools when no filters provided", () => {
      const tools = createMockTools();
      const filtered = filterTools(tools);

      assertEquals(Object.keys(filtered).length, 5);
      assertEquals(filtered.allowed_tool, tools.allowed_tool);
      assertEquals(filtered.denied_tool, tools.denied_tool);
    });

    it("should filter tools with allowlist", () => {
      const tools = createMockTools();
      const allowlist = ["allowed_tool", "platform_tool"];
      const filtered = filterTools(tools, allowlist);

      assertEquals(Object.keys(filtered).length, 2);
      assertEquals(filtered.allowed_tool, tools.allowed_tool);
      assertEquals(filtered.platform_tool, tools.platform_tool);
      assertEquals(filtered.denied_tool, undefined);
    });

    it("should filter tools with denylist", () => {
      const tools = createMockTools();
      const denylist = ["denied_tool", "admin_tool"];
      const filtered = filterTools(tools, undefined, denylist);

      assertEquals(Object.keys(filtered).length, 3);
      assertEquals(filtered.allowed_tool, tools.allowed_tool);
      assertEquals(filtered.platform_tool, tools.platform_tool);
      assertEquals(filtered.user_tool, tools.user_tool);
      assertEquals(filtered.denied_tool, undefined);
      assertEquals(filtered.admin_tool, undefined);
    });

    it("should apply both allowlist and denylist", () => {
      const tools = createMockTools();
      const allowlist = ["allowed_tool", "denied_tool", "platform_tool"];
      const denylist = ["denied_tool"];
      const filtered = filterTools(tools, allowlist, denylist);

      // Should allow only tools in allowlist that are not in denylist
      assertEquals(Object.keys(filtered).length, 2);
      assertEquals(filtered.allowed_tool, tools.allowed_tool);
      assertEquals(filtered.platform_tool, tools.platform_tool);
      assertEquals(filtered.denied_tool, undefined);
    });

    it("should handle empty allowlist", () => {
      const tools = createMockTools();
      const allowlist: string[] = [];
      const filtered = filterTools(tools, allowlist);

      // Empty allowlist should allow no tools
      assertEquals(Object.keys(filtered).length, 0);
    });

    it("should handle empty denylist", () => {
      const tools = createMockTools();
      const denylist: string[] = [];
      const filtered = filterTools(tools, undefined, denylist);

      // Empty denylist should allow all tools
      assertEquals(Object.keys(filtered).length, 5);
    });

    it("should handle non-existent tool names in filters", () => {
      const tools = createMockTools();
      const allowlist = ["allowed_tool", "nonexistent_tool"];
      const denylist = ["another_nonexistent_tool"];
      const filtered = filterTools(tools, allowlist, denylist);

      assertEquals(Object.keys(filtered).length, 1);
      assertEquals(filtered.allowed_tool, tools.allowed_tool);
    });
  });

  describe("mergeTools", () => {
    it("should merge tools from multiple sources", () => {
      const tools1: Record<string, AtlasTool> = {
        tool1: { description: "Tool 1" },
        tool2: { description: "Tool 2 from source 1" },
      };

      const tools2: Record<string, AtlasTool> = {
        tool2: { description: "Tool 2 from source 2" },
        tool3: { description: "Tool 3" },
      };

      const merged = mergeTools(tools1, tools2);

      assertEquals(Object.keys(merged).length, 3);
      assertEquals(merged.tool1?.description, "Tool 1");
      assertEquals(merged.tool2?.description, "Tool 2 from source 2"); // Later source wins
      assertEquals(merged.tool3?.description, "Tool 3");
    });

    it("should handle empty tool sources", () => {
      const tools1 = createMockTools();
      const tools2: Record<string, AtlasTool> = {};
      const merged = mergeTools(tools1, tools2);

      assertEquals(Object.keys(merged).length, 5);
      assertEquals(merged.allowed_tool, tools1.allowed_tool);
    });

    it("should merge multiple sources in order", () => {
      const tools1: Record<string, AtlasTool> = {
        shared: { description: "From source 1" },
      };

      const tools2: Record<string, AtlasTool> = {
        shared: { description: "From source 2" },
      };

      const tools3: Record<string, AtlasTool> = {
        shared: { description: "From source 3" },
      };

      const merged = mergeTools(tools1, tools2, tools3);

      assertEquals(merged.shared?.description, "From source 3");
    });
  });

  describe("Complex Filtering Scenarios", () => {
    it("should handle server-specific tool filtering", () => {
      // Simulate tools from multiple MCP servers
      const githubTools: Record<string, AtlasTool> = {
        search_code: { description: "Search code" },
        create_issue: { description: "Create issue" },
        delete_repo: { description: "Delete repository" },
      };

      const slackTools: Record<string, AtlasTool> = {
        send_message: { description: "Send message" },
        list_channels: { description: "List channels" },
        delete_channel: { description: "Delete channel" },
      };

      // Merge all tools
      const allTools = mergeTools(githubTools, slackTools);

      // Apply GitHub allowlist
      const githubAllowed = filterTools(allTools, ["search_code", "create_issue"]);
      assertEquals(Object.keys(githubAllowed).length, 2);
      assertEquals(githubAllowed.search_code, githubTools.search_code);
      assertEquals(githubAllowed.create_issue, githubTools.create_issue);

      // Apply Slack denylist
      const slackFiltered = filterTools(allTools, undefined, ["delete_channel"]);
      assertEquals(Object.keys(slackFiltered).length, 5);
      assertEquals(slackFiltered.delete_channel, undefined);
    });

    it("should handle overlapping tool names from different servers", () => {
      const server1Tools: Record<string, AtlasTool> = {
        shared_tool: { description: "Shared tool from server 1" },
        server1_only: { description: "Server 1 only" },
      };

      const server2Tools: Record<string, AtlasTool> = {
        shared_tool: { description: "Shared tool from server 2" },
        server2_only: { description: "Server 2 only" },
      };

      const merged = mergeTools(server1Tools, server2Tools);

      // Later server should override
      assertEquals(merged.shared_tool?.description, "Shared tool from server 2");
      assertEquals(Object.keys(merged).length, 3);
    });

    it("should handle case-sensitive tool names", () => {
      const tools: Record<string, AtlasTool> = {
        MyTool: { description: "Capital case tool" },
        mytool: { description: "Lowercase tool" },
        myTool: { description: "Camel case tool" },
      };

      const allowlist = ["MyTool", "mytool"];
      const filtered = filterTools(tools, allowlist);

      assertEquals(Object.keys(filtered).length, 2);
      assertEquals(filtered.MyTool, tools.MyTool);
      assertEquals(filtered.mytool, tools.mytool);
      assertEquals(filtered.myTool, undefined);
    });

    it("should handle special characters in tool names", () => {
      const tools: Record<string, AtlasTool> = {
        "tool-with-dashes": { description: "Tool with dashes" },
        "tool_with_underscores": { description: "Tool with underscores" },
        "tool.with.dots": { description: "Tool with dots" },
        "tool@with@symbols": { description: "Tool with symbols" },
      };

      const allowlist = ["tool-with-dashes", "tool_with_underscores"];
      const filtered = filterTools(tools, allowlist);

      assertEquals(Object.keys(filtered).length, 2);
      assertEquals(filtered["tool-with-dashes"], tools["tool-with-dashes"]);
      assertEquals(filtered["tool_with_underscores"], tools["tool_with_underscores"]);
    });
  });

  describe("Performance and Edge Cases", () => {
    it("should handle large numbers of tools efficiently", () => {
      // Create 1000 tools
      const tools: Record<string, AtlasTool> = {};
      for (let i = 0; i < 1000; i++) {
        tools[`tool_${i}`] = {
          description: `Tool number ${i}`,
          execute: () => Promise.resolve({ result: i }),
        };
      }

      // Filter to first 100
      const allowlist = Array.from({ length: 100 }, (_, i) => `tool_${i}`);
      const filtered = filterTools(tools, allowlist);

      assertEquals(Object.keys(filtered).length, 100);
      assertEquals(filtered.tool_0, tools.tool_0);
      assertEquals(filtered.tool_99, tools.tool_99);
      assertEquals(filtered.tool_100, undefined);
    });

    it("should handle empty tools object", () => {
      const tools: Record<string, AtlasTool> = {};
      const allowlist = ["nonexistent"];
      const denylist = ["also_nonexistent"];
      const filtered = filterTools(tools, allowlist, denylist);

      assertEquals(Object.keys(filtered).length, 0);
    });
  });
});
