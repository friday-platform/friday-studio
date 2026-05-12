import { createLogger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@atlas/core/elicitations", async () => {
  const actual = await vi.importActual<typeof import("@atlas/core/elicitations")>(
    "@atlas/core/elicitations",
  );
  return {
    ...actual,
    ElicitationStorage: {
      create: vi.fn(),
      list: vi.fn(() => Promise.resolve({ ok: true, data: [] })),
    },
  };
});

import { ElicitationStorage } from "@atlas/core/elicitations";
import { createRequestHumanInputTool } from "./request-human-input.ts";

interface ToolWithExecute {
  execute: (
    args: { question: string; options?: { label: string; value: string }[] },
    ctx: { toolCallId: string },
  ) => Promise<unknown>;
}

const logger = createLogger({ name: "test" });
const noopCtx = { toolCallId: "tc_1" };
const baseOpts = { workspaceId: "ws_test", sessionId: "chat_session", logger };

function pendingElicitation(
  overrides: Partial<{ id: string; question: string; options: { label: string; value: string }[] }>,
) {
  return {
    id: overrides.id ?? "elic_x",
    workspaceId: "ws_test",
    sessionId: "chat_session",
    kind: "open-question" as const,
    question: overrides.question ?? "Pick one",
    ...(overrides.options ? { options: overrides.options } : {}),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending" as const,
  };
}

describe("createRequestHumanInputTool", () => {
  const create = vi.mocked(ElicitationStorage.create);
  const list = vi.mocked(ElicitationStorage.list);

  beforeEach(() => {
    create.mockReset();
    list.mockReset();
    list.mockResolvedValue({ ok: true, data: [] });
  });

  it("registers a tool keyed `request_human_input`", () => {
    const tools = createRequestHumanInputTool(baseOpts);
    expect(Object.keys(tools)).toEqual(["request_human_input"]);
  });

  it("creates an open-question elicitation and returns a pending envelope", async () => {
    create.mockResolvedValue({
      ok: true,
      data: pendingElicitation({ id: "elic_pending", question: "Pick a color" }),
    });
    const tools = createRequestHumanInputTool(baseOpts);
    const t = tools.request_human_input as unknown as ToolWithExecute;
    const result = await t.execute(
      {
        question: "Pick a color",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
      },
      noopCtx,
    );

    expect(create).toHaveBeenCalledOnce();
    const arg = create.mock.calls[0]?.[0];
    expect(arg).toMatchObject({
      workspaceId: "ws_test",
      sessionId: "chat_session",
      kind: "open-question",
      question: "Pick a color",
      options: [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
      ],
    });
    expect(result).toEqual({
      ok: false,
      status: "pending",
      elicitationId: "elic_pending",
      reason: "pending_user_input",
    });
  });

  it("omits the `options` field when none are provided (free-form text)", async () => {
    create.mockResolvedValue({
      ok: true,
      data: pendingElicitation({ id: "elic_freeform", question: "What's the address?" }),
    });
    const tools = createRequestHumanInputTool(baseOpts);
    const t = tools.request_human_input as unknown as ToolWithExecute;
    await t.execute({ question: "What's the address?" }, noopCtx);
    const arg = create.mock.calls[0]?.[0];
    expect(arg).not.toHaveProperty("options");
  });

  it("reuses a still-pending elicitation with matching question + options instead of stacking", async () => {
    const existing = pendingElicitation({
      id: "elic_existing",
      question: "Pick a color",
      options: [
        { label: "Red", value: "red" },
        { label: "Blue", value: "blue" },
      ],
    });
    list.mockResolvedValue({ ok: true, data: [existing] });
    const tools = createRequestHumanInputTool(baseOpts);
    const t = tools.request_human_input as unknown as ToolWithExecute;
    const result = await t.execute(
      {
        question: "Pick a color",
        options: [
          { label: "Red", value: "red" },
          { label: "Blue", value: "blue" },
        ],
      },
      noopCtx,
    );
    expect(create).not.toHaveBeenCalled();
    expect(result).toEqual({
      ok: false,
      status: "pending",
      elicitationId: "elic_existing",
      reason: "pending_user_input",
    });
  });

  it("does not reuse when the question differs", async () => {
    list.mockResolvedValue({
      ok: true,
      data: [pendingElicitation({ id: "elic_other", question: "Different question" })],
    });
    create.mockResolvedValue({
      ok: true,
      data: pendingElicitation({ id: "elic_new", question: "Pick a color" }),
    });
    const tools = createRequestHumanInputTool(baseOpts);
    const t = tools.request_human_input as unknown as ToolWithExecute;
    const result = await t.execute({ question: "Pick a color" }, noopCtx);
    expect(create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ elicitationId: "elic_new" });
  });

  it("returns an error envelope when ElicitationStorage.create rejects", async () => {
    create.mockResolvedValue({ ok: false, error: "kv unavailable" });
    const tools = createRequestHumanInputTool(baseOpts);
    const t = tools.request_human_input as unknown as ToolWithExecute;
    const result = await t.execute({ question: "Pick" }, noopCtx);
    expect(result).toEqual({ error: "Failed to create elicitation: kv unavailable" });
  });

  it("returns network-error envelope when create throws", async () => {
    create.mockRejectedValue(new Error("nats disconnected"));
    const tools = createRequestHumanInputTool(baseOpts);
    const t = tools.request_human_input as unknown as ToolWithExecute;
    const result = await t.execute({ question: "Pick" }, noopCtx);
    expect(result).toEqual({ error: "Failed to create elicitation: network error" });
  });
});
