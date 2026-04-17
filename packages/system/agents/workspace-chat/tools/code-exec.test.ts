import type { Logger } from "@atlas/logger";
import { describe, expect, it, vi } from "vitest";
import { createRunCodeTool } from "./code-exec.ts";

const logger: Logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
} as unknown as Logger;

/**
 * Pull the `execute` implementation out of the AI-SDK tool wrapper so the
 * test can drive it directly. The wrapper's shape (`{ execute, ... }`)
 * changes with library versions, so narrow defensively instead of casting.
 */
function getExecute(
  tool: unknown,
): (input: {
  language: "python" | "javascript" | "bash";
  source: string;
  timeout_ms?: number;
}) => Promise<unknown> {
  if (
    typeof tool === "object" &&
    tool !== null &&
    "execute" in tool &&
    typeof (tool as { execute: unknown }).execute === "function"
  ) {
    return (tool as { execute: (input: unknown) => Promise<unknown> }).execute as never;
  }
  throw new Error("run_code tool has no execute method");
}

function hasKey<K extends string>(o: unknown, k: K): o is Record<K, unknown> {
  return typeof o === "object" && o !== null && k in o;
}

describe("run_code — interactive-auth guidance and stream preservation", () => {
  it("adds a TTY hint when a 1Password command fails with empty stderr", async () => {
    const tools = createRunCodeTool("test-session-tty-op", logger);
    const run = getExecute(tools.run_code);

    // Simulate the exact failure mode the user hit: nonzero exit, empty
    // stderr, source text contains `op` (the regex anchor). We can't
    // actually run `op` in the test — on a machine where op is installed,
    // it would wait for a TTY auth prompt and time out; on CI without op,
    // it would write to stderr, defeating the empty-stderr premise.
    const result = await run({
      language: "bash",
      source: "# op item create simulation — silent nonzero exit\nexit 1",
    });

    expect(hasKey(result, "exit_code")).toBe(true);
    if (!hasKey(result, "exit_code")) throw new Error("expected success shape");
    expect(result.exit_code).not.toBe(0);

    expect(hasKey(result, "stderr")).toBe(true);
    const stderr = String(result.stderr);
    expect(stderr).toContain("run_code hint");
    expect(stderr).toContain("/dev/tty");
    expect(stderr).toContain("Do not retry");
  });

  it("does NOT add the hint when the command is not on the interactive-auth list", async () => {
    const tools = createRunCodeTool("test-session-tty-noop", logger);
    const run = getExecute(tools.run_code);

    // `false` alone: nonzero exit, empty stderr, but no op/ssh/sudo in source.
    const result = await run({ language: "bash", source: "echo plain-work && false" });

    if (!hasKey(result, "stderr")) throw new Error("expected success shape");
    const stderr = String(result.stderr);
    expect(stderr).not.toContain("run_code hint");
  });

  it("does NOT add the hint when real stderr content was captured", async () => {
    const tools = createRunCodeTool("test-session-tty-real-stderr", logger);
    const run = getExecute(tools.run_code);

    // `op --not-a-real-flag` will fail with real stderr output; the hint
    // must NOT stomp on the useful diagnostic. We can't rely on op being
    // installed in CI, so emit something `op-ish` via `>&2 echo` instead.
    const result = await run({ language: "bash", source: 'echo "op: unknown flag" >&2 && exit 2' });

    if (!hasKey(result, "stderr")) throw new Error("expected success shape");
    const stderr = String(result.stderr);
    expect(stderr).toContain("op: unknown flag");
    expect(stderr).not.toContain("run_code hint");
  });

  it("preserves stderr on nonzero exit (regression — was lost via the 'code is number' condition)", async () => {
    const tools = createRunCodeTool("test-session-preserve", logger);
    const run = getExecute(tools.run_code);

    const result = await run({
      language: "bash",
      source: 'echo "stdout content" && echo "stderr content" >&2 && exit 7',
    });

    if (!hasKey(result, "stderr")) throw new Error("expected success shape");
    expect(String(result.stdout)).toContain("stdout content");
    expect(String(result.stderr)).toContain("stderr content");
    expect(result.exit_code).toBe(7);
  });
});
