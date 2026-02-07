import type { AgentContext } from "@atlas/agent-sdk";
import type { LogContext, Logger } from "@atlas/logger";
import { describe, expect, it } from "vitest";
import {
  type ActivityTracker,
  claudeCodeAgent,
  EXTENDED_TIMEOUT_MS,
  MESSAGE_TIMEOUT_MS,
  withMessageTimeout,
} from "./agent.ts";

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
    ...overrides,
  };
}

it("fails fast without ANTHROPIC_API_KEY", async () => {
  // Pass empty env via context - agent should fail because ANTHROPIC_API_KEY is missing
  const result = await claudeCodeAgent.execute("test prompt", createMockContext({ env: {} }));

  expect(result.ok).toEqual(false);
  if (!result.ok) {
    expect(result.error.reason).toContain("ANTHROPIC_API_KEY");
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

describe("withMessageTimeout", () => {
  const onTimeout = () => new Error("stall detected");

  it("yields values normally when messages arrive before timeout", async () => {
    async function* source() {
      yield 1;
      yield 2;
      yield 3;
    }
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const gen = withMessageTimeout(
      source(),
      MESSAGE_TIMEOUT_MS,
      EXTENDED_TIMEOUT_MS,
      onTimeout,
      activity,
    );

    const values = await collect(gen);
    expect(values).toEqual([1, 2, 3]);
  });

  // Short timeout versions for testing the timeout logic without waiting 60+ seconds.
  // Uses real timers with 50ms base / 150ms extended timeouts for deterministic behavior.
  const SHORT_BASE_MS = 50;
  const SHORT_EXTENDED_MS = 150;

  it("rejects at base timeout when stderr is stale and no messages arrive", async () => {
    // stderr was active 200ms before the wait — process is cold (> SHORT_BASE_MS ago)
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 200 };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      SHORT_BASE_MS,
      SHORT_EXTENDED_MS,
      onTimeout,
      activity,
    );

    const consumePromise = gen.next();
    const errorPromise = consumePromise.then(
      () => undefined,
      (e: Error) => e,
    );

    // Should reject at base timeout (~50ms)
    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("stall detected");
  });

  it("uses extended timeout when stderr was active near the wait start", async () => {
    // stderr was active at exactly the time the wait starts (subagent scenario)
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      SHORT_BASE_MS,
      SHORT_EXTENDED_MS,
      onTimeout,
      activity,
    );

    const startTime = Date.now();
    const consumePromise = gen.next();
    const errorPromise = consumePromise.then(
      () => undefined,
      (e: Error) => e,
    );

    // Should reject at extended timeout (~150ms), not base (~50ms)
    const error = await errorPromise;
    const elapsed = Date.now() - startTime;

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("stall detected");
    // Should have waited longer than base timeout (with some tolerance)
    expect(elapsed).toBeGreaterThan(SHORT_BASE_MS * 0.8);
  });

  it("survives silence when stderr was recent (real subagent scenario)", async () => {
    // Simulates: last stderr at t=-10ms (shortly before wait started)
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 10 };
    const { iterable, emit } = controllableIterable<string>();
    const gen = withMessageTimeout(iterable, SHORT_BASE_MS, SHORT_EXTENDED_MS, onTimeout, activity);

    const consumePromise = gen.next();

    // Wait 40ms (less than SHORT_BASE_MS) - should not have rejected yet
    await new Promise((r) => setTimeout(r, 40));

    // Now the subagent finishes and a message arrives
    emit("subagent done");
    const result = await consumePromise;
    expect(result.value).toBe("subagent done");
  });

  it("rejects at base timeout when stderr was active long before the wait", async () => {
    // stderr was active 100ms before the wait — outside the SHORT_BASE_MS window
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 100 };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      SHORT_BASE_MS,
      SHORT_EXTENDED_MS,
      onTimeout,
      activity,
    );

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
    // Should have timed out around base timeout (50ms), not extended (150ms)
    expect(elapsed).toBeLessThan(SHORT_EXTENDED_MS * 0.8);
  });
});
