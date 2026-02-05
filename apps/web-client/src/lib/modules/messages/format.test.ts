import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import { describe, expect, it } from "vitest";
import { formatMessage } from "./format.ts";
import { parseWorkspacePlannerArtifactId } from "./types.ts";

/** Minimal message fixture - only fields formatMessage reads. */
function createMessage(role: "user" | "assistant"): Pick<AtlasUIMessage, "id" | "role"> {
  return { id: "test-msg", role };
}

/**
 * Creates tool part fixture with required AI SDK fields.
 * formatMessage only reads type/output, but the SDK requires toolCallId/state.
 */
function createToolPart<T extends `tool-${string}`>(
  type: T,
  output?: unknown,
): Extract<AtlasUIMessagePart, { type: T }> {
  return {
    type,
    toolCallId: "test-call",
    toolName: type.replace("tool-", ""),
    args: {},
    state: "result",
    output,
  } as Extract<AtlasUIMessagePart, { type: T }>;
}

function createDataPart<T extends `data-${string}`>(
  type: T,
  data: unknown,
): Extract<AtlasUIMessagePart, { type: T }> {
  return { type, data } as Extract<AtlasUIMessagePart, { type: T }>;
}

describe("formatMessage - connect_service tool", () => {
  it("extracts provider from tool output", () => {
    const message = createMessage("assistant");
    const part = createToolPart("tool-connect_service", { provider: "linear" });

    const result = formatMessage(message as AtlasUIMessage, part);

    expect(result).toMatchObject({ type: "connect_service", provider: "linear" });
  });
});

describe("formatMessage - display_artifact tool", () => {
  it("extracts artifactId from tool output", () => {
    const message = createMessage("assistant");
    const part = createToolPart("tool-display_artifact", { artifactId: "art-123" });

    const result = formatMessage(message as AtlasUIMessage, part);

    expect(result).toMatchObject({ type: "display_artifact", artifactId: "art-123" });
  });
});

describe("formatMessage - fsm-workspace-creator tool", () => {
  it("falls through to tool_call when output lacks result.content", () => {
    const message = createMessage("assistant");
    const part = createToolPart("tool-fsm-workspace-creator", { result: {} });

    const result = formatMessage(message as AtlasUIMessage, part);

    expect(result).toMatchObject({ type: "tool_call" });
  });

  it("returns workspace_creator when output has valid structure", () => {
    const message = createMessage("assistant");
    const agentResult = {
      agentId: "fsm-workspace-creator",
      timestamp: "2026-02-04T12:00:00.000Z",
      input: { artifactId: "test-artifact" },
      durationMs: 1234,
      ok: true,
      data: {
        workspaceId: "ws-123",
        workspaceName: "Test Workspace",
        workspaceDescription: "A test workspace",
        workspaceUrl: "/spaces/ws-123",
        jobCount: 1,
        metadata: { generatedCode: {}, codegenAttempts: {} },
      },
    };
    const part = createToolPart("tool-fsm-workspace-creator", {
      result: { content: [{ type: "text", text: JSON.stringify(agentResult) }] },
    });

    const result = formatMessage(message as AtlasUIMessage, part);

    expect(result).toMatchObject({ type: "workspace_creator" });
    // Output passed through raw - downstream does its own parsing
    if (result?.type === "workspace_creator") {
      const text = result.output.result.content[0]?.text;
      expect(text).toBe(JSON.stringify(agentResult));
    }
  });
});

describe("formatMessage - data-agent-* events", () => {
  it("extracts error from data-agent-error event", () => {
    const message = createMessage("assistant");
    const part = createDataPart("data-agent-error", {
      agentId: "test-agent",
      duration: 1500,
      error: "Connection failed",
    });

    const result = formatMessage(message as AtlasUIMessage, part);

    expect(result).toMatchObject({ type: "error", content: "Connection failed" });
  });

  it("extracts error from data-agent-timeout event", () => {
    const message = createMessage("assistant");
    const part = createDataPart("data-agent-timeout", {
      agentId: "slow-agent",
      task: "Process data",
      duration: 30000,
      error: "Agent execution exceeded 30s timeout",
    });

    const result = formatMessage(message as AtlasUIMessage, part);

    expect(result).toMatchObject({
      type: "error",
      content: "Agent execution exceeded 30s timeout",
    });
  });
});

describe("parseWorkspacePlannerArtifactId", () => {
  it("extracts artifactId from execution result envelope", () => {
    const agentResult = {
      agentId: "workspace-planner",
      timestamp: "2026-02-04T12:00:00.000Z",
      input: "Create a workspace",
      durationMs: 5000,
      ok: true,
      data: { artifactId: "artifact-xyz-123" },
    };
    const executionEnvelope = { type: "completed", result: agentResult };
    const output = {
      result: { content: [{ type: "text", text: JSON.stringify(executionEnvelope) }] },
    };

    expect(parseWorkspacePlannerArtifactId(output)).toBe("artifact-xyz-123");
  });

  it("returns undefined for error result (ok: false)", () => {
    const agentResult = {
      agentId: "workspace-planner",
      timestamp: "2026-02-04T12:00:00.000Z",
      input: "Create a workspace",
      durationMs: 100,
      ok: false,
      error: { reason: "Something went wrong" },
    };
    const executionEnvelope = { type: "completed", result: agentResult };
    const output = {
      result: { content: [{ type: "text", text: JSON.stringify(executionEnvelope) }] },
    };

    expect(parseWorkspacePlannerArtifactId(output)).toBeUndefined();
  });
});
