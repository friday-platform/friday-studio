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

describe("run_code — PTY wrap for interactive-auth commands", () => {
  it("actually runs an `op`-mentioning bash script under a PTY and returns clean output", async () => {
    // Darwin-only: `script(1)` syntax on Linux differs and the CI
    // image may not have util-linux `script`. Skip there.
    if (process.platform !== "darwin") return;

    const tools = createRunCodeTool("test-session-pty-op", logger);
    const run = getExecute(tools.run_code);

    // Script mentions `op item` so the PTY-wrap path fires, but the
    // actual command is a plain echo — we want to verify that under the
    // PTY, output comes back clean (no `^D\b\b`, no `\r\n`) and the
    // script still exits 0.
    const result = await run({
      language: "bash",
      source: '# op item create would go here\necho "pty-clean-output"; exit 0',
    });

    if (!hasKey(result, "exit_code")) {
      throw new Error(`expected success shape, got ${JSON.stringify(result)}`);
    }
    expect(result.exit_code).toBe(0);
    // The ^D\b\b EOT echo that `script` emits must be stripped before
    // the LLM sees it; so must any `\r\n` → `\n` normalization.
    const stdout = String(result.stdout);
    expect(stdout).toContain("pty-clean-output");
    expect(stdout).not.toContain("\x04");
    expect(stdout).not.toContain("\r\n");
  });

  it("leaves non-auth scripts on the plain exec path (stderr preserved separately)", async () => {
    const tools = createRunCodeTool("test-session-plain", logger);
    const run = getExecute(tools.run_code);

    // No auth-command keyword → plain exec → stderr stays in stderr.
    // Under a PTY, stderr would be merged into stdout, which would
    // break the regression we already locked in for non-auth scripts.
    const result = await run({
      language: "bash",
      source: 'echo "out" && echo "err" >&2 && exit 3',
    });

    if (!hasKey(result, "stderr")) throw new Error("expected success shape");
    expect(String(result.stdout)).toContain("out");
    expect(String(result.stderr)).toContain("err");
    expect(result.exit_code).toBe(3);
  });

  it("still runs `op account list` / `op whoami` on the plain path (no PTY)", async () => {
    // Those read local config and never block on auth. Must NOT be
    // PTY-wrapped (no functional reason, and PTY-wrapping would merge
    // their stderr into stdout unnecessarily).
    const tools = createRunCodeTool("test-session-op-read", logger);
    const run = getExecute(tools.run_code);

    for (const source of [
      'echo "would run: op account list"',
      'echo "would run: op whoami"',
      'echo "would run: op --version"',
    ]) {
      const result = await run({ language: "bash", source });
      if (!hasKey(result, "exit_code")) {
        throw new Error(`expected success for ${source}, got ${JSON.stringify(result)}`);
      }
      expect(result.exit_code).toBe(0);
    }
  });

  it("PTY-wraps every flagged command (op/ssh/sudo/gpg-decrypt/aws-sso/gh-auth) without refusing", async () => {
    if (process.platform !== "darwin") return;
    const tools = createRunCodeTool("test-session-pty-all", logger);
    const run = getExecute(tools.run_code);

    // Each of these matches the auth regex, so it goes through the PTY.
    // We're not actually invoking the auth tool — just proving the
    // script runs to exit 0 under PTY without being refused. `bash -c
    // exit 0` inside a comment-scoped source satisfies the regex match
    // and exits cleanly.
    const sources = [
      "# op item create\nexit 0",
      "# ssh deploy@prod\nexit 0",
      "# sudo reboot\nexit 0",
      "# gpg --decrypt file\nexit 0",
      "# aws sso login\nexit 0",
      "# gh auth login\nexit 0",
      "# gcloud auth login\nexit 0",
    ];
    for (const source of sources) {
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
