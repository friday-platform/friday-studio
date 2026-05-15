// Real-subprocess test for stderr capture. Deliberately does NOT mock
// @ai-sdk/mcp — that's the layer where the capture bug lives. Mock-only
// coverage missed a Deno child_process compat issue where an in-memory
// Writable passed as stderr silently fell back to "inherit", sending
// subprocess output to the parent's stderr instead of the capture buffer.

import process from "node:process";
import type { MCPServerConfig } from "@atlas/config";
import { describe, expect, it, vi } from "vitest";
import { createMCPTools } from "./create-mcp-tools.ts";

const fakeLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child() {
    return this;
  },
} as unknown as import("@atlas/logger").Logger;

describe("createMCPTools stderr capture (real subprocess)", () => {
  it("captures stderr from a failing subprocess and surfaces it in the connection-error log", async () => {
    const configs: Record<string, MCPServerConfig> = {
      bogus: {
        transport: {
          type: "stdio",
          command: "sh",
          args: ["-c", "echo 'CAPTURED_STDERR_TOKEN' >&2; exit 1"],
        },
      },
    };

    await createMCPTools(configs, fakeLogger);

    expect(fakeLogger.warn).toHaveBeenCalledWith(
      "MCP server skipped due to connection error",
      expect.objectContaining({ error: expect.stringContaining("CAPTURED_STDERR_TOKEN") }),
    );
  });

  it("retries with uvx --from when a real subprocess emits the uv entrypoint-mismatch hint", async () => {
    // First attempt: fail with the uv hint on stderr. Second attempt: fail
    // immediately with no hint. We assert two spawns happened and the second
    // received the recovered --from args. Verifying the retry's args is the
    // end-to-end proof that stderr capture → regex → retry actually flows.
    //
    // Use a marker file so we can branch on attempt-count from inside sh.
    const marker = `/tmp/mcp-uvx-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const bt = "`"; // literal backtick — embedding inside template-literal breaks transform
    const firstAttemptScript = [
      `if [ -f ${marker} ]; then`,
      `  echo 'second attempt' >&2`,
      `  exit 1`,
      `else`,
      `  touch ${marker}`,
      `  echo 'An executable named ${bt}my-pkg${bt} is not provided by package ${bt}my-pkg${bt}.' >&2`,
      `  echo 'The following executables are available:' >&2`,
      `  echo '- my-bin' >&2`,
      `  echo '' >&2`,
      `  echo 'Use ${bt}uvx --from my-pkg my-bin${bt} instead.' >&2`,
      `  exit 1`,
      `fi`,
    ].join("\n");

    const configs: Record<string, MCPServerConfig> = {
      // command must be "uvx" so the recovery guard fires; sh -c invocation
      // emulates uv's failure surface without requiring uv installed.
      "fake-uvx": { transport: { type: "stdio", command: "uvx", args: ["my-pkg==1.0"] } },
    };

    try {
      // Substitute the actual `uvx` binary by prepending a temp dir with a
      // shell script named `uvx` to PATH.
      const tmpdir = `/tmp/mcp-uvx-shim-${Date.now()}`;
      const { mkdirSync, writeFileSync, chmodSync, rmSync } = await import("node:fs");
      mkdirSync(tmpdir, { recursive: true });
      writeFileSync(`${tmpdir}/uvx`, `#!/bin/sh\n${firstAttemptScript}\n`, "utf8");
      chmodSync(`${tmpdir}/uvx`, 0o755);

      const originalPath = process.env.PATH;
      process.env.PATH = `${tmpdir}:${originalPath ?? ""}`;

      try {
        await createMCPTools(configs, fakeLogger);
      } finally {
        process.env.PATH = originalPath;
        rmSync(tmpdir, { recursive: true, force: true });
        const { existsSync, unlinkSync } = await import("node:fs");
        if (existsSync(marker)) unlinkSync(marker);
      }

      expect(fakeLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("retrying"),
        expect.objectContaining({
          operation: "mcp_connect_recover",
          recoveryArgs: ["--from", "my-pkg==1.0", "my-bin"],
        }),
      );
    } finally {
      const { existsSync, unlinkSync } = await import("node:fs");
      if (existsSync(marker)) unlinkSync(marker);
    }
  }, 15_000);
});
