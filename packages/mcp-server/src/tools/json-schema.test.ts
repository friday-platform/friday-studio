import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { type ZodRawShape, z } from "zod";
import { registerTools } from "./index.ts";
import type { ToolContext } from "./types.ts";

/**
 * Regression: MCP `tools/list` invokes `z.toJSONSchema(z.object(inputSchema))`
 * on every registered tool. A `z.instanceof(...)` (or other custom type)
 * anywhere in the schema graph throws "Custom types cannot be represented in
 * JSON Schema", which kills the entire `tools/list` response — every consumer
 * (workspace LLM agents, jobs, user-SDK agents) then loses access to ALL
 * atlas-platform tools, not just the offending one.
 *
 * This test boots the canonical `registerTools()` entry point against a mock
 * server, captures every input schema, and asserts `z.toJSONSchema` succeeds
 * on each. Catches the bug *class*, not just the artifacts instance — any
 * future tool that sneaks a non-serializable zod type into its input will
 * fail this test before it can wipe the catalog in production.
 */

type CapturedTool = { name: string; inputSchema: ZodRawShape };

function captureAllTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];

  const mockServer = {
    registerTool: vi.fn<(name: string, config: { inputSchema?: ZodRawShape }) => void>(
      (name, config) => {
        captured.push({ name, inputSchema: config.inputSchema ?? {} });
      },
    ),
  };

  const ctx: ToolContext = {
    daemonUrl: "http://localhost:8080",
    logger: {
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(() => ctx.logger),
    } as unknown as ToolContext["logger"],
    server: mockServer as unknown as ToolContext["server"],
  };

  registerTools(mockServer as unknown as McpServer, ctx);

  return captured;
}

describe("MCP tool inputs are JSON-Schema serializable", () => {
  const tools = captureAllTools();

  it("registry has tools registered", () => {
    expect(tools.length).toBeGreaterThan(20);
  });

  for (const { name, inputSchema } of tools) {
    it(`${name}: z.toJSONSchema does not throw`, () => {
      expect(() => z.toJSONSchema(z.object(inputSchema))).not.toThrow();
    });
  }
});
