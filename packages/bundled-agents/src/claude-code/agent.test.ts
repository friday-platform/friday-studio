import type { HookInput } from "@anthropic-ai/claude-agent-sdk";
import type { AgentContext } from "@atlas/agent-sdk";
import { createStubPlatformModels } from "@atlas/llm";
import type { LogContext, Logger } from "@atlas/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ActivityTracker,
  claudeCodeAgent,
  createKeepalive,
  MESSAGE_TIMEOUT_MS,
  parseStructuredOutput,
  selectModel,
  withMessageTimeout,
} from "./agent.ts";

// --- Module mocks for handler-level tests (structured output wiring) ---

const mockQuery = vi.hoisted(() => vi.fn());
const mockCreateSandbox = vi.hoisted(() => vi.fn());

vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return { ...mod, query: mockQuery };
});

vi.mock("./sandbox.ts", () => ({ createSandbox: mockCreateSandbox, sandboxOptions: {} }));

/**
 * Creates a minimal mock Logger for testing.
 * All methods are no-ops by default.
 */
function createMockLogger(): Logger {
  const noop = () => {};
  const logger: Logger = {
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: (_context: LogContext) => logger,
  };
  return logger;
}

const stubPlatformModels = createStubPlatformModels();

/**
 * Creates a minimal mock AgentContext for testing.
 * Only provides what's required by the agent handler.
 */
function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    tools: {},
    session: { sessionId: "test-session-id", workspaceId: "test-workspace-id" },
    env: {},
    stream: undefined,
    logger: createMockLogger(),
    platformModels: stubPlatformModels,
    ...overrides,
  };
}

it("fails fast without ANTHROPIC_API_KEY", async () => {
  const result = await claudeCodeAgent.execute("test prompt", createMockContext({ env: {} }));

  expect(result.ok).toEqual(false);
  if (!result.ok) {
    expect(result.error.reason).toContain("ANTHROPIC_API_KEY");
  }
});

it("works without GH_TOKEN (optional)", async () => {
  const result = await claudeCodeAgent.execute(
    "test prompt",
    createMockContext({ env: { ANTHROPIC_API_KEY: "sk-test" } }),
  );

  // Should not fail due to missing GH_TOKEN — it's optional
  // (may fail for other reasons like missing claude CLI, but not GH_TOKEN)
  if (!result.ok) {
    expect(result.error.reason).not.toContain("GH_TOKEN");
  }
});

/**
 * Creates an async iterable whose next() never resolves.
 * Simulates the SDK hanging during subagent execution.
 */
function hangingIterable<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<T>>(() => {}) };
    },
  };
}

/**
 * Creates an async iterable that yields values on demand.
 */
function controllableIterable<T>() {
  const pending: Array<(result: IteratorResult<T>) => void> = [];
  return {
    iterable: {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return new Promise<IteratorResult<T>>((resolve) => {
              pending.push(resolve);
            });
          },
        };
      },
    },
    emit(value: T) {
      const resolve = pending.shift();
      if (resolve) resolve({ value, done: false });
    },
    end() {
      const resolve = pending.shift();
      if (resolve) resolve({ value: undefined as T, done: true });
    },
  };
}

/** Collect all values from an async generator into an array. */
async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const v of gen) values.push(v);
  return values;
}

describe("selectModel", () => {
  it("routes high effort to Opus with Sonnet fallback", () => {
    const { model, fallbackModel } = selectModel("high");
    expect(model).toBe("claude-opus-4-6");
    expect(fallbackModel).toBe("claude-sonnet-4-6");
  });

  it("routes medium effort to Sonnet with Haiku fallback", () => {
    const { model, fallbackModel } = selectModel("medium");
    expect(model).toBe("claude-sonnet-4-6");
    expect(fallbackModel).toBe("claude-haiku-4-5");
  });

  it("routes low effort to Sonnet with Haiku fallback", () => {
    const { model, fallbackModel } = selectModel("low");
    expect(model).toBe("claude-sonnet-4-6");
    expect(fallbackModel).toBe("claude-haiku-4-5");
  });
});

/** Minimal valid HookInput for testing — only required fields */
const testHookInput: HookInput = {
  session_id: "test",
  transcript_path: "/tmp/test",
  cwd: "/tmp",
  hook_event_name: "PostToolUse",
  tool_name: "Read",
  tool_input: {},
  tool_response: "",
  tool_use_id: "test-id",
};

const testHookOptions = { signal: AbortSignal.timeout(5000) };

