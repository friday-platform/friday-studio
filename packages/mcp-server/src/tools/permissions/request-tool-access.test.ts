/**
 * Tests for the `request_tool_access` MCP tool (Phase 12.C / Phase 1.C).
 *
 * Two branches:
 *   1. **Bypass** (`dangerouslySkipAllowlist` resolves true) → returns
 *      `{ ok: true, granted: true, reason: "bypass" }`, logs at info.
 *   2. **Elicitation** → calls `ElicitationStorage.create` with a
 *      `tool-allowlist` envelope and returns
 *      `{ ok: false, granted: false, elicitationId, reason: "pending_user_approval" }`.
 *
 * `@atlas/core/elicitations` is mocked at module level so the facade
 * doesn't need a live NATS connection. The mock records `create()`
 * payloads for assertions.
 */

import process from "node:process";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { ZodRawShape } from "zod";

// ── Hoisted mock for @atlas/core/elicitations ────────────────────────────────
// We mutate `creates`, `nextId`, and `nextOk` between tests. `vi.hoisted` is
// the supported way to share a binding with the (hoisted) `vi.mock` factory.
const mockState = vi.hoisted(() => ({
  creates: [] as Record<string, unknown>[],
  grants: [] as Record<string, unknown>[],
  hasPersistentGrant: false,
  getData: null as Record<string, unknown> | null,
  nextId: "elc_test_id",
  nextOk: true,
  reset() {
    this.creates = [];
    this.grants = [];
    this.hasPersistentGrant = false;
    this.getData = null;
    this.nextId = "elc_test_id";
    this.nextOk = true;
  },
}));

vi.mock("@atlas/core/elicitations", () => ({
  ElicitationStorage: {
    create: (input: Record<string, unknown>) => {
      mockState.creates.push(input);
      if (!mockState.nextOk) {
        return Promise.resolve({ ok: false, error: "stub failure" });
      }
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
    get: () => Promise.resolve({ ok: true, data: mockState.getData }),
    list: () => Promise.resolve({ ok: true, data: [] }),
    expirePending: () =>
      Promise.resolve({ ok: true, data: { scanned: 1, expired: [], skipped: [], errors: 0 } }),
    answer: () => Promise.resolve({ ok: false, error: "not implemented" }),
    decline: () => Promise.resolve({ ok: false, error: "not implemented" }),
  },
  ToolAccessGrants: {
    hasGrant: () => Promise.resolve({ ok: true, data: mockState.hasPersistentGrant }),
    grantAlways: (input: Record<string, unknown>) => {
      mockState.grants.push(input);
      return Promise.resolve({
        ok: true,
        data: { ...input, scope: "workspace", grantedAt: new Date().toISOString() },
      });
    },
  },
}));

import { LLM_AGENT_ALLOWED_PLATFORM_TOOLS } from "../../../../core/src/agent-conversion/agent-tool-filters.ts";
import type { ToolContext } from "../types.ts";
import { registerRequestToolAccessTool } from "./request-tool-access.ts";

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
  registerRequestToolAccessTool(mockServer as unknown as ToolContext["server"], ctx);
  if (!registered) throw new Error("registerTool was not called");
  return { ctx, registered };
}

function parseBody(result: CallToolResult): Record<string, unknown> {
  return JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
}

