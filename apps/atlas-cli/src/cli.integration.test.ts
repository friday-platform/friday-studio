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

describe("CLI output contract", () => {
  it("atlas version → prints version and channel", async () => {
    const { stdout, exitCode } = await runCLI("version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^atlas v\S+ \((stable|nightly|edge)\)$/);
  });

  it("atlas v → alias for version command", async () => {
    const { stdout, exitCode } = await runCLI("v");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^atlas v\S+ \((stable|nightly|edge)\)$/);
  });

  it("atlas version --json → outputs JSON version info", async () => {
    const { stdout, exitCode } = await runCLI("version", "--json");
    expect(exitCode).toBe(0);
    const parsed = z
      .object({ version: z.string(), isCompiled: z.boolean(), isDev: z.boolean() })
      .parse(JSON.parse(stdout));
    expect(parsed.version).toBeTruthy();
  });

  it("atlas version --help → prints help text (handled by gunshi)", async () => {
    const { stdout, exitCode } = await runCLI("version", "--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("version");
  });

  it("atlas version --version → prints version (handled by gunshi)", async () => {
    const { stdout, exitCode } = await runCLI("version", "--version");
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\S+/); // version string present (dev or semver)
  });

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

  it("atlas --version (top-level flag) → routes to yargs with version output", async () => {
    const { stdout, exitCode } = await runCLI("--version");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Atlas");
  });

  it("atlas version --remote → shows disabled message in dev", async () => {
    const { stdout, exitCode } = await runCLI("version", "--remote");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Remote version checking is disabled for development builds");
  });

  it("atlas version --remote --json → includes remote skip reason in dev", async () => {
    const { stdout, exitCode } = await runCLI("version", "--remote", "--json");
    expect(exitCode).toBe(0);
    const parsed = z
      .object({ remote: z.object({ hasUpdate: z.boolean(), skipped: z.boolean() }) })
      .parse(JSON.parse(stdout));
    expect(parsed.remote).toMatchObject({ hasUpdate: false, skipped: true });
  });

  it("atlas nonexistent → error message, exit code non-zero", async () => {
    const { stderr, exitCode } = await runCLI("nonexistent");
    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("Command not found: nonexistent");
  });
});
