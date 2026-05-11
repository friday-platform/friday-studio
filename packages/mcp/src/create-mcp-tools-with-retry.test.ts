import type { MCPServerConfig } from "@atlas/config";
import { ElicitationStorage, initElicitationStorage } from "@atlas/core/elicitations";
import type { Logger } from "@atlas/logger";
import { type Tool, tool } from "ai";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getTestNc } from "../../../vitest.setup.ts";
import type { DisconnectedIntegration, MCPToolsResult } from "./create-mcp-tools.ts";

// `nats` is not in `packages/mcp/deno.json`'s import map; derive the connection
// type from the test helper instead of importing it.
type NatsConnection = ReturnType<typeof getTestNc>;

const { mockCreateMCPTools } = vi.hoisted(() => ({ mockCreateMCPTools: vi.fn() }));

vi.mock("./create-mcp-tools.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create-mcp-tools.ts")>();
  return { ...actual, createMCPTools: mockCreateMCPTools };
});

// Import wrapper AFTER vi.mock so it picks up the mocked createMCPTools.
const { createMCPToolsWithRetry, questionForFamily } = await import(
  "./create-mcp-tools-with-retry.ts"
);

let nc: NatsConnection;
beforeAll(() => {
  nc = getTestNc();
  initElicitationStorage(nc);
});

beforeEach(() => {
  mockCreateMCPTools.mockReset();
});

function makeLogger(): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
}

function makeTool(name: string): Tool {
  return tool({
    description: name,
    inputSchema: z.object({}),
    execute: () => Promise.resolve({ result: name }),
  });
}

function makeResult(input: {
  tools?: Record<string, Tool>;
  toolsByServer?: Record<string, string[]>;
  disconnected?: DisconnectedIntegration[];
}): MCPToolsResult {
  const dispose = vi.fn(async () => {});
  return {
    tools: input.tools ?? {},
    toolsByServer: input.toolsByServer ?? {},
    disconnected: input.disconnected ?? [],
    dispose,
  };
}

function transientEntry(serverId: string, provider: string): DisconnectedIntegration {
  return {
    serverId,
    provider,
    kind: "credential_temporarily_unavailable",
    message: `${serverId} unavailable`,
  };
}

function makeCtx() {
  return { workspaceId: `ws-${crypto.randomUUID()}`, sessionId: `sess-${crypto.randomUUID()}` };
}

const configsAll: Record<string, MCPServerConfig> = {
  "google-calendar": { transport: { type: "stdio", command: "echo", args: [] } },
  "google-gmail": { transport: { type: "stdio", command: "echo", args: [] } },
  slack: { transport: { type: "stdio", command: "echo", args: [] } },
};

