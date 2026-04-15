import { execFile } from "node:child_process";
import process from "node:process";
import type { ValidationResult } from "./types.ts";

const AGENT_PY_PATTERN = /^agents\/([^/]+)\/agent\.py$/;

function runAgentBuild(
  cwd: string,
  agentPath: string,
): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolve) => {
    execFile(
      "deno",
      ["task", "atlas", "agent", "build", agentPath],
      { cwd, maxBuffer: 10 * 1024 * 1024, timeout: 120_000 },
      (error, stdout, stderr) => {
        const exitCode = error && "code" in error ? (error.code as number) : error ? 1 : 0;
        resolve({ exitCode, output: stdout + "\n" + stderr });
      },
    );
  });
}

export async function validateAgentBuild(changedFiles: string[]): Promise<ValidationResult> {
  const agentFiles = changedFiles.filter((f) => AGENT_PY_PATTERN.test(f));

  if (agentFiles.length === 0) {
    return {
      validator: "agent-build",
      ok: true,
      message: "agent-build: no agent.py files changed",
      evidence: [],
    };
  }

  const cwd = process.env["ATLAS_ROOT"] ?? process.cwd();
  const evidence: string[] = [];
  let allOk = true;

  for (const file of agentFiles) {
    const match = AGENT_PY_PATTERN.exec(file);
    if (!match) continue;

    const agentId = match[1];
    if (!agentId) continue;

    const agentPath = `agents/${agentId}`;
    const { exitCode, output } = await runAgentBuild(cwd, agentPath);
    const lines = output.split("\n");
    const tail = lines.slice(-40);

    if (exitCode === 0 && output.includes("Built agent")) {
      evidence.push(`${agentId}: ok`);
    } else {
      allOk = false;
      evidence.push(`${agentId}: build failed`);
      evidence.push(...tail);
    }
  }

  return {
    validator: "agent-build",
    ok: allOk,
    message: allOk ? "agent-build: all agents built" : "agent-build: build failed",
    evidence: evidence.slice(0, 40),
  };
}
