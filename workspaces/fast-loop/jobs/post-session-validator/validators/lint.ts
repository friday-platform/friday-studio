import { execFile } from "node:child_process";
import process from "node:process";
import type { ValidationResult } from "./types.ts";

const LINT_ERROR_PATTERN = /^error\[/;

function runLint(cwd: string, files: string[]): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "deno",
      ["lint", ...files],
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 60_000 },
      (error, stdout, stderr) => {
        const exitCode = error && "code" in error ? (error.code as number) : error ? 1 : 0;
        resolve({ exitCode, output: stdout + "\n" + stderr });
      },
    );
  });
}

export async function validateLint(changedFiles: string[]): Promise<ValidationResult> {
  const tsFiles = changedFiles.filter((f) => /\.tsx?$/.test(f));

  if (tsFiles.length === 0) {
    return { validator: "lint", ok: true, message: "lint: no TS files changed", evidence: [] };
  }

  const cwd = process.env["ATLAS_ROOT"] ?? process.cwd();
  const { exitCode, output } = await runLint(cwd, tsFiles);
  const errors = output
    .split("\n")
    .filter((line) => LINT_ERROR_PATTERN.test(line))
    .slice(0, 40);

  if (exitCode === 0) {
    return { validator: "lint", ok: true, message: "lint passed", evidence: [] };
  }

  return {
    validator: "lint",
    ok: false,
    message: `lint: ${errors.length} error(s)`,
    evidence: errors,
  };
}