describe("request_tool_access — bypass branch (Phase 1.C)", () => {
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS;
    delete process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS;
    mockState.reset();
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS;
    } else {
      process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS = prevEnv;
    }
  });

  it("returns granted when job permissions opt into bypass", async () => {
    const { ctx, registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "send_email",
      reason: "follow up with user",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      actionId: "act_1",
      jobPermissions: { dangerouslySkipAllowlist: true },
    });
    expect(result.isError).toBeFalsy();
    expect(parseBody(result)).toEqual({ ok: true, granted: true, reason: "bypass" });
    // Logs at info level — operators see bypass in ~/.atlas/logs/global.log
    expect((ctx.logger.info as unknown as MockInstance).mock.calls.length).toBeGreaterThan(0);
    // No elicitation created on bypass
    expect(mockState.creates).toHaveLength(0);
  });

  it("returns granted when workspace permissions opt into bypass", async () => {
    const { registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "delete_file",
      reason: "cleanup",
      workspaceId: "ws_1",
      workspacePermissions: { dangerouslySkipAllowlist: true },
    });
    const parsed = parseBody(result);
    expect(parsed.granted).toBe(true);
    expect(parsed.reason).toBe("bypass");
  });

  it("returns granted when daemon env flag is set and no per-job override", async () => {
    process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS = "1";
    const { registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "send_email",
      reason: "trusted dev workspace",
      workspaceId: "ws_1",
    });
    const parsed = parseBody(result);
    expect(parsed.granted).toBe(true);
    expect(parsed.reason).toBe("bypass");
  });

  it("job-level false beats workspace-level true (precedence)", async () => {
    // Resolved permissions: job > workspace > daemon. A strict job inside
    // a permissive workspace should NOT bypass.
    const { registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "send_email",
      reason: "x",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      jobPermissions: { dangerouslySkipAllowlist: false },
      workspacePermissions: { dangerouslySkipAllowlist: true },
      jobTimeoutMs: 1,
    });
    const parsed = parseBody(result);
    expect(parsed.granted).toBe(false);
    expect(parsed.reason).toBe("expired");
    expect(mockState.creates).toHaveLength(1);
  });
});

