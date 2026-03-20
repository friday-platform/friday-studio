/**
 * Slack signal persistence eval — verifies the full platform data flow.
 *
 * Seeds a fake Slack credential, then triggers a Slack signal through the
 * PLATFORM endpoint (/signals/slack) which runs the complete path:
 * Slack token lookup → chat init → payload construction → workspace signal
 * → conversation agent → ChatStorage persistence.
 *
 * Then polls ChatStorage to verify the agent persisted its response under
 * the correct key.
 *
 * This catches the streamId mismatch regression (PR #1872): if platform.ts
 * sends `sessionId` instead of `streamId`, the runtime resolves a random UUID
 * as streamId and the agent persists to the wrong ChatStorage key.
 *
 * Requires a running daemon: `deno task atlas daemon start --detached`
 *
 * Run with:
 *   deno task evals run --filter conversation/slack-persistence
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ChatStorage } from "@atlas/core/chat/storage";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { generateSlackChatId } from "../../../../apps/atlasd/src/platform-utils.ts";
import { AgentContextAdapter } from "../../lib/context.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SlackPersistenceCase extends BaseEvalCase {
  expectResponse: boolean;
}

interface SlackPersistenceResult {
  chatId: string;
  signalStatus: number;
  assistantMessageFound: boolean;
  responseText: string;
  pollDurationMs: number;
  skipped?: string;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: SlackPersistenceCase[] = [
  {
    id: "basic-greeting",
    name: "slack signal — basic greeting persists response via platform endpoint",
    input: "Hey, who are you?",
    expectResponse: true,
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DAEMON_URL = "http://localhost:8080";
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 60_000;

/** Fake credential ID used for eval — cleaned up after test. */
const EVAL_CREDENTIAL_ID = "eval-slack-credential";
const EVAL_USER_ID = "dev";

/**
 * Seed a fake Slack credential into the Link filesystem storage.
 * The daemon's getSlackTokenByTeamId reads from Link, which uses
 * FileSystemStorageAdapter at ~/.atlas/credentials/<userId>/<id>.json.
 */
async function seedFakeSlackCredential(): Promise<void> {
  const credDir = join(getAtlasHome(), "credentials", EVAL_USER_ID);
  await mkdir(credDir, { recursive: true });

  const credential = {
    type: "oauth",
    provider: "slack",
    userIdentifier: "eval-test",
    label: "Eval Slack (fake)",
    secret: { access_token: "xoxb-eval-fake-token", token_type: "bot", externalId: "T-eval-slack" },
    id: EVAL_CREDENTIAL_ID,
    metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
  };

  await writeFile(join(credDir, `${EVAL_CREDENTIAL_ID}.json`), JSON.stringify(credential, null, 2));
}

/** Remove the fake credential after the eval. */
async function cleanupFakeSlackCredential(): Promise<void> {
  const filePath = join(getAtlasHome(), "credentials", EVAL_USER_ID, `${EVAL_CREDENTIAL_ID}.json`);
  await rm(filePath, { force: true });
}

/**
 * Check that the daemon and Link service are reachable.
 * Returns a skip reason string if preconditions aren't met, null otherwise.
 */
async function checkPreconditions(): Promise<string | null> {
  try {
    const daemonRes = await fetch(`${DAEMON_URL}/health`, { signal: AbortSignal.timeout(2_000) });
    if (!daemonRes.ok) return "Daemon not healthy";
  } catch {
    return "Daemon not reachable at localhost:8080 — start with: deno task dev";
  }

  try {
    const linkRes = await fetch("http://localhost:3100/health", {
      signal: AbortSignal.timeout(2_000),
    });
    if (!linkRes.ok) return "Link service not healthy";
  } catch {
    return "Link service not reachable at localhost:3100 — start with: deno task dev";
  }

  return null;
}

/**
 * Poll ChatStorage via HTTP until an assistant message appears or timeout.
 */