/** Poll storage until a pending elicitation matching `(workspaceId, sessionId, family)` appears. */
async function waitForPendingElicitation(input: {
  workspaceId: string;
  sessionId: string;
  family: string;
  timeoutMs?: number;
}): Promise<{ id: string }> {
  const timeoutMs = input.timeoutMs ?? 3_000;
  const deadline = Date.now() + timeoutMs;
  const question = questionForFamily(input.family);
  while (Date.now() < deadline) {
    const listed = await ElicitationStorage.list({
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      status: "pending",
    });
    if (listed.ok) {
      const match = listed.data.find((e) => e.kind === "auth-refresh" && e.question === question);
      if (match) return { id: match.id };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for pending elicitation for family=${input.family}`);
}

async function answerNow(id: string, value: "retry" | "cancel"): Promise<void> {
  const res = await ElicitationStorage.answer({
    id,
    answer: { value, answeredAt: new Date().toISOString() },
  });
  if (!res.ok) throw new Error(`failed to answer elicitation: ${res.error}`);
}

describe("questionForFamily", () => {
  it("is a pure function — two calls with the same family return byte-identical strings", () => {
    // Dedup matches `question` by exact string equality against pending
    // elicitation rows; any per-call variability would defeat dedup.
    expect(questionForFamily("google")).toBe(questionForFamily("google"));
    expect(questionForFamily("slack")).toBe(questionForFamily("slack"));
    expect(questionForFamily("google")).not.toBe(questionForFamily("slack"));
  });
});

describe("createMCPToolsWithRetry", () => {
  it("passes the result through unchanged when no transient disconnects", async () => {
    const result = makeResult({ tools: { foo: makeTool("foo") } });
    mockCreateMCPTools.mockResolvedValueOnce(result);

    const out = await createMCPToolsWithRetry(configsAll, makeLogger());

    expect(out).toBe(result);
    expect(mockCreateMCPTools).toHaveBeenCalledTimes(1);
  });

  it("throws aggregate LinkCredentialUnavailableError without interactiveCtx", async () => {
    const partial = makeResult({
      tools: { slackOnly: makeTool("slackOnly") },
      disconnected: [
        transientEntry("google-calendar", "google-calendar"),
        transientEntry("google-gmail", "google-gmail"),
      ],
    });
    mockCreateMCPTools.mockResolvedValueOnce(partial);

    await expect(createMCPToolsWithRetry(configsAll, makeLogger())).rejects.toMatchObject({
      name: "LinkCredentialUnavailableError",
    });
    expect(partial.dispose).toHaveBeenCalledTimes(1);
  });

  it("preserves non-transient disconnects when no transient is present", async () => {
    const result = makeResult({
      disconnected: [{ serverId: "x", kind: "credential_expired", message: "x expired" }],
    });
    mockCreateMCPTools.mockResolvedValueOnce(result);

    const out = await createMCPToolsWithRetry(configsAll, makeLogger());
    expect(out).toBe(result);
  });

  it("retries on user Retry and returns the merged result (single family)", async () => {
    const ctx = makeCtx();
    const firstResult = makeResult({
      tools: { slackTool: makeTool("slackTool") },
      toolsByServer: { slack: ["slackTool"] },
      disconnected: [transientEntry("google-calendar", "google-calendar")],
    });
    const retryResult = makeResult({
      tools: { calendarTool: makeTool("calendarTool") },
      toolsByServer: { "google-calendar": ["calendarTool"] },
    });
    mockCreateMCPTools.mockResolvedValueOnce(firstResult).mockResolvedValueOnce(retryResult);

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);

    const pending = await waitForPendingElicitation({ ...ctx, family: "google" });
    await answerNow(pending.id, "retry");

    const out = await promise;
    expect(out.tools).toMatchObject({
      slackTool: expect.any(Object),
      calendarTool: expect.any(Object),
    });
    expect(out.disconnected).toHaveLength(0);
    expect(mockCreateMCPTools).toHaveBeenCalledTimes(2);
    // Retry only re-attempted the failed serverId.
    const retryConfigs = mockCreateMCPTools.mock.calls[1]?.[0];
    expect(Object.keys(retryConfigs ?? {})).toEqual(["google-calendar"]);
  });

  it("throws aggregate when user clicks Cancel", async () => {
    const ctx = makeCtx();
    const partial = makeResult({
      disconnected: [transientEntry("google-calendar", "google-calendar")],
    });
    mockCreateMCPTools.mockResolvedValueOnce(partial);

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);

    const pending = await waitForPendingElicitation({ ...ctx, family: "google" });
    await answerNow(pending.id, "cancel");

    await expect(promise).rejects.toMatchObject({ name: "LinkCredentialUnavailableError" });
    expect(partial.dispose).toHaveBeenCalledTimes(1);
  });

  it("loops: Retry → fresh transient → new elicitation → Retry → merged result", async () => {
    const ctx = makeCtx();
    const r1 = makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] });
    const r2 = makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] });
    const r3 = makeResult({
      tools: { calendarTool: makeTool("calendarTool") },
      toolsByServer: { "google-calendar": ["calendarTool"] },
    });
    mockCreateMCPTools
      .mockResolvedValueOnce(r1)
      .mockResolvedValueOnce(r2)
      .mockResolvedValueOnce(r3);

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);

    const first = await waitForPendingElicitation({ ...ctx, family: "google" });
    await answerNow(first.id, "retry");

    const second = await waitForPendingElicitation({ ...ctx, family: "google", timeoutMs: 5_000 });
    expect(second.id).not.toBe(first.id);
    await answerNow(second.id, "retry");

    const out = await promise;
    expect(out.tools).toMatchObject({ calendarTool: expect.any(Object) });
    expect(out.disconnected).toHaveLength(0);
    expect(mockCreateMCPTools).toHaveBeenCalledTimes(3);
  });

  it("awaits multi-family elicitations concurrently and aggregates failures", async () => {
    const ctx = makeCtx();
    const partial = makeResult({
      disconnected: [
        transientEntry("google-calendar", "google-calendar"),
        transientEntry("slack", "slack"),
      ],
    });
    mockCreateMCPTools.mockResolvedValueOnce(partial);

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);

    const [googlePending, slackPending] = await Promise.all([
      waitForPendingElicitation({ ...ctx, family: "google" }),
      waitForPendingElicitation({ ...ctx, family: "slack" }),
    ]);
    // Cancel both — wrapper aggregates failures across families.
    await Promise.all([
      answerNow(googlePending.id, "cancel"),
      answerNow(slackPending.id, "cancel"),
    ]);

    await expect(promise).rejects.toMatchObject({ name: "LinkCredentialUnavailableError" });
  });

  it("deduplicates: second transient on same family finds the existing pending elicitation", async () => {
    const ctx = makeCtx();

    // Seed a pending elicitation for the google family directly.
    const seedExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const seed = await ElicitationStorage.create({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      kind: "auth-refresh",
      question: questionForFamily("google"),
      options: [
        { label: "Retry", value: "retry" },
        { label: "Cancel", value: "cancel" },
      ],
      expiresAt: seedExpiresAt,
    });
    expect.assert(seed.ok === true);
    const seedId = seed.data.id;

    const partial = makeResult({
      disconnected: [transientEntry("google-calendar", "google-calendar")],
    });
    const retryResult = makeResult({ tools: { calendarTool: makeTool("calendarTool") } });
    mockCreateMCPTools.mockResolvedValueOnce(partial).mockResolvedValueOnce(retryResult);

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);

    // Wait for the wrapper to begin polling the seeded id; this confirms it
    // picked the seed up via dedup rather than creating a new elicitation.
    // We can't read poll state directly, so we settle by giving the wrapper
    // a couple of poll cycles and then answering the seed.
    await new Promise((r) => setTimeout(r, 600));
    await answerNow(seedId, "retry");

    const out = await promise;
    expect(out.tools).toMatchObject({ calendarTool: expect.any(Object) });

    const listed = await ElicitationStorage.list({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
    });
    expect.assert(listed.ok === true);
    const authRefreshes = listed.data.filter((e) => e.kind === "auth-refresh");
    expect(authRefreshes).toHaveLength(1);
    expect(authRefreshes[0]?.id).toBe(seedId);
  });

  it("rejects immediately when sessionAbortSignal is pre-aborted", async () => {
    const ctx = { ...makeCtx(), sessionAbortSignal: AbortSignal.abort("preempted") };

    await expect(createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(mockCreateMCPTools).not.toHaveBeenCalled();
  });

  it("rejects mid-wait when sessionAbortSignal aborts", async () => {
    const controller = new AbortController();
    const ctx = { ...makeCtx(), sessionAbortSignal: controller.signal };
    const partial = makeResult({
      disconnected: [transientEntry("google-calendar", "google-calendar")],
    });
    mockCreateMCPTools.mockResolvedValueOnce(partial);

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);
    // Wait for the elicitation to be created (i.e. wrapper is in poll-wait).
    await waitForPendingElicitation({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      family: "google",
    });

    const start = Date.now();
    controller.abort("user-closed-tab");

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - start).toBeLessThan(500);
  });
});
