import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { type ZodRawShape, z } from "zod";
import type { ToolContext } from "../types.ts";
import { registerArtifactsCreateTool } from "./create.ts";
import { artifactsDeleteTool } from "./delete.ts";
import { registerArtifactsGetTool } from "./get.ts";
import { registerArtifactsGetByChatTool } from "./get-by-chat.ts";
import { registerArtifactsParseTool } from "./parse.ts";
import { registerArtifactsUpdateTool } from "./update.ts";

/**
 * Regression: MCP `tools/list` invokes `z.toJSONSchema(z.object(inputSchema))`
 * on every registered tool. A `z.instanceof(...)` (custom type) anywhere in
 * the schema graph throws "Custom types cannot be represented in JSON Schema",
 * which kills the entire `tools/list` response — every consumer (workspace
 * LLM agents) then loses access to ALL atlas-platform tools, not just the
 * offending one.
 *
 * This test pins each artifacts tool's input schema to a JSON-Schema-safe
 * shape so the failure mode can't silently regress.
 */

type Registrar = (server: McpServer, ctx: ToolContext) => void;

function captureInputSchema(register: Registrar): ZodRawShape {
  let captured: ZodRawShape | undefined;

  const mockServer = {
    registerTool: vi.fn<(name: string, config: { inputSchema?: ZodRawShape }) => void>(
      (_name, config) => {
        captured = config.inputSchema;
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
      child: vi.fn(),
    } as unknown as ToolContext["logger"],
    server: mockServer as unknown as ToolContext["server"],
  };

  register(mockServer as unknown as McpServer, ctx);

  if (!captured) {
    throw new Error("registrar did not call registerTool with an inputSchema");
  }
  return captured;
}

const tools: ReadonlyArray<{ name: string; register: Registrar }> = [
  { name: "artifacts_create", register: registerArtifactsCreateTool },
  { name: "artifacts_update", register: registerArtifactsUpdateTool },
  { name: "artifacts_get", register: registerArtifactsGetTool },
  { name: "artifacts_get_by_chat", register: registerArtifactsGetByChatTool },
  { name: "artifacts_delete", register: artifactsDeleteTool },
  { name: "parse_artifact", register: registerArtifactsParseTool },
];

describe("artifacts MCP tool inputs are JSON-Schema serializable", () => {
  for (const { name, register } of tools) {
    it(`${name}: z.toJSONSchema does not throw`, () => {
      const shape = captureInputSchema(register);
      expect(() => z.toJSONSchema(z.object(shape))).not.toThrow();
    });
  }
});