describe("createKeepalive", () => {
  it("updates activity tracker timestamp and returns continue", async () => {
    const activity: ActivityTracker = { lastActivityMs: 0 };
    const keepalive = createKeepalive(activity);

    const before = Date.now();
    const result = await keepalive(testHookInput, "tool-1", testHookOptions);
    const after = Date.now();

    expect(activity.lastActivityMs).toBeGreaterThanOrEqual(before);
    expect(activity.lastActivityMs).toBeLessThanOrEqual(after);
    expect(result).toEqual({ continue: true });
  });
});

describe("parseStructuredOutput", () => {
  it.each([
    { input: '{"name": "test", "count": 42}', expected: { name: "test", count: 42 } },
    {
      input: '{"data": {"nested": true}, "items": [1, 2]}',
      expected: { data: { nested: true }, items: [1, 2] },
    },
  ])("returns parsed record for valid JSON object: $input", ({ input, expected }) => {
    expect(parseStructuredOutput(input)).toEqual(expected);
  });

  it.each([
    "not json at all",
    '{"name": "test", "count":',
    "",
  ])("returns undefined for invalid JSON: %s", (input) => {
    expect(parseStructuredOutput(input)).toBeUndefined();
  });

  it.each([
    "[1, 2, 3]",
    '"just a string"',
    "42",
  ])("returns undefined for non-object JSON: %s", (input) => {
    expect(parseStructuredOutput(input)).toBeUndefined();
  });
});

describe("withMessageTimeout", () => {
  const onTimeout = () => new Error("stall detected");

  it("yields values normally when messages arrive before timeout", async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const gen = withMessageTimeout(source(), MESSAGE_TIMEOUT_MS, onTimeout, activity);

    const values = await collect(gen);
    expect(values).toEqual([1, 2, 3]);
  });

  // Short timeout for testing without waiting 10+ minutes.
  const SHORT_TIMEOUT_MS = 50;

  it("rejects when no activity at all for the timeout duration", async () => {
    // No activity — lastActivityMs is far in the past
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 200 };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      SHORT_TIMEOUT_MS,
      onTimeout,
      activity,
    );

    const consumePromise = gen.next();
    const errorPromise = consumePromise.then(
      () => undefined,
      (e: Error) => e,
    );

    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("stall detected");
  });

  it("does not reject when stderr keeps activity fresh", async () => {
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const { iterable, emit } = controllableIterable<string>();
    const gen = withMessageTimeout(iterable, SHORT_TIMEOUT_MS, onTimeout, activity);

    const consumePromise = gen.next();

    // Simulate stderr activity keeping the process alive
    const keepAlive = setInterval(() => {
      activity.lastActivityMs = Date.now();
    }, SHORT_TIMEOUT_MS / 3);

    // Wait longer than the timeout — should NOT reject because stderr is active
    await new Promise((r) => setTimeout(r, SHORT_TIMEOUT_MS * 3));

    clearInterval(keepAlive);

    // Now emit a real message — should succeed
    emit("subagent done");
    const result = await consumePromise;
    expect(result.value).toBe("subagent done");
  });

  it("rejects after activity stops and timeout elapses", async () => {
    // Activity was recent at start
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      SHORT_TIMEOUT_MS,
      onTimeout,
      activity,
    );

    // Don't update activity — process goes silent
    const startTime = Date.now();
    const consumePromise = gen.next();
    const errorPromise = consumePromise.then(
      () => undefined,
      (e: Error) => e,
    );

    const error = await errorPromise;
    const elapsed = Date.now() - startTime;

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("stall detected");
    // Should have waited at least the timeout duration
    expect(elapsed).toBeGreaterThanOrEqual(SHORT_TIMEOUT_MS * 0.8);
  });

  it("survives silence when a message arrives before timeout", async () => {
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const { iterable, emit } = controllableIterable<string>();
    const gen = withMessageTimeout(iterable, SHORT_TIMEOUT_MS, onTimeout, activity);

    const consumePromise = gen.next();

    // Wait less than timeout, then emit a message
    await new Promise((r) => setTimeout(r, SHORT_TIMEOUT_MS * 0.5));
    emit("arrived in time");

    const result = await consumePromise;
    expect(result.value).toBe("arrived in time");
  });

  it("calls iterator.return() on normal completion", async () => {
    let returnCalled = false;
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        let i = 0;
        return {
          next() {
            return Promise.resolve(
              i < 2
                ? { value: ++i, done: false as const }
                : ({ value: undefined, done: true as const } as IteratorResult<number>),
            );
          },
          return() {
            returnCalled = true;
            return Promise.resolve({
              value: undefined,
              done: true as const,
            } as IteratorResult<number>);
          },
        };
      },
    };
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const values = await collect(
      withMessageTimeout(iterable, MESSAGE_TIMEOUT_MS, onTimeout, activity),
    );

    expect(values).toEqual([1, 2]);
    expect(returnCalled).toBe(true);
  });

  it("calls iterator.return() on timeout", async () => {
    let returnCalled = false;
    const iterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<number>>(() => {}),
          return() {
            returnCalled = true;
            return Promise.resolve({
              value: undefined,
              done: true as const,
            } as IteratorResult<number>);
          },
        };
      },
    };
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 200 };
    const gen = withMessageTimeout(iterable, SHORT_TIMEOUT_MS, onTimeout, activity);

    await gen.next().catch(() => {});
    expect(returnCalled).toBe(true);
  });

  it("propagates iterator.next() rejection", async () => {
    const streamError = new Error("stream exploded");
    const failingIterable: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.reject(streamError) };
      },
    };
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const gen = withMessageTimeout(failingIterable, SHORT_TIMEOUT_MS, onTimeout, activity);

    const error = await gen.next().then(
      () => undefined,
      (e: Error) => e,
    );

    expect(error).toBe(streamError);
    expect(error?.message).toBe("stream exploded");
  });
});