describe("request_tool_access — elicitation branch (Phase 12.C)", () => {
  beforeEach(() => {
    delete process.env.FRIDAY_DANGEROUSLY_SKIP_PERMISSIONS;
    mockState.reset();
  });

  it("creates a tool-allowlist elicitation with the right envelope", async () => {
    mockState.nextId = "elc_abc";
    const { registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "send_email",
      reason: "draft response to last support ticket",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      actionId: "drafting_state",
      jobTimeoutMs: 1,
    });

    expect(result.isError).toBeFalsy();
    expect(parseBody(result)).toEqual({
      ok: false,
      granted: false,
      elicitationId: "elc_abc",
      reason: "expired",
    });

    // Envelope shape we passed to ElicitationStorage.create
    expect(mockState.creates).toHaveLength(1);
    const env = mockState.creates[0] as Record<string, unknown>;
    expect(env.kind).toBe("tool-allowlist");
    expect(env.workspaceId).toBe("ws_1");
    expect(env.sessionId).toBe("sess_1");
    expect(env.actionId).toBe("drafting_state");
    expect(env.pendingTool).toEqual({ name: "send_email", args: {} });
    expect(env.options).toEqual([
      { label: "Allow once", value: "allow_once" },
      { label: "Allow always", value: "allow_always" },
      { label: "Deny", value: "deny" },
    ]);
    expect(typeof env.expiresAt).toBe("string");
    expect(() => new Date(env.expiresAt as string).toISOString()).not.toThrow();
    expect(typeof env.question).toBe("string");
    expect((env.question as string).includes("send_email")).toBe(true);
  });

  it("persists allow_always answers as workspace grants", async () => {
    mockState.nextId = "elc_allow";
    mockState.getData = {
      id: "elc_allow",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      kind: "tool-allowlist",
      question: "Allow?",
      status: "answered",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      answer: { value: "allow_always" },
    };
    const { registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "send_email",
      reason: "x",
      workspaceId: "ws_1",
      sessionId: "sess_1",
    });

    expect(parseBody(result)).toEqual({
      ok: true,
      granted: true,
      elicitationId: "elc_allow",
      answer: "allow_always",
      reason: "answered",
      persistent: true,
    });
    expect(mockState.grants).toEqual([
      { workspaceId: "ws_1", toolName: "send_email", sourceElicitationId: "elc_allow" },
    ]);
  });

  it("returns an error when ElicitationStorage.create fails", async () => {
    mockState.nextOk = false;
    const { ctx, registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "send_email",
      reason: "x",
      workspaceId: "ws_1",
      sessionId: "sess_1",
    });
    expect(result.isError).toBe(true);
    expect((ctx.logger.error as unknown as MockInstance).mock.calls.length).toBeGreaterThan(0);
  });

  it("falls back to sessionId='unknown' when scope didn't inject one", async () => {
    const { registered, ctx } = captureRegistration();
    await registered.handler({ toolName: "x", reason: "y", workspaceId: "ws_1", jobTimeoutMs: 1 });
    const env = mockState.creates[0] as Record<string, unknown>;
    expect(env.sessionId).toBe("unknown");
    // Review N4: fallback fires a warn-log so operators can spot bugs
    // where future scope plumbers forget sessionId.
    expect((ctx.logger.warn as unknown as MockInstance).mock.calls.length).toBeGreaterThan(0);
  });

  it("omits actionId from envelope when scope didn't inject one", async () => {
    const { registered } = captureRegistration();
    await registered.handler({
      toolName: "x",
      reason: "y",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      jobTimeoutMs: 1,
    });
    const env = mockState.creates[0] as Record<string, unknown>;
    expect("actionId" in env).toBe(false);
  });

  it("returns granted without elicitation when an allow-always grant already exists", async () => {
    mockState.hasPersistentGrant = true;
    const { registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "send_email",
      reason: "already approved",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      availableToolNames: ["send_email"],
    });

    expect(result.isError).toBeFalsy();
    expect(mockState.creates).toHaveLength(0);
    expect(parseBody(result)).toEqual({ ok: true, granted: true, reason: "persistent_allow" });
  });

  it("uses resolvedPermissions when provided, skipping raw resolution (review N2)", async () => {
    // resolvedPermissions=bypass means immediate granted return — no
    // elicitation. If the tool re-resolved from raw fields, daemon-env=0
    // would flip the result.
    const { registered } = captureRegistration();
    const result = await registered.handler({
      toolName: "x",
      reason: "y",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      resolvedPermissions: { dangerouslySkipAllowlist: true },
    });
    expect(result.isError).toBeFalsy();
    expect(mockState.creates).toHaveLength(0); // no elicitation created
    expect(parseBody(result)).toEqual({ ok: true, granted: true, reason: "bypass" });
  });

  it("derives expiresAt from jobTimeoutMs when injected (review N3)", async () => {
    mockState.getData = {
      id: "elc_timeout",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      kind: "tool-allowlist",
      question: "Allow?",
      status: "answered",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      answer: { value: "allow_once" },
    };
    const { registered } = captureRegistration();
    const before = Date.now();
    await registered.handler({
      toolName: "x",
      reason: "y",
      workspaceId: "ws_1",
      sessionId: "sess_1",
      jobTimeoutMs: 60_000, // 1 minute
    });
    const after = Date.now();
    const env = mockState.creates[0] as Record<string, unknown>;
    const expiresAt = new Date(env.expiresAt as string).getTime();
    // Should land within ±a few ms of `now + 60s`.
    expect(expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(expiresAt).toBeLessThanOrEqual(after + 60_000 + 100);
  });
});

describe("request_tool_access — registration sanity", () => {
  beforeEach(() => mockState.reset());

  it("appears in LLM_AGENT_ALLOWED_PLATFORM_TOOLS", () => {
    expect(LLM_AGENT_ALLOWED_PLATFORM_TOOLS.has("request_tool_access")).toBe(true);
  });

  it("registers under the canonical name", () => {
    const { registered } = captureRegistration();
    expect(registered.name).toBe("request_tool_access");
  });

  it("inputSchema declares user-facing + runtime-injected fields", () => {
    const { registered } = captureRegistration();
    expect(registered.inputSchema).toHaveProperty("toolName");
    expect(registered.inputSchema).toHaveProperty("reason");
    expect(registered.inputSchema).toHaveProperty("workspaceId");
    expect(registered.inputSchema).toHaveProperty("sessionId");
    expect(registered.inputSchema).toHaveProperty("actionId");
    expect(registered.inputSchema).toHaveProperty("jobPermissions");
    expect(registered.inputSchema).toHaveProperty("workspacePermissions");
    // Review N2/N3 — resolved-once + job-timeout fields.
    expect(registered.inputSchema).toHaveProperty("resolvedPermissions");
    expect(registered.inputSchema).toHaveProperty("jobTimeoutMs");
  });
});
