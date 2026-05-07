import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ZodRawShape } from "zod";

const mockState = vi.hoisted(() => ({
  creates: [] as Record<string, unknown>[],
  nextId: "elc_human_input",
  nextOk: true,
  reset() {
    this.creates = [];
    this.nextId = "elc_human_input";
    this.nextOk = true;
  },
}));

vi.mock("@atlas/core/elicitations", () => ({
  ElicitationStorage: {
    create: (input: Record<string, unknown>) => {
      mockState.creates.push(input);
      if (!mockState.nextOk) return Promise.resolve({ ok: false, error: "stub failure" });
      return Promise.resolve({
        ok: true,
        data: {
          ...input,
          id: mockState.nextId,
          status: "pending",
          createdAt: new Date().toISOString(),
        },
      });
    },
    get: () => Promise.resolve({ ok: true, data: null }),
    expirePending: () => Promise.resolve({ ok: true, data: [] }),
  },
}));

import {
  LLM_AGENT_ALLOWED_PLATFORM_TOOLS,
  SCOPE_INJECTED_PLATFORM_TOOLS,
} from "../../../../core/src/agent-conversion/agent-tool-filters.ts";
import type { ToolContext } from "../types.ts";
import { registerRequestHumanInputTool } from "./request-human-input.ts";

type RegisteredHandler = (args: Record<string, unknown>) => Promise<CallToolResult>;

interface CapturedRegistration {
  name: string;
  inputSchema: ZodRawShape;
  handler: RegisteredHandler;
}

function makeCtx(): ToolContext {
  return {
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
    server: {} as ToolContext["server"],
  };
}

function captureRegistration(ctx: ToolContext = makeCtx()): {
  ctx: ToolContext;
  registered: CapturedRegistration;
} {
  let registered: CapturedRegistration | null = null;
  const mockServer = {
    registerTool: (
      name: string,
      config: { inputSchema?: ZodRawShape },
      handler: RegisteredHandler,
    ) => {
      registered = { name, inputSchema: config.inputSchema ?? {}, handler };
    },
  };
  registerRequestHumanInputTool(mockServer as unknown as ToolContext["server"], ctx);
  if (!registered) throw new Error("registerTool was not called");
  return { ctx, registered };
}

function parseBody(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("request_human_input platform tool", () => {
  beforeEach(() => mockState.reset());

  it("creates an open-question elicitation and returns pending when no live waiter is present", async () => {
    mockState.nextId = "elc_choice";
    const { registered } = captureRegistration();
    const result = await registered.handler({
      question: "Archive newsletter digests?",
      options: [
        { label: "Archive", value: "archive" },
        { label: "Keep", value: "keep" },
      ],
      workspaceId: "ws_1",
      sessionId: "sess_1",
      actionId: "review-action",
    });

    expect(result.isError).toBeFalsy();
    expect(parseBody(result)).toEqual({
      ok: false,
      status: "pending",
      elicitationId: "elc_choice",
      reason: "pending_user_input",
    });

    expect(mockState.creates).toHaveLength(1);
    const env = mockState.creates[0] as Record<string, unknown>;
    expect(env.kind).toBe("open-question");
    expect(env.workspaceId).toBe("ws_1");
    expect(env.sessionId).toBe("sess_1");
    expect(env.actionId).toBe("review-action");
    expect(env.question).toBe("Archive newsletter digests?");
    expect(env.options).toEqual([
      { label: "Archive", value: "archive" },
      { label: "Keep", value: "keep" },
    ]);
    expect("pendingTool" in env).toBe(false);
  });

  it("supports free-form open questions without options", async () => {
    const { registered } = captureRegistration();
    await registered.handler({
      question: "What label should I apply?",
      workspaceId: "ws_1",
      sessionId: "sess_1",
    });
    const env = mockState.creates[0] as Record<string, unknown>;
    expect("options" in env).toBe(false);
  });

  it("derives expiresAt from jobTimeoutMs", async () => {
    const { registered } = captureRegistration();
    const before = Date.now();
    await registered.handler({
      question: "Proceed?",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      jobTimeoutMs: 60_000,
    });
    const after = Date.now();
    const env = mockState.creates[0] as Record<string, unknown>;
    const expiresAt = new Date(env.expiresAt as string).getTime();
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 60_000 + 100);
  });

  it("warns and falls back to sessionId='unknown' when scope is missing", async () => {
    const { registered, ctx } = captureRegistration();
    await registered.handler({ question: "Proceed?", workspaceId: "ws_1" });
    const env = mockState.creates[0] as Record<string, unknown>;
    expect(env.sessionId).toBe("unknown");
    expect((ctx.logger.warn as unknown as MockInstance).mock.calls.length).toBeGreaterThan(0);
  });

  it("returns an error when ElicitationStorage.create fails", async () => {
    mockState.nextOk = false;
    const { registered, ctx } = captureRegistration();
    const result = await registered.handler({
      question: "Proceed?",
      workspaceId: "ws_1",
      sessionId: "sess_1",
    });
    expect(result.isError).toBe(true);
    expect((ctx.logger.error as unknown as MockInstance).mock.calls.length).toBeGreaterThan(0);
  });

  it("is allowed and scope-injected for workspace/user agents", () => {
    expect(LLM_AGENT_ALLOWED_PLATFORM_TOOLS.has("request_human_input")).toBe(true);
    expect(SCOPE_INJECTED_PLATFORM_TOOLS.has("request_human_input")).toBe(true);
  });
});
