/**
 * Integration test: verifies that includePartialMessages + activity-based stall
 * detection allows long-running SDK sessions to complete without being killed.
 *
 * With includePartialMessages: true, the SDK streams token-level events during
 * LLM generation, keeping the activity tracker alive. The stall timeout (2 min
 * in test, 10 min in production) acts as a safety net for genuine process hangs.
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
import { type ActivityTracker, createKeepalive, withMessageTimeout } from "./agent.ts";
import { sandboxOptions } from "./sandbox.ts";

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ATLAS_CLAUDE_PATH = process.env.ATLAS_CLAUDE_PATH;
const GH_TOKEN = process.env.GH_TOKEN ?? "dummy";

const canRun = Boolean(ANTHROPIC_API_KEY && ATLAS_CLAUDE_PATH);

/** Use a shorter timeout than production (2 min vs 10 min) to catch regressions faster.
 * With includePartialMessages, stream_event tokens keep activity alive during LLM generation,
 * so even this shorter window is generous — it only triggers on actual process hangs. */
const TEST_TIMEOUT_MS = 120_000;

describe.skipIf(!canRun)("integration: stall detection with includePartialMessages", () => {
  it("completes a coding task without triggering stall timeout", async () => {
    const activity: ActivityTracker = { lastActivityMs: Date.now() };
    const messages: Array<{ type: string; subtype?: string }> = [];
    let streamEventCount = 0;

    const keepalive = createKeepalive(activity);

    // Strip CLAUDECODE env var to allow nested Claude Code execution (e.g. when running from Claude Code)
    const env: Record<string, string | undefined> = { ...process.env, ANTHROPIC_API_KEY, GH_TOKEN };
    delete env.CLAUDECODE;

    const sdkStream = query({
      prompt: [
        "Write a TypeScript implementation of a red-black tree with insert, delete, search,",
        "and in-order traversal. Put everything in a single file called rbtree.ts.",
      ].join("\n"),
      options: {
        pathToClaudeCodeExecutable: ATLAS_CLAUDE_PATH,
        cwd: process.env.TMPDIR ?? "/tmp",
        model: "claude-sonnet-4-6",
        tools: { type: "preset", preset: "claude_code" },
        permissionMode: "bypassPermissions",
        settingSources: [],
        maxTurns: 30,
        sandbox: sandboxOptions,
        includePartialMessages: true,
        env,
        stderr: (_data) => {
          activity.lastActivityMs = Date.now();
        },
        hooks: {
          PostToolUse: [{ hooks: [keepalive] }],
          SubagentStart: [{ hooks: [keepalive] }],
          SubagentStop: [{ hooks: [keepalive] }],
        },
        systemPrompt: { type: "preset", preset: "claude_code" },
      },
    });

    const timedStream = withMessageTimeout(
      sdkStream,
      TEST_TIMEOUT_MS,
      () =>
        new Error(
          `SDK stalled: no activity for ${TEST_TIMEOUT_MS / 1000}s (INTEGRATION TEST FAILED)`,
        ),
      activity,
    );

    let resultText = "";

    for await (const message of timedStream) {
      messages.push({
        type: message.type,
        subtype: "subtype" in message ? message.subtype : undefined,
      });

      // Count stream_event messages — these are the token-level deltas from includePartialMessages
      if (message.type === "stream_event") {
        streamEventCount++;
      }

      if (message.type === "result" && message.subtype === "success") {
        resultText = message.result;
      }
    }

    // Session completed successfully without stall timeout
    const resultMsg = messages.find((m) => m.type === "result");
    expect(resultMsg).toBeDefined();
    expect(resultMsg?.subtype).toBe("success");
    expect(resultText.length).toBeGreaterThan(0);

    // includePartialMessages must have produced stream_event messages — these are what
    // keep the activity tracker alive during LLM generation, preventing stall kills
    expect(
      streamEventCount,
      "stream_event messages must be present (includePartialMessages keepalive)",
    ).toBeGreaterThan(0);
  }, 300_000); // 5 minute timeout
});
