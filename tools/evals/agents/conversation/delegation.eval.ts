/**
 * Conversation agent delegation eval — compound task routing.
 *
 * Verifies the conversation agent's FIRST `do_task` call is a compound intent
 * covering both services in the prompt. Retries after partial failure (e.g.
 * email config missing) are acceptable — the key signal is whether the agent
 * delegates the full task upfront rather than decomposing into sequential calls.
 *
 * Run with:
 *   deno task evals run --filter conversation/delegation
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentContextAdapter } from "../../lib/context.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

const execFileAsync = promisify(execFile);

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface DelegationCase extends BaseEvalCase {
  /** Keywords that must both appear (case-insensitive) in the single do_task intent. */
  expectedKeywords: [string, string];
}

interface TranscriptPart {
  type: string;
  toolCallId?: string;
  state?: string;
  input?: { intent?: string };
  output?: Record<string, unknown>;
}

interface TranscriptMessage {
  id: string;
  role: "user" | "assistant";
  parts: TranscriptPart[];
}

interface DelegationResult {
  chatId: string;
  doTaskCount: number;
  /** The intent string from the first do_task call, or null if none. */
  firstIntent: string | null;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: DelegationCase[] = [
  {
    id: "research-then-email",
    name: "delegation - research then email",
    input: "research the latest TypeScript features then email a summary to the team",
    expectedKeywords: ["research", "email"],
  },
  {
    id: "calendar-then-slack",
    name: "delegation - calendar then Slack",
    input: "check my calendar for today and post a summary to #standup on Slack",
    expectedKeywords: ["calendar", "slack"],
  },
  {
    id: "linear-then-email",
    name: "delegation - Linear then email",
    input: "look up my Linear issues in the current cycle and email me a summary",
    expectedKeywords: ["linear", "email"],
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Sends a prompt to the running daemon, fetches the chat transcript, and
 * extracts all `do_task` tool calls from assistant messages.
 */
async function sendPromptAndParseTranscript(input: string): Promise<DelegationResult> {
  const { stdout: promptOutput } = await execFileAsync("deno", ["task", "atlas", "prompt", input], {
    timeout: 600_000,
  });

  const lines = promptOutput.trim().split("\n");
  const lastLine = lines[lines.length - 1];
  if (!lastLine) {
    throw new Error("No output from CLI prompt command");
  }
  const summary = JSON.parse(lastLine) as { type: string; chatId: string };
  if (summary.type !== "cli-summary") {
    throw new Error(`Expected cli-summary, got ${summary.type}`);
  }
  const { chatId } = summary;

  const { stdout: chatOutput } = await execFileAsync("deno", ["task", "atlas", "chat", chatId], {
    timeout: 30_000,
  });

  const messages = chatOutput
    .trim()
    .split("\n")
    .filter((l) => l.trim().startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as TranscriptMessage;
      } catch {
        return null;
      }
    })
    .filter((m): m is TranscriptMessage => m !== null && "role" in m && "parts" in m);

  const doTaskParts = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts)
    .filter((p) => p.type === "tool-do_task");

  const firstPart = doTaskParts[0];
  const firstIntent = firstPart ? (firstPart.input?.intent ?? null) : null;

  return { chatId, doTaskCount: doTaskParts.length, firstIntent };
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval({
    name: `conversation/delegation/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (input) => await sendPromptAndParseTranscript(input),
      assert: (result) => {
        if (result.doTaskCount < 1) {
          throw new Error(`Expected at least 1 do_task call, got 0 (chatId: ${result.chatId})`);
        }
      },
      score: (result) => {
        const scores = [];
        const [kw1, kw2] = testCase.expectedKeywords;

        // Did the agent delegate at all?
        scores.push(
          createScore(
            "delegation/delegated",
            result.doTaskCount >= 1 ? 1 : 0,
            result.doTaskCount === 0 ? "no do_task calls" : `${result.doTaskCount} do_task call(s)`,
          ),
        );

        // Was the first do_task a compound intent covering both services?
        if (result.firstIntent !== null) {
          const intentLower = result.firstIntent.toLowerCase();
          const foundKeywords = [kw1, kw2].filter((kw) => intentLower.includes(kw.toLowerCase()));
          const missingKeywords = [kw1, kw2].filter(
            (kw) => !intentLower.includes(kw.toLowerCase()),
          );
          const allFound = foundKeywords.length === 2;

          scores.push(
            createScore(
              "delegation/compound-intent",
              allFound ? 1 : 0,
              allFound
                ? `first do_task covers both services: [${foundKeywords.join(", ")}]`
                : `first do_task missing: [${missingKeywords.join(", ")}]`,
            ),
          );
        } else {
          scores.push(createScore("delegation/compound-intent", 0, "no do_task calls to check"));
        }

        return scores;
      },
    },
  }),
);
