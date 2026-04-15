import { execFile } from "node:child_process";
import process from "node:process";
import type { ValidationResult } from "./types.ts";

const ERROR_PATTERN = /^(error|ERROR)|TS\d+\s*\[ERROR\]/;

function parseErrors(output: string): string[] {
  return output
    .split("\n")
    .filter((line) => ERROR_PATTERN.test(line))
    .slice(0, 40);
}

function runTypecheck(cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "deno",
      ["task", "typecheck"],
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        const exitCode = error && "code" in error ? (error.code as number) : error ? 1 : 0;
        resolve({ exitCode, output: stdout + "\n" + stderr });
      },
    );
  });
}

export async function validateTypecheck(): Promise<ValidationResult> {
  const cwd = process.env["ATLAS_ROOT"] ?? process.cwd();
  const { exitCode, output } = await runTypecheck(cwd);
  const errors = parseErrors(output);

  if (exitCode === 0) {
    return { validator: "typecheck", ok: true, message: "typecheck passed", evidence: [] };
  }

  const firstError = errors[0] ?? "unknown error";
  return {
    validator: "typecheck",
    ok: false,
    message: `typecheck: ${errors.length} error(s) — first: ${firstError}`,
    evidence: errors,
  };
}
