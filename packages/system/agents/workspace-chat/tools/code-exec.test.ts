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

  it("auto-extends the timeout past 30 s for interactive-auth commands", async () => {
    // Script mentions `op`, which the regex matches — the default 30 s
    // timeout should lift to the 120 s max so a real auth prompt has
    // time to complete. We don't actually wait 120 s here; we just
    // prove the logic path doesn't error on a quick op-mentioning
    // script. The hint-branch test below separately pins the SIGKILL
    // timeout message.
    const tools = createRunCodeTool("test-session-auth-timeout", logger);
    const run = getExecute(tools.run_code);

    const result = await run({
      language: "bash",
      source: "# op item create: auth-requiring command\nsleep 0.1 && exit 0",
    });

    if (!hasKey(result, "exit_code")) {
      throw new Error(`expected success shape, got ${JSON.stringify(result)}`);
    }
    expect(result.exit_code).toBe(0);
  });

  it("adds a 'didn't tap Authorize' hint when an auth command times out", async () => {
    // Force a timeout by setting `timeout_ms: 1000` on a 3 s sleep that
    // mentions `op`. The sigkill path should emit the interactive-auth
    // hint that tells the LLM not to retry.
    const tools = createRunCodeTool("test-session-auth-sigkill", logger);
    const run = getExecute(tools.run_code);

    const result = await run({
      language: "bash",
      source: "# op: script that outlives the explicit timeout\nsleep 3",
      timeout_ms: 1_000,
    });

    if (!hasKey(result, "error")) {
      throw new Error(`expected timeout error, got ${JSON.stringify(result)}`);
    }
    expect(String(result.error)).toContain("killed by timeout");
    expect(String(result.error)).toContain("Authorize");
    expect(String(result.error)).toContain("do not retry");
  });
});
