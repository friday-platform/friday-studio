import type { AgentContext } from "@atlas/agent-sdk";
import type { LogContext, Logger } from "@atlas/logger";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

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

  it("rejects at base timeout when stderr is stale and no messages arrive", async () => {
    // stderr was active 2 minutes before the wait — process is cold
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 120_000 };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      MESSAGE_TIMEOUT_MS,
      EXTENDED_TIMEOUT_MS,
      onTimeout,
      activity,
    );

    const consumePromise = gen.next();
    // Pre-register handler so the rejection isn't "unhandled" during timer processing
    const errorPromise = consumePromise.then(
      () => undefined,
      (e: Error) => e,
    );

    // Advance to first check (60s) — should reject
    await vi.advanceTimersByTimeAsync(MESSAGE_TIMEOUT_MS);

    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("stall detected");
  });

  it("uses extended timeout when stderr was active near the wait start", async () => {
    // stderr was active at exactly the time the wait starts (subagent scenario)
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      MESSAGE_TIMEOUT_MS,
      EXTENDED_TIMEOUT_MS,
      onTimeout,
      activity,
    );

    const consumePromise = gen.next();
    // Pre-register handler before advancing timers
    const errorPromise = consumePromise.then(
      () => undefined,
      (e: Error) => e,
    );

    // At 60s: base timer fires. lastActivityMs (= waitStart) is NOT < waitStart - 60s.
    // Base timer does nothing. Should NOT reject.
    await vi.advanceTimersByTimeAsync(MESSAGE_TIMEOUT_MS);
    let settled = false;
    errorPromise.then((e) => {
      if (e) settled = true;
    });
    await vi.advanceTimersByTimeAsync(0); // flush microtasks
    expect(settled).toBe(false);

    // At 180s: extended timer fires — hard cap. Should reject.
    await vi.advanceTimersByTimeAsync(EXTENDED_TIMEOUT_MS - MESSAGE_TIMEOUT_MS);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("stall detected");
  });

  it("survives 113s of silence when stderr was recent (real subagent scenario)", async () => {
    // Simulates: last stderr at t=-2s (shortly before wait started)
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 2_000 };
    const { iterable, emit } = controllableIterable<string>();
    const gen = withMessageTimeout(
      iterable,
      MESSAGE_TIMEOUT_MS,
      EXTENDED_TIMEOUT_MS,
      onTimeout,
      activity,
    );

    const consumePromise = gen.next();

    // Advance 113s (the observed subagent duration) — should NOT reject
    await vi.advanceTimersByTimeAsync(113_000);
    let settled = false;
    consumePromise
      .then(() => {
        settled = true;
      })
      .catch(() => {
        settled = true;
      });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);

    // Now the subagent finishes and a message arrives
    emit("subagent done");
    const result = await consumePromise;
    expect(result.value).toBe("subagent done");
  });

  it("rejects at base timeout when stderr was active long before the wait", async () => {
    // stderr was active 90s before the wait — outside the baseTimeout window
    const activity: ActivityTracker = { lastActivityMs: Date.now() - 90_000 };
    const gen = withMessageTimeout(
      hangingIterable<number>(),
      MESSAGE_TIMEOUT_MS,
      EXTENDED_TIMEOUT_MS,
      onTimeout,
      activity,
    );

    const consumePromise = gen.next();
    const errorPromise = consumePromise.then(
      () => undefined,
      (e: Error) => e,
    );

    // At 60s: lastActivityMs = -90s, waitStart = 0, waitStart - 60s = -60s
    // lastActivityMs (-90s) >= waitStart - baseTimeout (-60s)? NO → base timeout
    await vi.advanceTimersByTimeAsync(MESSAGE_TIMEOUT_MS);
    const error = await errorPromise;
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe("stall detected");
  });
});
