import { describe, expect, it, vi } from "vitest";
import { type CodeAgentExecutorOptions, serializeAgentContext } from "./agent-executor-utils.ts";

function baseOptions(): CodeAgentExecutorOptions {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      child: vi.fn().mockReturnThis(),
    } as unknown as CodeAgentExecutorOptions["logger"],
    mcpToolCall: vi.fn(),
    mcpListTools: vi.fn(),
    sessionContext: { id: "sess-1", workspaceId: "ws-1" },
  };
}

describe("serializeAgentContext", () => {
  it("includes structured action input for Python SDK ctx.input", () => {
    const serialized = serializeAgentContext({
      ...baseOptions(),
      input: {
        task: "compact input",
        config: {
          "fetched-emails": {
            summary: "Fetched unread emails",
            artifactRefs: [
              { id: "artifact-1", type: "AgentResult", summary: "Fetched unread emails" },
            ],
          },
        },
      },
    });

    expect(JSON.parse(serialized)).toMatchObject({
      input: {
        task: "compact input",
        config: {
          "fetched-emails": {
            summary: "Fetched unread emails",
            artifactRefs: [
              { id: "artifact-1", type: "AgentResult", summary: "Fetched unread emails" },
            ],
          },
        },
      },
    });
  });

  it("defaults structured input to an empty object for older call sites", () => {
    const serialized = serializeAgentContext(baseOptions());

    expect(JSON.parse(serialized)).toHaveProperty("input", {});
  });
});
