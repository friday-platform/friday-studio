import { createLogger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockEmit, mockClientGet, mockParseResult } = vi.hoisted(() => ({
  mockEmit: vi.fn(),
  mockClientGet: vi.fn(),
  mockParseResult: vi.fn(),
}));

vi.mock("@atlas/core/elicitations", async () => {
  const actual = await vi.importActual<typeof import("@atlas/core/elicitations")>(
    "@atlas/core/elicitations",
  );
  return { ...actual, emitWorkspaceSetupElicitation: mockEmit };
});

vi.mock("@atlas/client/v2", () => ({
  client: { workspace: { ":workspaceId": { $get: mockClientGet } } },
  parseResult: mockParseResult,
}));

import { createRequestWorkspaceSetupTool } from "./request-workspace-setup.ts";

const logger = createLogger({ name: "test" });
const ctx = { toolCallId: "tc_1", messages: [] };

interface ExecTool {
  execute: (args: Record<string, unknown>, ctx: unknown) => Promise<Record<string, unknown>>;
}

function makeTool() {
  const t = createRequestWorkspaceSetupTool({
    workspaceId: "ws_test",
    sessionId: "chat_session_1",
    logger,
  }) as unknown as { request_workspace_setup: ExecTool };
  return t.request_workspace_setup;
}

describe("request_workspace_setup", () => {
  beforeEach(() => {
    mockEmit.mockReset();
    mockClientGet.mockReset();
    mockParseResult.mockReset();
  });

  it("fetches a fresh derivation and emits a session-scoped workspace-setup elicitation", async () => {
    const setupRequirements = [
      { kind: "variable", name: "region", description: "AWS region", schema: { type: "string" } },
      {
        kind: "credential",
        provider: "gmail",
        path: "tools.mcp.servers.gmail.env.TOKEN",
        key: "access_token",
        reason: "no_default",
      },
    ];

    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { id: "ws_test", requires_setup: true, setup_requirements: setupRequirements },
    });
    mockEmit.mockResolvedValueOnce({ ok: true, data: { id: "elc_new" } });

    const result = await makeTool().execute({}, ctx);

    expect(mockClientGet).toHaveBeenCalledWith({ param: { workspaceId: "ws_test" } });
    expect(mockEmit).toHaveBeenCalledTimes(1);
    expect(mockEmit).toHaveBeenCalledWith({
      workspaceId: "ws_test",
      sessionId: "chat_session_1",
      setupRequirements,
    });
    expect(result).toMatchObject({
      status: "pending_confirmation",
      elicitationId: "elc_new",
      requirementCount: 2,
    });
  });

  it("returns no_setup_required without emitting when the workspace has no gaps", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { id: "ws_test", requires_setup: false, setup_requirements: [] },
    });

    const result = await makeTool().execute({}, ctx);

    expect(mockEmit).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: "no_setup_required" });
  });

  it("surfaces a structured error when the daemon fetch fails", async () => {
    mockParseResult.mockResolvedValueOnce({ ok: false, error: "boom" });

    const result = await makeTool().execute({}, ctx);

    expect(mockEmit).not.toHaveBeenCalled();
    expect(result.error).toContain("Failed to load workspace setup state");
  });

  it("surfaces a structured error when the daemon payload is unexpected", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: { id: "ws_test", setup_requirements: "not-an-array" },
    });

    const result = await makeTool().execute({}, ctx);

    expect(mockEmit).not.toHaveBeenCalled();
    expect(result.error).toContain("did not match expected shape");
  });

  it("surfaces a structured error when elicitation create fails", async () => {
    mockParseResult.mockResolvedValueOnce({
      ok: true,
      data: {
        id: "ws_test",
        requires_setup: true,
        setup_requirements: [{ kind: "variable", name: "region", schema: { type: "string" } }],
      },
    });
    mockEmit.mockResolvedValueOnce({ ok: false, error: "kv down" });

    const result = await makeTool().execute({}, ctx);

    expect(result.error).toContain("kv down");
  });
});
