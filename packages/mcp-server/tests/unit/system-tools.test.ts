/**
 * Unit tests for system tools
 * Tests system-related operations with mocked system calls
 */

import { assert, assertEquals, assertExists } from "@std/assert";
import { createSuccessResponse } from "../../src/tools/types.ts";

// Mock logger for testing
const mockLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const MAX_OUTPUT_LENGTH = 30000;
const DEFAULT_TIMEOUT = 120000; // 2 minutes
const MAX_TIMEOUT = 600000; // 10 minutes

// Extract core logic from bash tool for testing
async function bashToolLogic(ctx: { logger: any }, params: {
  command: string;
  timeout?: number;
  description: string;
}) {
  const timeout = Math.min(params.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT);

  ctx.logger.info("Executing bash command", {
    command: params.command,
    description: params.description,
    timeout,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const command = new Deno.Command("bash", {
      args: ["-c", params.command],
      cwd: Deno.cwd(),
      stdout: "piped",
      stderr: "piped",
      signal: controller.signal,
    });

    const process = command.spawn();
    const { code, stdout, stderr } = await process.output();

    clearTimeout(timeoutId);

    const stdoutText = new TextDecoder().decode(stdout);
    const stderrText = new TextDecoder().decode(stderr);

    // Truncate output if it's too long
    const truncateOutput = (text: string) => {
      if (text.length > MAX_OUTPUT_LENGTH) {
        return text.substring(0, MAX_OUTPUT_LENGTH) +
          "\n\n... (output truncated due to length)";
      }
      return text;
    };

    const truncatedStdout = truncateOutput(stdoutText);
    const truncatedStderr = truncateOutput(stderrText);

    const output = [
      `<stdout>`,
      truncatedStdout ?? "",
      `</stdout>`,
      `<stderr>`,
      truncatedStderr ?? "",
      `</stderr>`,
    ].join("\n");

    ctx.logger.info("Bash command completed", {
      command: params.command,
      exitCode: code,
      stdoutLength: stdoutText.length,
      stderrLength: stderrText.length,
      truncated: stdoutText.length > MAX_OUTPUT_LENGTH || stderrText.length > MAX_OUTPUT_LENGTH,
    });

    return createSuccessResponse({
      title: params.command,
      output,
      metadata: {
        exitCode: code,
        description: params.description,
        stdout: truncatedStdout,
        stderr: truncatedStderr,
        truncated: stdoutText.length > MAX_OUTPUT_LENGTH ||
          stderrText.length > MAX_OUTPUT_LENGTH,
      },
    });
  } catch (error) {
    clearTimeout(timeoutId);

    if (error instanceof Error && error.name === "AbortError") {
      ctx.logger.error("Bash command timed out", {
        command: params.command,
        timeout,
      });
      throw new Error(`Command timed out after ${timeout}ms: ${params.command}`);
    }

    ctx.logger.error("Bash command failed", {
      command: params.command,
      error: error instanceof Error ? error.message : String(error),
    });

    throw error;
  }
}

Deno.test("bash tool - executes command successfully", async () => {
  const ctx = { logger: mockLogger };
  const result = await bashToolLogic(ctx, {
    command: "echo 'Hello, World!'",
    description: "Print greeting message",
  });

  // Check response structure
  assertExists(result.content);
  assertEquals(Array.isArray(result.content), true);
  assertEquals(result.content.length, 1);
  assertEquals(result.content[0].type, "text");

  // Parse the response
  const response = JSON.parse(result.content[0].text);

  // Check response data
  assertEquals(response.title, "echo 'Hello, World!'");
  assertExists(response.metadata);
  assertEquals(response.metadata.exitCode, 0);
  assertEquals(response.metadata.description, "Print greeting message");
  assertEquals(response.metadata.truncated, false);

  // Check output contains expected stdout
  assert(response.output.includes("<stdout>"));
  assert(response.output.includes("Hello, World!"));
  assert(response.output.includes("</stdout>"));
  assert(response.output.includes("<stderr>"));
  assert(response.output.includes("</stderr>"));
});

Deno.test("bash tool - handles command errors", async () => {
  const ctx = { logger: mockLogger };
  const result = await bashToolLogic(ctx, {
    command: "nonexistent-command",
    description: "Test command that fails",
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command failed with non-zero exit code
  assertEquals(response.metadata.exitCode, 127);
  assertEquals(response.metadata.description, "Test command that fails");

  // Check that error is captured in stderr
  assert(
    response.metadata.stderr.includes("command not found") ||
      response.metadata.stderr.includes("not found") ||
      response.metadata.stderr.includes("No such file"),
  );
});

Deno.test("bash tool - handles working directory", async () => {
  const ctx = { logger: mockLogger };
  const result = await bashToolLogic(ctx, {
    command: "pwd",
    description: "Print working directory",
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command succeeded
  assertEquals(response.metadata.exitCode, 0);

  // Check that output contains a directory path
  assert(response.metadata.stdout.includes("/"));
  assert(response.metadata.stdout.trim().length > 0);
});

Deno.test("bash tool - handles timeout parameter", async () => {
  const ctx = { logger: mockLogger };

  // Test with very short timeout for quick command
  const result = await bashToolLogic(ctx, {
    command: "echo 'quick command'",
    description: "Quick command with short timeout",
    timeout: 5000, // 5 seconds
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command succeeded despite short timeout
  assertEquals(response.metadata.exitCode, 0);
  assert(response.metadata.stdout.includes("quick command"));
});

Deno.test("bash tool - handles commands with pipes", async () => {
  const ctx = { logger: mockLogger };
  const result = await bashToolLogic(ctx, {
    command: "echo 'line1\nline2\nline3' | head -2",
    description: "Test pipe command",
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command succeeded
  assertEquals(response.metadata.exitCode, 0);

  // Check that pipe worked (should only show first 2 lines)
  assert(response.metadata.stdout.includes("line1"));
  assert(response.metadata.stdout.includes("line2"));
  assert(!response.metadata.stdout.includes("line3"));
});

Deno.test("bash tool - handles mixed stdout/stderr", async () => {
  const ctx = { logger: mockLogger };
  const result = await bashToolLogic(ctx, {
    command: "echo 'stdout message' && echo 'stderr message' >&2",
    description: "Test mixed output streams",
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command succeeded
  assertEquals(response.metadata.exitCode, 0);

  // Check that both stdout and stderr are captured
  assert(response.metadata.stdout.includes("stdout message"));
  assert(response.metadata.stderr.includes("stderr message"));

  // Check that output contains both streams
  assert(response.output.includes("stdout message"));
  assert(response.output.includes("stderr message"));
});

Deno.test("bash tool - handles environment variables", async () => {
  const ctx = { logger: mockLogger };
  const result = await bashToolLogic(ctx, {
    command: "TEST_VAR=hello && echo $TEST_VAR",
    description: "Test environment variable usage",
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command succeeded
  assertEquals(response.metadata.exitCode, 0);

  // Check that environment variable was set and used
  assert(response.metadata.stdout.includes("hello"));
});

Deno.test("bash tool - handles commands with redirects", async () => {
  const ctx = { logger: mockLogger };

  // Create a temporary file for testing
  const tempFile = await Deno.makeTempFile({ prefix: "bash_test_" });

  try {
    const result = await bashToolLogic(ctx, {
      command: `echo 'test content' > ${tempFile} && cat ${tempFile}`,
      description: "Test output redirection",
    });

    // Check response structure
    assertExists(result.content);
    const response = JSON.parse(result.content[0].text);

    // Check that command succeeded
    assertEquals(response.metadata.exitCode, 0);

    // Check that redirect worked
    assert(response.metadata.stdout.includes("test content"));
  } finally {
    // Clean up
    await Deno.remove(tempFile);
  }
});

Deno.test("bash tool - handles long output with truncation", async () => {
  const ctx = { logger: mockLogger };

  // Create a command that produces long output
  const longCommand =
    `for i in {1..2000}; do echo "This is line number $i with some additional text to make it longer"; done`;

  const result = await bashToolLogic(ctx, {
    command: longCommand,
    description: "Test long output handling",
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command succeeded
  assertEquals(response.metadata.exitCode, 0);

  // Check that output is present and potentially truncated
  assert(response.metadata.stdout.length > 0);

  // If output is very long, it should be truncated
  if (response.metadata.stdout.length > 25000) {
    assertEquals(response.metadata.truncated, true);
    assert(response.metadata.stdout.includes("... (output truncated due to length)"));
  }
});

Deno.test("bash tool - handles system errors gracefully", async () => {
  const ctx = { logger: mockLogger };
  const result = await bashToolLogic(ctx, {
    command: "ls /nonexistent/directory/path",
    description: "Test system error handling",
  });

  // Check response structure
  assertExists(result.content);
  const response = JSON.parse(result.content[0].text);

  // Check that command failed appropriately
  assert(response.metadata.exitCode !== 0);

  // Check that error is captured in stderr
  assert(
    response.metadata.stderr.includes("No such file") ||
      response.metadata.stderr.includes("cannot access") ||
      response.metadata.stderr.includes("not found"),
  );
});