async function pollForAssistantMessage(
  chatId: string,
  timeoutMs: number,
): Promise<{ found: boolean; text: string; durationMs: number }> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${DAEMON_URL}/api/chat/${chatId}`);
    if (res.ok) {
      const data = (await res.json()) as {
        messages?: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
      };

      const messages = data.messages ?? [];
      const assistantMessages = messages.filter((m) => m.role === "assistant");

      if (assistantMessages.length > 0) {
        const text = assistantMessages
          .flatMap((m) => m.parts)
          .filter((p): p is typeof p & { text: string } => p.type === "text" && !!p.text)
          .map((p) => p.text)
          .join("\n");

        return { found: true, text, durationMs: Date.now() - start };
      }
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { found: false, text: "", durationMs: Date.now() - start };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Tests the full Slack signal → ChatStorage persistence path via the
 * platform endpoint (/signals/slack).
 *
 * 1. Seeds a fake Slack credential so getSlackTokenByTeamId succeeds
 * 2. POSTs to /signals/slack (the real platform endpoint)
 * 3. platform.ts constructs the signal payload (including streamId or not)
 * 4. Triggers workspace signal → conversation agent → LLM → ChatStorage
 * 5. Polls ChatStorage for the assistant response
 *
 * The regression: platform.ts sent `sessionId: chatId` instead of `streamId: chatId`.
 * The runtime reads `signal.data?.streamId` — if missing, it falls back to a random UUID.
 * The agent persists to the wrong key and the read-back finds nothing.
 */
async function triggerSlackSignalAndVerify(input: string): Promise<SlackPersistenceResult> {
  const skipReason = await checkPreconditions();
  if (skipReason) {
    return {
      chatId: "",
      signalStatus: 0,
      assistantMessageFound: false,
      responseText: "",
      pollDurationMs: 0,
      skipped: skipReason,
    };
  }

  const teamId = "T-eval-slack";
  const channelId = "C-eval-slack";
  const userId = "U-eval-slack";
  const chatId = await generateSlackChatId(teamId, channelId, userId);

  // Clean up leftover chat from previous runs
  await ChatStorage.deleteChat(chatId).catch(() => {});

  // Seed fake Slack credential for token lookup
  await seedFakeSlackCredential();

  try {
    // Hit the PLATFORM endpoint — NOT the workspace signal endpoint.
    // platform.ts constructs the signal payload (the thing we're testing).
    const signalRes = await fetch(`${DAEMON_URL}/signals/slack`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: input,
        _slack: {
          channel_id: channelId,
          team_id: teamId,
          channel_type: "im",
          user_id: userId,
          timestamp: String(Date.now() / 1000),
        },
      }),
    });

    if (signalRes.status !== 202) {
      const body = await signalRes.text();
      return {
        chatId,
        signalStatus: signalRes.status,
        assistantMessageFound: false,
        responseText: `Signal failed: ${body}`,
        pollDurationMs: 0,
      };
    }

    // Platform endpoint returns 202 immediately. Poll ChatStorage for the result.
    const poll = await pollForAssistantMessage(chatId, POLL_TIMEOUT_MS);

    return {
      chatId,
      signalStatus: signalRes.status,
      assistantMessageFound: poll.found,
      responseText: poll.text,
      pollDurationMs: poll.durationMs,
    };
  } finally {
    // Cleanup: remove fake credential + eval chat
    await cleanupFakeSlackCredential();
    await ChatStorage.deleteChat(chatId).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval({
    name: `conversation/slack-persistence/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (input) => await triggerSlackSignalAndVerify(input),
      assert: (result) => {
        if (result.skipped) return; // preconditions not met — skip silently
        if (result.signalStatus !== 202) {
          throw new Error(
            `Platform endpoint returned ${result.signalStatus}. Expected 202. ` +
              `${result.responseText}`,
          );
        }
        if (testCase.expectResponse && !result.assistantMessageFound) {
          throw new Error(
            `No assistant message found in ChatStorage for chatId=${result.chatId} ` +
              `after polling for ${result.pollDurationMs}ms. ` +
              `This means streamId was not correctly passed through platform.ts → runtime ` +
              `→ conversation agent — persistence went to a different key. ` +
              `(Regression: PR #1872 changed streamId resolution)`,
          );
        }
        if (testCase.expectResponse && !result.responseText.trim()) {
          throw new Error(
            `Assistant message exists but has no text content (chatId=${result.chatId})`,
          );
        }
      },
      score: (result) => {
        if (result.skipped) {
          return [createScore("persistence/skipped", 1, `Skipped: ${result.skipped}`)];
        }
        return [
          createScore(
            "persistence/signal-accepted",
            result.signalStatus === 202 ? 1 : 0,
            `Platform endpoint returned ${result.signalStatus}`,
          ),
          createScore(
            "persistence/response-found",
            result.assistantMessageFound ? 1 : 0,
            result.assistantMessageFound
              ? `Assistant response found (${result.responseText.length} chars, ${result.pollDurationMs}ms)`
              : `No assistant response in ChatStorage after ${result.pollDurationMs}ms — streamId mismatch?`,
          ),
        ];
      },
      metadata: {
        scenario:
          "Platform endpoint /signals/slack → payload construction → runtime → ChatStorage persistence",
        regressionRef: "PR #1872 changed streamId resolution, breaking Slack persistence",
      },
    },
  }),
);
