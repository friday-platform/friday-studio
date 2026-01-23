/**
 * Integration test: verifies the stall detection doesn't kill sessions during
 * long-running Task subagent execution.
 *
 * Prerequisites:
 *   ANTHROPIC_API_KEY - valid API key
 *   ATLAS_CLAUDE_PATH - path to claude-code CLI binary
 *   GH_TOKEN - GitHub PAT (can be a dummy value if not cloning repos)
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-... ATLAS_CLAUDE_PATH=$(which claude) GH_TOKEN=ghp_... \
 *     deno task test packages/bundled-agents/src/claude-code/agent.integration.test.ts
 *
 * This test takes 2-5 minutes. It's not meant for CI — it's a one-off QA check.
 */
import process from "node:process";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import {
  type ActivityTracker,
  EXTENDED_TIMEOUT_MS,
  MESSAGE_TIMEOUT_MS,
  withMessageTimeout,
} from "./agent.ts";
import { sandboxOptions } from "./sandbox.ts";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ATLAS_CLAUDE_PATH = process.env.ATLAS_CLAUDE_PATH;
const GH_TOKEN = process.env.GH_TOKEN ?? "dummy";

const canRun = Boolean(ANTHROPIC_API_KEY && ATLAS_CLAUDE_PATH);

describe.skipIf(!canRun)("integration: stall detection with real subagent", () => {
  it("survives a Task subagent execution without triggering stall timeout", async () => {
    const startTime = Date.now();
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const messages: Array<{ type: string; subtype?: string }> = [];

    const sdkStream = query({
      prompt: [
        "You MUST use the Task tool (subagent) to complete this work — do NOT do it inline.",
        "Task: Write a comprehensive TypeScript implementation of a red-black tree data structure.",
        "Include insert, delete, search, and in-order traversal. Add detailed comments.",
        "Also write at least 5 unit test cases using assert statements.",
        "Put everything in a single file called rbtree.ts.",
      ].join("\n"),
      options: {
        pathToClaudeCodeExecutable: ATLAS_CLAUDE_PATH,
        cwd: process.env.TMPDIR ?? "/tmp",
        model: "claude-sonnet-4-5",
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 30,
        sandbox: sandboxOptions,
        env: { ...process.env, ANTHROPIC_API_KEY, GH_TOKEN },
        stderr: (_data) => {
          activity.lastActivityMs = Date.now();
        },
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append:
            "You MUST use the Task tool for any substantial coding work. Do not implement directly.",
        },
      },
    });

    const timedStream = withMessageTimeout(
      sdkStream,
      MESSAGE_TIMEOUT_MS,
      EXTENDED_TIMEOUT_MS,
      () =>
        new Error(
          `SDK stalled: no message in ${MESSAGE_TIMEOUT_MS / 1000}s (INTEGRATION TEST FAILED)`,
        ),
      activity,
    );

    let resultText = "";
    let taskToolUsed = false;

    for await (const message of timedStream) {
      messages.push({
        type: message.type,
        subtype: "subtype" in message ? message.subtype : undefined,
      });

      if (message.type === "assistant") {
        for (const block of message.message.content) {
          if (block.type === "tool_use" && block.name === "Task") {
            taskToolUsed = true;
          }
        }
      }

      if (message.type === "result" && message.subtype === "success") {
        resultText = message.result;
      }
    }

    const elapsed = Date.now() - startTime;

    // Verify the session completed successfully
    const resultMsg = messages.find((m) => m.type === "result");
    expect(resultMsg).toBeDefined();
    expect(resultMsg?.subtype).toBe("success");
    expect(resultText.length).toBeGreaterThan(0);

    // The Task tool must have been invoked — otherwise we didn't test the subagent path
    expect(taskToolUsed).toBe(true);

    // Session must have exceeded the old 60s timeout to confirm the fix was exercised
    expect(elapsed).toBeGreaterThan(MESSAGE_TIMEOUT_MS);
  }, 300_000); // 5 minute timeout
});
