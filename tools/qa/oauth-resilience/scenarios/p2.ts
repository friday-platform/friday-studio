/**
 * Phase 2 QA scenarios — session-interactivity classification + AbortSignal in
 * waitForTerminalElicitation.
 *
 * Per qa.md these are plumbing-only changes; the only observable Ponderosa
 * added in #13 is the `computeSessionInteractive` helper, an `atlas.session.
 * interactive` OTel span attribute, and a debug log line. There is no
 * `/debug/last-session` endpoint, so each P2-01..P2-04 scenario runs the
 * corresponding `computeSessionInteractive` unit test in
 * `packages/workspace/src/runtime.test.ts` (which exercises the exact same
 * helper the daemon calls in `WorkspaceRuntime.executeAgent`). P2-05 runs
 * `wait.test.ts` as a unit-only check, per the qa.md plan.
 *
 * Spawning `deno task test` per scenario is consistent with the QA-plan
 * decision (P2-05) and avoids standing up a full LLM-capable daemon
 * + cron + chat communicator just to read back a boolean flag that already
 * has direct unit coverage.
 */

import { register } from "../run-core.ts";

/** Resolve worktree root by walking up from this file (`tools/qa/oauth-resilience/scenarios/p2.ts`). */
const WORKTREE_ROOT = new URL("../../../..", import.meta.url).pathname;

interface DenoTestResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Spawn `deno task test` against a single test file, optionally filtered to a
 * vitest test-name substring. Vitest's `-t` flag matches against the full
 * "describe > it" name path.
 */
async function runDenoTestFile(
  testPath: string,
  vitestNameFilter?: string,
): Promise<DenoTestResult> {
  const args = ["task", "test", testPath];
  if (vitestNameFilter) args.push("-t", vitestNameFilter);
  const cmd = new Deno.Command("deno", {
    args,
    cwd: WORKTREE_ROOT,
    stdout: "piped",
    stderr: "piped",
    stdin: "null",
  });
  const { code, stdout, stderr } = await cmd.output();
  return {
    ok: code === 0,
    stdout: new TextDecoder().decode(stdout),
    stderr: new TextDecoder().decode(stderr),
    code,
  };
}

function assertTestPassed(result: DenoTestResult, scenarioId: string): void {
  if (!result.ok) {
    throw new Error(
      `${scenarioId}: deno test exited ${result.code}\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );
  }
}

const RUNTIME_TEST_PATH = "packages/workspace/src/runtime.test.ts";
const WAIT_TEST_PATH = "packages/mcp-server/src/tools/elicitations/wait.test.ts";

register({
  id: "P2-01",
  description:
    "Direct chat session is interactive (sessionInteractive=true via computeSessionInteractive)",
  run: async () => {
    const result = await runDenoTestFile(
      RUNTIME_TEST_PATH,
      "direct-chat session is interactive regardless of provenance fallback",
    );
    assertTestPassed(result, "P2-01");
  },
});

register({
  id: "P2-02",
  description: "Schedule-triggered session is non-interactive (system-config provenance)",
  run: async () => {
    const result = await runDenoTestFile(
      RUNTIME_TEST_PATH,
      "schedule-triggered session is non-interactive (system-config provenance)",
    );
    assertTestPassed(result, "P2-02");
  },
});

register({
  id: "P2-03",
  description: "Slack-triggered session is interactive (user-authored provenance)",
  run: async () => {
    const result = await runDenoTestFile(
      RUNTIME_TEST_PATH,
      "Slack-triggered session is interactive (user-authored provenance)",
    );
    assertTestPassed(result, "P2-03");
  },
});

register({
  id: "P2-04",
  description: "HTTP webhook session is non-interactive (external provenance)",
  run: async () => {
    const result = await runDenoTestFile(
      RUNTIME_TEST_PATH,
      "HTTP webhook session is non-interactive (external provenance)",
    );
    assertTestPassed(result, "P2-04");
  },
});

register({
  id: "P2-05",
  description: "waitForTerminalElicitation accepts optional AbortSignal — unit-only (wait.test.ts)",
  run: async () => {
    const result = await runDenoTestFile(WAIT_TEST_PATH);
    assertTestPassed(result, "P2-05");
  },
});
