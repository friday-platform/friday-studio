import type { LogContext, Logger } from "@atlas/logger";
import { describe, expect, it, vi } from "vitest";
import { toDiscordLogger } from "./discord-logger.ts";

interface FakeLogger extends Logger {
  childCalls: LogContext[];
}

function makeFakeLogger(): FakeLogger {
  const childCalls: LogContext[] = [];
  const self: FakeLogger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: (ctx: LogContext) => {
      childCalls.push(ctx);
      return makeFakeLogger();
    },
    childCalls,
  };
  return self;
}

describe("toDiscordLogger", () => {
  it.each([
    "debug",
    "info",
    "warn",
    "error",
  ] as const)("forwards %s() to the atlas logger with variadic args in context", (level) => {
    const atlas = makeFakeLogger();
    const wrapped = toDiscordLogger(atlas);
    wrapped[level]("hello", { foo: 1 }, "bar");
    expect(atlas[level]).toHaveBeenCalledWith("hello", { args: [{ foo: 1 }, "bar"] });
  });

  it("omits the context object when no extra args are passed", () => {
    const atlas = makeFakeLogger();
    toDiscordLogger(atlas).info("just a message");
    expect(atlas.info).toHaveBeenCalledWith("just a message", undefined);
  });

  it("maps child(prefix) to atlasLogger.child({ component: prefix }) and returns a wrapper", () => {
    const atlas = makeFakeLogger();
    const child = toDiscordLogger(atlas).child("discord");
    expect(atlas.childCalls).toEqual([{ component: "discord" }]);
    expect(typeof child.info).toBe("function");
    expect(typeof child.child).toBe("function");
  });
});
