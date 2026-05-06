import process from "node:process";
import { createLogger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/core/elicitations", async () => {
  const actual = await vi.importActual<typeof import("@atlas/core/elicitations")>(
    "@atlas/core/elicitations",
  );
  return { ...actual, ElicitationStorage: { create: vi.fn() } };
});

import { ElicitationStorage } from "@atlas/core/elicitations";
import { createRequestToolAccessTool } from "./request-tool-access.ts";

interface ToolWithExecute {
  execute: (
    args: { toolName: string; reason: string },
    ctx: { toolCallId: string },
  ) => Promise<unknown>;
}

const logger = createLogger({ name: "test" });
const noopCtx = { toolCallId: "tc_1" };

const baseOpts = { workspaceId: "ws_test", sessionId: "chat_session", logger };

describe("createRequestToolAccessTool", () => {
  const create = vi.mocked(ElicitationStorage.create);
  const ENV_KEY = "FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS";
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    create.mockReset();
  });

  afterEach(() => {
    if (prevEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = prevEnv;
  });

  it("registers a tool keyed `request_tool_access`", () => {
    const tools = createRequestToolAccessTool(baseOpts);
    expect(Object.keys(tools)).toEqual(["request_tool_access"]);
  });

  it("bypass branch — workspacePermissions.dangerouslySkipAllowlist=true returns granted without elicitation", async () => {
    const tools = createRequestToolAccessTool({
      ...baseOpts,
      workspacePermissions: { dangerouslySkipAllowlist: true },
    });
    const t = tools.request_tool_access as unknown as ToolWithExecute;
    const result = await t.execute({ toolName: "bash_run", reason: "shell" }, noopCtx);
    expect(result).toEqual({ ok: true, granted: true, reason: "bypass" });
    expect(create).not.toHaveBeenCalled();
  });

  it("bypass branch — daemon env=1 with no workspace setting returns granted", async () => {
    process.env[ENV_KEY] = "1";
    const tools = createRequestToolAccessTool(baseOpts);
    const t = tools.request_tool_access as unknown as ToolWithExecute;
    const result = await t.execute({ toolName: "bash_run", reason: "shell" }, noopCtx);
    expect(result).toEqual({ ok: true, granted: true, reason: "bypass" });
    expect(create).not.toHaveBeenCalled();
  });

  it("workspace setting `false` overrides daemon env=1 (re-strict)", async () => {
    process.env[ENV_KEY] = "1";
    create.mockResolvedValue({
      ok: true,
      data: {
        id: "elic_strict",
        workspaceId: "ws_test",
        sessionId: "chat_session",
        kind: "tool-allowlist",
        question: "ignored",
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        status: "pending",
      },
    });
    const tools = createRequestToolAccessTool({
      ...baseOpts,
      workspacePermissions: { dangerouslySkipAllowlist: false },
    });
    const t = tools.request_tool_access as unknown as ToolWithExecute;
    const result = await t.execute({ toolName: "bash_run", reason: "shell" }, noopCtx);
    expect(create).toHaveBeenCalledOnce();
    expect(result).toEqual({
      ok: false,
      granted: false,
      elicitationId: "elic_strict",
      reason: "pending_user_approval",
    });
  });

  it("elicitation branch — emits a tool-allowlist elicitation with the right shape", async () => {
    create.mockResolvedValue({
      ok: true,
      data: {
        id: "elic_pending",
        workspaceId: "ws_test",
        sessionId: "chat_session",
        kind: "tool-allowlist",
        question: "Allow agent to call `bash_run`? need shell",
        createdAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        status: "pending",
      },
    });
    const tools = createRequestToolAccessTool(baseOpts);
    const t = tools.request_tool_access as unknown as ToolWithExecute;
    const result = await t.execute({ toolName: "bash_run", reason: "need shell" }, noopCtx);

    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      workspaceId: "ws_test",
      sessionId: "chat_session",
      kind: "tool-allowlist",
      pendingTool: { name: "bash_run", args: {} },
    });
    expect(arg?.question).toContain("bash_run");
    expect(arg?.question).toContain("need shell");
    expect(arg?.options).toHaveLength(3);

    expect(result).toEqual({
      ok: false,
      granted: false,
      elicitationId: "elic_pending",
      reason: "pending_user_approval",
    });
  });

  it("returns an error envelope when ElicitationStorage.create rejects", async () => {
    create.mockResolvedValue({ ok: false, error: "kv unavailable" });
    const tools = createRequestToolAccessTool(baseOpts);
    const t = tools.request_tool_access as unknown as ToolWithExecute;
    const result = await t.execute({ toolName: "bash_run", reason: "shell" }, noopCtx);
    expect(result).toEqual({ error: "Failed to create elicitation: kv unavailable" });
  });

  it("returns network-error envelope when create throws", async () => {
    create.mockRejectedValue(new Error("nats disconnected"));
    const tools = createRequestToolAccessTool(baseOpts);
    const t = tools.request_tool_access as unknown as ToolWithExecute;
    const result = await t.execute({ toolName: "bash_run", reason: "shell" }, noopCtx);
    expect(result).toEqual({ error: "Failed to create elicitation: network error" });
  });
});
