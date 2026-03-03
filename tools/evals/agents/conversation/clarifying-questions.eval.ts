/**
 * Conversation agent clarifying questions eval — resource awareness.
 *
 * Verifies that the conversation agent asks appropriate clarifying questions
 * about data storage when gathering workspace requirements. Use cases involving
 * tracking, logging, or accumulating data should prompt questions about table
 * resources or external refs. Pure notification/monitoring use cases should not.
 *
 * Run with:
 *   deno task evals run --filter conversation/clarifying-questions
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";

const execFileAsync = promisify(execFile);

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClarifyingCase extends BaseEvalCase {
  /** Whether the use case involves persistent data that should trigger storage questions. */
  needsStorage: boolean;
  /** Whether the user already named an external service as their storage mechanism. */
  hasExternalService: boolean;
  /** Context for the LLM judge about why storage is or isn't expected. */
  rationale: string;
}

interface TranscriptPart {
  type: string;
  text?: string;
}

interface TranscriptMessage {
  role: "user" | "assistant";
  parts: TranscriptPart[];
}

interface ClarifyingResult {
  chatId: string;
  /** The agent's clarifying questions text (all text parts from assistant messages before the planner call). */
  clarifyingText: string;
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

const cases: ClarifyingCase[] = [
  // --- Should ask about storage ---
  {
    id: "grocery-tracker",
    name: "should ask about storage - grocery list",
    input: "Help me track my weekly grocery list",
    needsStorage: true,
    hasExternalService: false,
    rationale:
      "A grocery list is persistent data that accumulates over time. The agent should ask where/how to store it — as a table resource in Friday or externally.",
  },
  {
    id: "standup-log",
    name: "should ask about storage - standup log",
    input: "Keep a log of my daily standup notes",
    needsStorage: true,
    hasExternalService: false,
    rationale:
      "A standup log is an accumulating record. The agent should ask about storing it as a table resource or in an external service like Notion.",
  },
  {
    id: "client-database",
    name: "should ask about storage - client contacts",
    input: "Build a contact database for my clients",
    needsStorage: true,
    hasExternalService: false,
    rationale:
      "A contact database is structured persistent data. The agent should ask about storing it as a table resource in Friday or syncing with an external service.",
  },
  {
    id: "portfolio-tracker",
    name: "should ask about storage - stock portfolio",
    input: "Track my stock portfolio and alert me on big moves",
    needsStorage: true,
    hasExternalService: false,
    rationale:
      "Portfolio tracking requires persisting the list of holdings. The agent should ask about data storage even though alerts are the primary output.",
  },

  // --- Should NOT ask about storage ---
  {
    id: "weather-summary",
    name: "should not ask about storage - weather email",
    input: "Send me a daily weather summary via email",
    needsStorage: false,
    hasExternalService: false,
    rationale:
      "This is a pure fetch-and-notify pipeline. No data accumulates between runs. Storage questions would be unnecessary.",
  },
  {
    id: "price-alert",
    name: "should not ask about storage - price alert",
    input: "Alert me when Bitcoin drops below $50k",
    needsStorage: false,
    hasExternalService: false,
    rationale:
      "This is a threshold monitor. It checks a condition and notifies — no persistent state needed between runs.",
  },
  {
    id: "email-digest",
    name: "should not ask about storage - email digest",
    input: "Summarize my unread emails every morning and post to Slack",
    needsStorage: false,
    hasExternalService: false,
    rationale:
      "This is a pipeline that reads from one service and writes to another. No data needs to persist between runs.",
  },

  // --- External ref awareness ---
  {
    id: "sheets-budget",
    name: "should suggest external ref - Google Sheets budget",
    input: "Help me track my monthly budget — I already use Google Sheets for this",
    needsStorage: true,
    hasExternalService: true,
    rationale:
      "The user explicitly mentioned Google Sheets. The agent should acknowledge this as the storage option (external ref) and confirm whether to connect to it or migrate to Friday's built-in storage.",
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Sends prompt to the daemon and extracts the agent's clarifying questions
 * text — everything the assistant says before calling workspace-planner.
 */
async function sendPromptAndExtractClarifications(input: string): Promise<ClarifyingResult> {
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

  // Collect all text from assistant messages. The clarifying questions are the
  // text content the agent produces before calling workspace-planner.
  const clarifyingText = messages
    .filter((m) => m.role === "assistant")
    .flatMap((m) => m.parts)
    .filter((p): p is typeof p & { text: string } => p.type === "text" && !!p.text)
    .map((p) => p.text)
    .join("\n");

  return { chatId, clarifyingText };
}

// ---------------------------------------------------------------------------
// Criteria builders
// ---------------------------------------------------------------------------

function buildCriteria(testCase: ClarifyingCase): string {
  // User already named an external service — agent should acknowledge it as storage
  if (testCase.hasExternalService) {
    return `The user asked: "${testCase.input}"

Context: ${testCase.rationale}

The user already named an external service they use for this data. Evaluate whether
the agent acknowledged that service as the storage mechanism.

Score 1.0 if the agent acknowledges the named service as the storage option and
confirms the user wants to connect to it (or offers Friday's built-in storage as
an alternative).
Score 0.7 if the agent acknowledges the service but doesn't explicitly confirm it
as the storage mechanism or offer an alternative.
Score 0.3 if the agent ignores the named service and only asks about other storage.
Score 0.0 if the agent doesn't address storage at all.`;
  }

  // Use case involves persistent data — agent should ask about storage
  if (testCase.needsStorage) {
    return `The user asked: "${testCase.input}"

Context: ${testCase.rationale}

Evaluate the agent's clarifying questions. Score based on:
- Did the agent ask about data storage or persistent state? (e.g., where to store data, whether to use a table resource in Friday, or sync with an external service)
- Did the agent proactively suggest storing data in Friday as an option, rather than only mentioning external services?
- Were the storage-related questions relevant to the use case?

Score 1.0 if the agent clearly asks about data storage and suggests Friday (the platform's built-in storage) as an option.
Score 0.7 if the agent asks about data storage but doesn't specifically mention Friday/internal/built-in storage.
Score 0.3 if the agent only asks about external services (email, Slack) without addressing data storage.
Score 0.0 if the agent doesn't ask about data or storage at all.`;
  }

  // Pure notification/monitoring — storage questions would be unnecessary
  return `The user asked: "${testCase.input}"

Context: ${testCase.rationale}

Evaluate the agent's clarifying questions. Score based on:
- Did the agent appropriately focus on trigger, frequency, output, and services?
- Did the agent avoid unnecessary questions about data storage or persistent state?
- A brief mention of storage is acceptable but it should not be a primary focus.

Score 1.0 if the agent asks relevant questions without overemphasizing storage.
Score 0.7 if the agent mentions storage briefly but keeps focus on the right things.
Score 0.3 if the agent spends significant time on storage questions for a use case that doesn't need it.
Score 0.0 if the agent's questions are entirely about storage when none is needed.`;
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval({
    name: `conversation/clarifying-questions/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async (input) => await sendPromptAndExtractClarifications(input),
      assert: (result) => {
        if (!result.clarifyingText.trim()) {
          throw new Error(
            `Agent produced no clarifying text — may have skipped questions entirely (chatId: ${result.chatId})`,
          );
        }
      },
      score: async (result) => {
        const judge = await llmJudge(result.clarifyingText, buildCriteria(testCase));
        const name = testCase.hasExternalService
          ? "clarification/acknowledges-external-ref"
          : testCase.needsStorage
            ? "clarification/asks-about-storage"
            : "clarification/appropriate-focus";
        return [{ ...judge, name }];
      },
      metadata: {
        needsStorage: testCase.needsStorage,
        hasExternalService: testCase.hasExternalService,
        rationale: testCase.rationale,
      },
    },
  }),
);
