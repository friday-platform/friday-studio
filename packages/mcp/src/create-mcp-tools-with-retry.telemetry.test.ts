/**
 * Telemetry assertions for the OAuth refresh-retry wrapper.
 *
 * Kept in a separate test file from `create-mcp-tools-with-retry.test.ts` so
 * the behavioral cases there stay focused on the wrapper's control flow and
 * these focus solely on counter / histogram emission. Both files mock
 * `createMCPTools` via the same hoisted pattern; they don't share runtime
 * state because vitest isolates module scope per test file.
 */

import type { MCPServerConfig } from "@atlas/config";
import { ElicitationStorage, initElicitationStorage } from "@atlas/core/elicitations";
import type { Logger } from "@atlas/logger";
import {
  InMemoryOAuthMetricsSink,
  setOAuthMetricsSinkForTesting,
} from "@atlas/logger/oauth-metrics";
import { type Tool, tool } from "ai";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getTestNc } from "../../../vitest.setup.ts";
import type { DisconnectedIntegration, MCPToolsResult } from "./create-mcp-tools.ts";

type NatsConnection = ReturnType<typeof getTestNc>;

const { mockCreateMCPTools } = vi.hoisted(() => ({ mockCreateMCPTools: vi.fn() }));

vi.mock("./create-mcp-tools.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create-mcp-tools.ts")>();
  return { ...actual, createMCPTools: mockCreateMCPTools };
});

const { createMCPToolsWithRetry, questionForFamily } = await import(
  "./create-mcp-tools-with-retry.ts"
);

let nc: NatsConnection;
beforeAll(() => {
  nc = getTestNc();
  initElicitationStorage(nc);
});

let sink: InMemoryOAuthMetricsSink;
let restoreSink: (() => void) | null = null;

beforeEach(() => {
  mockCreateMCPTools.mockReset();
  sink = new InMemoryOAuthMetricsSink();
  restoreSink = setOAuthMetricsSinkForTesting(sink);
});

afterEach(() => {
  if (restoreSink) {
    restoreSink();
    restoreSink = null;
  }
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
  return {
    tools: input.tools ?? {},
    toolsByServer: input.toolsByServer ?? {},
    disconnected: input.disconnected ?? [],
    dispose: vi.fn(async () => {}),
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

describe("createMCPToolsWithRetry telemetry", () => {
  it("records `created` + `answered_retry` + `retry_succeeded` on the happy retry path", async () => {
    const ctx = makeCtx();
    mockCreateMCPTools
      .mockResolvedValueOnce(
        makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] }),
      )
      .mockResolvedValueOnce(makeResult({ tools: { calendarTool: makeTool("calendarTool") } }));

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);
    const pending = await waitForPendingElicitation({ ...ctx, family: "google" });
    await answerNow(pending.id, "retry");
    await promise;

    expect(sink.getCount("link.oauth.elicitation.created")).toEqual(1);
    expect(
      sink.getCount("link.oauth.elicitation.created", {
        family: "google",
        workspaceId: ctx.workspaceId,
        sessionId: ctx.sessionId,
      }),
    ).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.answered_retry")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.retry_succeeded")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.retry_failed")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.answered_cancel")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.expired")).toEqual(0);

    // Histogram observed exactly once, labelled as answered_retry.
    const samples = sink.getHistogramSamples("link.oauth.elicitation.answer_latency_ms", {
      status: "answered_retry",
    });
    expect(samples.length).toEqual(1);
    expect(samples[0]).toBeGreaterThanOrEqual(0);
  });

  it("records `answered_cancel` (no retry_*) when the user clicks Cancel", async () => {
    const ctx = makeCtx();
    mockCreateMCPTools.mockResolvedValueOnce(
      makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] }),
    );

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);
    const pending = await waitForPendingElicitation({ ...ctx, family: "google" });
    await answerNow(pending.id, "cancel");
    await expect(promise).rejects.toMatchObject({ name: "LinkCredentialUnavailableError" });

    expect(sink.getCount("link.oauth.elicitation.answered_cancel")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.answered_retry")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.retry_succeeded")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.retry_failed")).toEqual(0);
    expect(
      sink.getHistogramSamples("link.oauth.elicitation.answer_latency_ms", {
        status: "answered_cancel",
      }).length,
    ).toEqual(1);
  });

  it("records `retry_failed` when the retry attempt produces another transient", async () => {
    const ctx = makeCtx();
    mockCreateMCPTools
      .mockResolvedValueOnce(
        makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] }),
      )
      .mockResolvedValueOnce(
        makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] }),
      )
      .mockResolvedValueOnce(makeResult({ tools: { calendarTool: makeTool("calendarTool") } }));

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);
    const first = await waitForPendingElicitation({ ...ctx, family: "google" });
    await answerNow(first.id, "retry");

    const second = await waitForPendingElicitation({ ...ctx, family: "google", timeoutMs: 5_000 });
    await answerNow(second.id, "retry");

    await promise;

    expect(sink.getCount("link.oauth.elicitation.created")).toEqual(2);
    expect(sink.getCount("link.oauth.elicitation.answered_retry")).toEqual(2);
    // First retry → still transient: retry_failed once. Second retry → success: retry_succeeded once.
    expect(sink.getCount("link.oauth.elicitation.retry_failed")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.retry_succeeded")).toEqual(1);
  });

  it("records `deduped` when a second transient on the same family joins a pending elicitation", async () => {
    const ctx = makeCtx();
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
    if (!seed.ok) throw new Error(seed.error);

    mockCreateMCPTools
      .mockResolvedValueOnce(
        makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] }),
      )
      .mockResolvedValueOnce(makeResult({ tools: { calendarTool: makeTool("calendarTool") } }));

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);
    // Wait a beat so the wrapper's first list-then-create cycle picks up the seed.
    await new Promise((r) => setTimeout(r, 300));
    await answerNow(seed.data.id, "retry");
    await promise;

    expect(sink.getCount("link.oauth.elicitation.created")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.deduped")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.answered_retry")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.retry_succeeded")).toEqual(1);
  });

  it("records `aborted` + histogram when the session aborts mid-wait", async () => {
    const controller = new AbortController();
    const ctx = { ...makeCtx(), sessionAbortSignal: controller.signal };
    mockCreateMCPTools.mockResolvedValueOnce(
      makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] }),
    );

    const promise = createMCPToolsWithRetry(configsAll, makeLogger(), {}, ctx);
    await waitForPendingElicitation({
      workspaceId: ctx.workspaceId,
      sessionId: ctx.sessionId,
      family: "google",
    });
    controller.abort("user-closed-tab");
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });

    expect(sink.getCount("link.oauth.elicitation.aborted")).toEqual(1);
    expect(sink.getCount("link.oauth.elicitation.answered_retry")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.answered_cancel")).toEqual(0);
    expect(
      sink.getHistogramSamples("link.oauth.elicitation.answer_latency_ms", { status: "aborted" })
        .length,
    ).toEqual(1);
  });

  it("non-interactive transient is silent on elicitation counters", async () => {
    mockCreateMCPTools.mockResolvedValueOnce(
      makeResult({ disconnected: [transientEntry("google-calendar", "google-calendar")] }),
    );

    await expect(createMCPToolsWithRetry(configsAll, makeLogger())).rejects.toMatchObject({
      name: "LinkCredentialUnavailableError",
    });
    expect(sink.getCount("link.oauth.elicitation.created")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.deduped")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.answered_retry")).toEqual(0);
    expect(sink.getCount("link.oauth.elicitation.answered_cancel")).toEqual(0);
  });
});
