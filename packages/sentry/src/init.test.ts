import type { ErrorEvent, StackFrame } from "@sentry/deno";
import { describe, expect, test } from "vitest";
import { rewriteFrames } from "./init.ts";

function makeEvent(
  exceptionFrames?: Partial<StackFrame>[],
  threadFrames?: Partial<StackFrame>[],
): ErrorEvent {
  const event: ErrorEvent = { type: undefined };
  if (exceptionFrames) {
    event.exception = { values: [{ stacktrace: { frames: exceptionFrames as StackFrame[] } }] };
  }
  if (threadFrames) {
    event.threads = { values: [{ stacktrace: { frames: threadFrames as StackFrame[] } }] };
  }
  return event;
}

describe("rewriteFrames", () => {
  test("strips compile-time prefix from exception frames", () => {
    const event = makeEvent([
      {
        filename: "/tmp/deno-compile-atlas/apps/atlasd/src/atlas-daemon.ts",
        abs_path: "/tmp/deno-compile-atlas/apps/atlasd/src/atlas-daemon.ts",
      },
    ]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe("apps/atlasd/src/atlas-daemon.ts");
    expect(frame?.abs_path).toBe("apps/atlasd/src/atlas-daemon.ts");
  });

  test("strips compile-time prefix from thread frames", () => {
    const event = makeEvent(undefined, [
      {
        filename: "/tmp/deno-compile-atlas/apps/atlasd/src/atlas-daemon.ts",
        abs_path: "/tmp/deno-compile-atlas/apps/atlasd/src/atlas-daemon.ts",
      },
    ]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.threads?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe("apps/atlasd/src/atlas-daemon.ts");
    expect(frame?.abs_path).toBe("apps/atlasd/src/atlas-daemon.ts");
  });

  test("handles node_modules paths", () => {
    const event = makeEvent([
      {
        filename:
          "/tmp/deno-compile-atlas/node_modules/.deno/hono@4.12.5/node_modules/hono/dist/compose.js",
      },
    ]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe(
      "node_modules/.deno/hono@4.12.5/node_modules/hono/dist/compose.js",
    );
  });

  test("handles Docker build path (/app/...)", () => {
    const event = makeEvent([{ filename: "/app/apps/atlasd/src/atlas-daemon.ts" }]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe("apps/atlasd/src/atlas-daemon.ts");
  });

  test("handles packages/ paths", () => {
    const event = makeEvent([{ filename: "/tmp/deno-compile-atlas/packages/sentry/src/init.ts" }]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe("packages/sentry/src/init.ts");
  });

  test("handles tools/ paths", () => {
    const event = makeEvent([
      { filename: "/tmp/deno-compile-atlas/tools/agent-playground/src/lib/server/routes/mcp.ts" },
    ]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe("tools/agent-playground/src/lib/server/routes/mcp.ts");
  });

  test("leaves already-relative paths unchanged", () => {
    const event = makeEvent([{ filename: "apps/atlasd/src/atlas-daemon.ts" }]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe("apps/atlasd/src/atlas-daemon.ts");
  });

  test("leaves unrecognized paths unchanged", () => {
    const event = makeEvent([{ filename: "/usr/lib/some-system-lib.js" }]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frame = result.exception?.values?.[0]?.stacktrace?.frames?.[0];

    expect(frame?.filename).toBe("/usr/lib/some-system-lib.js");
  });

  test("handles event with no exceptions or threads", () => {
    const event: ErrorEvent = { type: undefined };
    const result = rewriteFrames(event);
    expect(result).toEqual({ type: undefined });
  });

  test("handles exceptions without stacktraces", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ type: "Error", value: "something broke" }] },
    };
    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    expect(result.exception?.values?.[0]?.type).toBe("Error");
  });

  test("handles multiple exceptions and threads", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          {
            stacktrace: { frames: [{ filename: "/tmp/build/apps/atlasd/src/a.ts" } as StackFrame] },
          },
          {
            stacktrace: {
              frames: [{ filename: "/tmp/build/packages/core/src/b.ts" } as StackFrame],
            },
          },
        ],
      },
      threads: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: "/tmp/build/tools/playground/c.ts" } as StackFrame],
            },
          },
        ],
      },
    };

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");

    expect(result.exception?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe(
      "apps/atlasd/src/a.ts",
    );
    expect(result.exception?.values?.[1]?.stacktrace?.frames?.[0]?.filename).toBe(
      "packages/core/src/b.ts",
    );
    expect(result.threads?.values?.[0]?.stacktrace?.frames?.[0]?.filename).toBe(
      "tools/playground/c.ts",
    );
  });

  test("matches real Sentry event from ATLAS-5R8", () => {
    const event = makeEvent([
      {
        filename:
          "/tmp/deno-compile-atlas/node_modules/.deno/hono@4.12.5/node_modules/hono/dist/compose.js",
        abs_path:
          "/tmp/deno-compile-atlas/node_modules/.deno/hono@4.12.5/node_modules/hono/dist/compose.js",
      },
      {
        filename: "/tmp/deno-compile-atlas/apps/atlasd/src/factory.ts",
        abs_path: "/tmp/deno-compile-atlas/apps/atlasd/src/factory.ts",
      },
      {
        filename: "/tmp/deno-compile-atlas/apps/atlasd/src/atlas-daemon.ts",
        abs_path: "/tmp/deno-compile-atlas/apps/atlasd/src/atlas-daemon.ts",
      },
      {
        filename:
          "/tmp/deno-compile-atlas/node_modules/.deno/@hono+mcp@0.2.4/node_modules/@hono/mcp/dist/index.js",
        abs_path:
          "/tmp/deno-compile-atlas/node_modules/.deno/@hono+mcp@0.2.4/node_modules/@hono/mcp/dist/index.js",
      },
    ]);

    const result = rewriteFrames(event);
    if (!result) throw new Error("expected non-null result");
    const frames = result.exception?.values?.[0]?.stacktrace?.frames ?? [];

    expect(frames[0]?.filename).toBe(
      "node_modules/.deno/hono@4.12.5/node_modules/hono/dist/compose.js",
    );
    expect(frames[1]?.filename).toBe("apps/atlasd/src/factory.ts");
    expect(frames[2]?.filename).toBe("apps/atlasd/src/atlas-daemon.ts");
    expect(frames[3]?.filename).toBe(
      "node_modules/.deno/@hono+mcp@0.2.4/node_modules/@hono/mcp/dist/index.js",
    );
  });

  test("filters AbortError events", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ type: "AbortError", value: "The operation was aborted" }] },
    };
    expect(rewriteFrames(event)).toBeNull();
  });

  test("filters UserConfigurationError events", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ type: "UserConfigurationError", value: "missing OAuth" }] },
    };
    expect(rewriteFrames(event)).toBeNull();
  });

  test("does not filter unrelated error types", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: { values: [{ type: "TypeError", value: "cannot read property" }] },
    };
    expect(rewriteFrames(event)).not.toBeNull();
  });

  test("filters when filtered type is in chained exception (non-primary position)", () => {
    const event: ErrorEvent = {
      type: undefined,
      exception: {
        values: [
          { type: "Error", value: "wrapper error" },
          { type: "AbortError", value: "The operation was aborted" },
        ],
      },
    };
    expect(rewriteFrames(event)).toBeNull();
  });
});
