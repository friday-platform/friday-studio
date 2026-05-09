import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  execute: vi.fn(),
  createMCPTools: vi.fn(),
  dispose: vi.fn(),
}));

vi.mock("@atlas/system/agents", () => ({ judgeAgent: { execute: mockState.execute } }));

vi.mock("@atlas/mcp", () => ({ createMCPTools: mockState.createMCPTools }));

vi.mock("@atlas/oapi-client", () => ({
  getAtlasPlatformServerConfig: () => ({ transport: { type: "http", url: "http://daemon/mcp" } }),
}));

import { createJudgeRunner } from "./judge-runner.ts";

function platformModels() {
  return { get: vi.fn() } as never;
}

describe("createJudgeRunner", () => {
  beforeEach(() => {
    mockState.execute.mockReset();
    mockState.createMCPTools.mockReset();
    mockState.dispose.mockReset();
    const verdict = { verdict: "pass" as const };
    mockState.execute.mockResolvedValue({ ok: true, data: verdict });
    mockState.createMCPTools.mockResolvedValue({
      tools: {
        artifacts_get: { description: "get artifact", execute: vi.fn() },
        parse_artifact: { description: "parse artifact", execute: vi.fn() },
        unrelated: { description: "not for judge", execute: vi.fn() },
      },
      toolsByServer: { "atlas-platform": ["artifacts_get", "parse_artifact", "unrelated"] },
      disconnected: [],
      dispose: mockState.dispose,
    });
  });

  it("supplies artifact tools and parent context to the judge agent", async () => {
    const runner = createJudgeRunner(platformModels());

    const result = await runner({
      agentId: "judge-agent",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      handoff: { actionInput: "input", actionOutput: "output", toolCalls: [] },
    });

    expect(result).toEqual({ ok: true, verdict: { verdict: "pass" } });
    expect(mockState.createMCPTools).toHaveBeenCalledOnce();
    const ctx = mockState.execute.mock.calls[0]?.[1] as {
      tools: Record<string, unknown>;
      session: { workspaceId: string; sessionId: string; streamId: string };
    };
    expect(Object.keys(ctx.tools).sort()).toEqual(["artifacts_get", "parse_artifact"]);
    expect(ctx.session.workspaceId).toBe("ws_1");
    expect(ctx.session.sessionId).toBe("judge-sess_1");
    expect(ctx.session.streamId).toBe("judge-sess_1");
    expect(mockState.dispose).toHaveBeenCalledOnce();
  });
});