// --- Handler-level tests for outputSchema → outputFormat → structured_output wiring ---

/** Creates a mock SDK stream that yields messages then completes. */
function createMockSDKStream(messages: Record<string, unknown>[]) {
  return {
    [Symbol.asyncIterator]() {
      let i = 0;
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (i < messages.length) {
            return Promise.resolve({ value: messages[i++], done: false });
          }
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
    close() {},
  };
}

/** Minimal SDK result message shape for testing. */
function sdkResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    is_error: false,
    result: "",
    total_cost_usd: 0,
    num_turns: 1,
    ...overrides,
  };
}

describe("structured output wiring", () => {
  const testSchema = {
    type: "object",
    properties: {
      summary: { type: "string" },
      keyPoints: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "keyPoints"],
  };

  const testEnv = { ANTHROPIC_API_KEY: "sk-test", GH_TOKEN: "ghp-test" };

  beforeEach(() => {
    mockQuery.mockReset();
    mockCreateSandbox.mockReset();

    mockCreateSandbox.mockResolvedValue({
      workDir: "/tmp/test-sandbox",
      cleanup: () => Promise.resolve(),
    });
  });

  it("passes outputFormat to SDK when outputSchema is provided", async () => {
    mockQuery.mockReturnValue(
      createMockSDKStream([sdkResult({ structured_output: { summary: "x", keyPoints: [] } })]),
    );

    await claudeCodeAgent.execute(
      "test",
      createMockContext({ env: testEnv, outputSchema: testSchema }),
    );

    expect(mockQuery).toHaveBeenCalledOnce();
    const call = mockQuery.mock.calls[0];
    expect.assert(call);
    const opts = call[0].options;
    expect(opts.outputFormat).toEqual({ type: "json_schema", schema: testSchema });
  });

  it("omits outputFormat when outputSchema is absent", async () => {
    mockQuery.mockReturnValue(createMockSDKStream([sdkResult({ result: "plain text" })]));

    await claudeCodeAgent.execute("test", createMockContext({ env: testEnv }));

    const call = mockQuery.mock.calls[0];
    expect.assert(call);
    const opts = call[0].options;
    expect(opts.outputFormat).toBeUndefined();
  });

  it("returns structured_output as ok data", async () => {
    const structured = { summary: "TS generics", keyPoints: ["Type safety", "Reusability"] };
    mockQuery.mockReturnValue(createMockSDKStream([sdkResult({ structured_output: structured })]));

    const result = await claudeCodeAgent.execute(
      "test",
      createMockContext({ env: testEnv, outputSchema: testSchema }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual(structured);
    }
  });

  it("falls back to parsing responseText when structured_output is absent", async () => {
    const jsonText = '{"summary": "fallback", "keyPoints": ["p1"]}';
    mockQuery.mockReturnValue(createMockSDKStream([sdkResult({ result: jsonText })]));

    const result = await claudeCodeAgent.execute(
      "test",
      createMockContext({ env: testEnv, outputSchema: testSchema }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ summary: "fallback", keyPoints: ["p1"] });
    }
  });

  it("falls back to plain text when outputSchema present but response is not JSON", async () => {
    mockQuery.mockReturnValue(
      createMockSDKStream([sdkResult({ result: "just plain text, no JSON here" })]),
    );

    const result = await claudeCodeAgent.execute(
      "test",
      createMockContext({ env: testEnv, outputSchema: testSchema }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({ response: "just plain text, no JSON here" });
    }
  });
});
