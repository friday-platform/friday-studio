/**
 * Bridges the workspace-chat `enterUsageScope` ALS across the NATS
 * subscriber boundary by re-entering the registered counter inside
 * `handleLlm`. Without that bridge, the daemon's LLM capability handler
 * runs in the NATS callback's own ALS root and any `traceModel`-wrapped
 * call inside `createLlmGenerateHandler` would not credit the
 * workspace-chat turn.
 */

import { getActiveUsageCounter, type UsageCounter } from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { StringCodec } from "nats";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createLlmGenerateHandlerMock = vi.fn<(opts: unknown) => (json: string) => Promise<string>>();
const createHttpFetchHandlerMock = vi.fn(() => () => Promise.resolve("{}"));

vi.mock("@atlas/workspace/agent-executor-utils", () => ({
  createLlmGenerateHandler: (opts: unknown) => createLlmGenerateHandlerMock(opts),
  createHttpFetchHandler: () => createHttpFetchHandlerMock(),
}));

const { CapabilityHandlerRegistry } = await import("./capability-handlers.ts");

function noopLogger(): Logger {
  const noop = () => {};
  const logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  } as unknown as Logger;
  return logger;
}

const sc = StringCodec();

function makeMsg(subject: string, body: Record<string, unknown>) {
  return { subject, data: sc.encode(JSON.stringify(body)), reply: "_INBOX.test" };
}

const fakeNc = { publish: vi.fn() } as unknown as Parameters<// deno-lint-ignore no-explicit-any
any>[0];

beforeEach(() => {
  createLlmGenerateHandlerMock.mockReset();
  createHttpFetchHandlerMock.mockReset();
});

describe("CapabilityHandlerRegistry handleLlm — usage scope bridge", () => {
  it("re-enters the registered counter when handling a caps.*.llm.generate", async () => {
    const counter: UsageCounter = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    const reg = new CapabilityHandlerRegistry();
    reg.register("session-1", {
      mcpToolCall: vi.fn(),
      mcpListTools: vi.fn(),
      logger: noopLogger(),
      usageCounter: counter,
    });

    // The mocked LLM handler observes whether `getActiveUsageCounter()`
    // returns the registered counter at call time — that's exactly what
    // the workspace's `traceModel`-wrapped model would do via its
    // middleware. If the bridge works, the same object reference comes
    // back; if it doesn't, we get `undefined`.
    let observedCounter: UsageCounter | undefined;
    createLlmGenerateHandlerMock.mockReturnValue(() => {
      observedCounter = getActiveUsageCounter();
      return Promise.resolve(JSON.stringify({ text: "ok" }));
    });

    const msg = makeMsg("caps.session-1.llm.generate", { prompt: "hi" });
    // handleLlm is a private class field — cast through to call it.
    const handler = (
      reg as unknown as {
        handleLlm: (err: Error | null, msg: ReturnType<typeof makeMsg>, nc: typeof fakeNc) => void;
      }
    ).handleLlm;
    handler(null, msg, fakeNc);

    // handleLlm returns void and fires the promise chain async — wait
    // for it to settle. A microtask flush is enough since the mocked
    // handler resolves immediately.
    await new Promise((r) => setTimeout(r, 0));

    expect(observedCounter).toBe(counter);
  });

  it("skips the scope wrap when no counter is registered", async () => {
    const reg = new CapabilityHandlerRegistry();
    reg.register("session-2", {
      mcpToolCall: vi.fn(),
      mcpListTools: vi.fn(),
      logger: noopLogger(),
      // no usageCounter
    });

    let observedCounter: UsageCounter | undefined = {} as UsageCounter;
    createLlmGenerateHandlerMock.mockReturnValue(() => {
      observedCounter = getActiveUsageCounter();
      return Promise.resolve(JSON.stringify({ text: "ok" }));
    });

    const msg = makeMsg("caps.session-2.llm.generate", { prompt: "hi" });
    const handler = (
      reg as unknown as {
        handleLlm: (err: Error | null, msg: ReturnType<typeof makeMsg>, nc: typeof fakeNc) => void;
      }
    ).handleLlm;
    handler(null, msg, fakeNc);
    await new Promise((r) => setTimeout(r, 0));

    expect(observedCounter).toBeUndefined();
  });

  it("responds with 'unknown session' when subject sessionId is not registered", async () => {
    const reg = new CapabilityHandlerRegistry();
    const publishedReplies: string[] = [];
    const nc = {
      publish: (_subject: string, data: Uint8Array) => {
        publishedReplies.push(sc.decode(data));
      },
    } as unknown as typeof fakeNc;

    const msg = makeMsg("caps.ghost-session.llm.generate", { prompt: "hi" });
    const handler = (
      reg as unknown as {
        handleLlm: (err: Error | null, msg: ReturnType<typeof makeMsg>, nc: typeof fakeNc) => void;
      }
    ).handleLlm;
    handler(null, msg, nc);
    await new Promise((r) => setTimeout(r, 0));

    expect(publishedReplies).toHaveLength(1);
    expect(JSON.parse(publishedReplies[0]!)).toEqual({ error: "unknown session" });
    // createLlmGenerateHandler must not have been called for an unknown session.
    expect(createLlmGenerateHandlerMock).not.toHaveBeenCalled();
  });
});
