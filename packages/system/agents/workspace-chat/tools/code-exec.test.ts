import process from "node:process";
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

describe("run_code — interactive-auth refusal + stream preservation", () => {
  it("refuses `op item create` instantly with the service-account escape hatch", async () => {
    const prevToken = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    try {
      const tools = createRunCodeTool("test-session-op-refuse", logger);
      const run = getExecute(tools.run_code);

      const started = Date.now();
      const result = await run({
        language: "bash",
        source: 'op item create --category="Secure Note" --title="x" notesPlain="y"',
      });
      const duration = Date.now() - started;

      if (!hasKey(result, "error"))
        throw new Error(`expected refusal, got ${JSON.stringify(result)}`);
      expect(String(result.error)).toContain("run_code refused");
      // Refusal must explain the escape hatch so the user knows how to
      // unblock the flow, not just "run it in your terminal".
      expect(String(result.error)).toContain("OP_SERVICE_ACCOUNT_TOKEN");
      expect(String(result.error)).toContain("service-account token");
      expect(String(result.error)).toContain("op item create");
      // Must be fast — 1 second max. Whole point is to avoid the silent
      // 120 s wait the user was hitting before.
      expect(duration).toBeLessThan(1_000);
    } finally {
      if (prevToken === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
      else process.env.OP_SERVICE_ACCOUNT_TOKEN = prevToken;
    }
  });

  it("ALLOWS `op item create` when OP_SERVICE_ACCOUNT_TOKEN is set", async () => {
    const prev = process.env.OP_SERVICE_ACCOUNT_TOKEN;
    process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_fake_token_for_test";
    try {
      const tools = createRunCodeTool("test-session-op-allowed", logger);
      const run = getExecute(tools.run_code);

      // We can't rely on op being installed or the token being valid in
      // CI; what we CAN prove is that the refusal path is skipped. The
      // source is a harmless `echo` that happens to mention `op item
      // create` — the regex matches, service-account detection kicks in,
      // and the script is allowed to run. Without the escape hatch we'd
      // get a refusal error instead of an exit_code.
      const result = await run({
        language: "bash",
        source: 'echo "service-account test: op item create would run"',
      });

      if (!hasKey(result, "exit_code")) {
        throw new Error(`expected success shape, got ${JSON.stringify(result)}`);
      }
      expect(result.exit_code).toBe(0);
    } finally {
      if (prev === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
      else process.env.OP_SERVICE_ACCOUNT_TOKEN = prev;
    }
  });

  it("does NOT offer the service-account escape hatch for non-op commands", async () => {
    // `ssh`/`sudo`/`gpg` don't have an OP_SERVICE_ACCOUNT_TOKEN analogue,
    // so the refusal message must not suggest one — would just confuse
    // the user with irrelevant instructions.
    const tools = createRunCodeTool("test-session-ssh-refuse", logger);
    const run = getExecute(tools.run_code);

    const result = await run({ language: "bash", source: "ssh deploy@prod 'uptime'" });
    if (!hasKey(result, "error")) throw new Error("expected refusal");
    expect(String(result.error)).toContain("run_code refused");
    expect(String(result.error)).not.toContain("OP_SERVICE_ACCOUNT_TOKEN");
  });

  it("refuses `ssh host` and `sudo …` and `aws sso login`", async () => {
    const tools = createRunCodeTool("test-session-multi-refuse", logger);
    const run = getExecute(tools.run_code);

    for (const source of [
      "ssh deploy@prod 'uptime'",
      "sudo rm /tmp/something",
      "aws sso login --profile staging",
      "gh auth login",
      "gpg --decrypt file.gpg",
    ]) {
      const result = await run({ language: "bash", source });
      if (!hasKey(result, "error")) throw new Error(`expected refusal for ${source}`);
      expect(String(result.error)).toContain("run_code refused");
    }
  });

  it("still runs `op account list` and `op whoami` (no vault auth)", async () => {
    // The refusal regex is narrow: only matches op subcommands that touch
    // the vault. `op account list` reads local config and must keep
    // working from the sandbox.
    const tools = createRunCodeTool("test-session-op-read", logger);
    const run = getExecute(tools.run_code);

    // We can't rely on `op` being installed in CI, so instead of running
    // the real command, we use a shell that only mentions these safe
    // subcommands as arguments to `echo` — that exercises the regex
    // without needing op on PATH. If the regex falsely matched these,
    // we'd get a refusal; since it doesn't, we get a normal exit 0.
    for (const source of [
      'echo "would run: op account list"',
      'echo "would run: op whoami"',
      'echo "would run: op --version"',
      'echo "would run: gpg --version"',
    ]) {
      const result = await run({ language: "bash", source });
      if (!hasKey(result, "exit_code")) {
        throw new Error(`expected success for ${source}, got ${JSON.stringify(result)}`);
      }
      expect(result.exit_code).toBe(0);
    }
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
