import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";

const exec = promisify(execFile);

const ExecErrorSchema = z.object({
  stdout: z.string().optional(),
  stderr: z.string().optional(),
  code: z.number().nullable().optional(),
  signal: z.string().nullable().optional(),
});

const dirname = import.meta.dirname;
if (!dirname) throw new Error("import.meta.dirname is undefined");
const CLI_ENTRY = resolve(dirname, "cli.ts");
const DENO_FLAGS = [
  "run",
  "-q",
  "--allow-all",
  "--unstable-worker-options",
  "--unstable-kv",
  "--unstable-raw-imports",
  "--env-file",
  CLI_ENTRY,
];

/**
 * Run the CLI as a subprocess and return stdout, stderr, and exit code.
 */
async function runCLI(
  ...args: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const { stdout, stderr } = await exec("deno", [...DENO_FLAGS, ...args], { timeout: 15_000 });
    return { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 };
  } catch (error: unknown) {
    const parsed = ExecErrorSchema.safeParse(error);
    if (!parsed.success) return { stdout: "", stderr: "", exitCode: 1 };
    return {
      stdout: (parsed.data.stdout ?? "").trim(),
      stderr: (parsed.data.stderr ?? "").trim(),
      exitCode: parsed.data.code ?? (parsed.data.signal ? 128 : 1),
    };
  }
}

// Each test spawns a `deno run` subprocess that JITs the full CLI graph
// on first invocation; on a cold runner that overruns vitest's 5s default.
// Match runCLI's 15s subprocess timeout file-wide.
describe("CLI output contract", { timeout: 15_000 }, () => {
  it("atlas chat (legacy command) → routes to yargs, not gunshi", async () => {
    const { stdout, stderr } = await runCLI("chat");

    // Yargs handled it — output must NOT be a gunshi/router error
    expect(stdout).not.toContain("Command not found");
    expect(stderr).not.toContain("Command not found");
  });

  it("atlas (no args) → routes to yargs, exits non-zero", async () => {
    const { exitCode } = await runCLI();
    expect(exitCode).not.toBe(0);
  });

  it("atlas nonexistent → error message, exit code non-zero", async () => {
    const { stderr, exitCode } = await runCLI("nonexistent");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Command not found: nonexistent");
  });
});
