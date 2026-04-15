/**
 * Unified Web Agent Evals
 *
 * Consolidated eval suite covering pure search, pure browser, mixed-mode,
 * and decision-quality scenarios against the unified `web` agent.
 *
 * Ported from:
 * - `tools/evals/agents/browser/browser.eval.ts` (6 browser cases)
 * - `tools/evals/agents/research/research.eval.ts` (5 research cases)
 *
 * New cases:
 * - Mixed-mode (2): cross-tool scenarios (search -> browse, fetch -> browse)
 * - Decision-quality (2): validates tool selection efficiency
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentPayload } from "@atlas/agent-sdk";
import { type WebAgentResult, webAgent } from "@atlas/bundled-agents";
import type { TraceEntry } from "@atlas/llm";
import { z } from "zod";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

const execFileAsync = promisify(execFile);

/** Schema for the browse tool's input shape (command string). */
const BrowseToolInput = z.object({ command: z.string() });

await loadCredentials();

// Pre-flight: verify agent-browser CLI is available.
// Fails fast instead of running doomed browser evals.
try {
  await execFileAsync("agent-browser", ["--version"], { timeout: 10_000 });
} catch (error) {
  const msg = error instanceof Error ? error.message : String(error);
  throw new Error(
    `agent-browser pre-flight failed -- browser evals cannot run.\n${msg}\n` +
      `Fix: npm i -g agent-browser && agent-browser install`,
  );
}

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WebResult = AgentPayload<WebAgentResult>;

interface BrowserCase extends BaseEvalCase {
  category: "browser";
  /** Description for LLM judge to evaluate the agent's output. */
  expectedOutput: string;
  /** Minimum number of browse tool calls expected for step-efficiency scoring. */
  minSteps: number;
}

interface SearchCase extends BaseEvalCase {
  category: "search";
  /** Criteria for LLM judge relevancy evaluation. */
  relevancy: string;
  /** Expected entities in the output. */
  entities: string[];
}

interface FailureCase extends BaseEvalCase {
  category: "failure";
  /** Criteria for LLM judge. */
  criteria: string;
  /** Whether the agent should fail (return error). */
  shouldFail: boolean;
}

interface MixedModeCase extends BaseEvalCase {
  category: "mixed";
  /** Description for LLM judge. */
  expectedOutput: string;
  /** Expected tool usage pattern (tool names in expected order). */
  expectedTools: string[];
}

interface DecisionQualityCase extends BaseEvalCase {
  category: "decision";
  /** Description for LLM judge. */
  expectedOutput: string;
  /** Tool that SHOULD be used. */
  expectedTool: string;
  /** Tool that should NOT be used. */
  avoidTool: string;
}

// ---------------------------------------------------------------------------
// Trace inspection helpers
// ---------------------------------------------------------------------------

/** Extracts all tool calls across all trace entries. */
function extractToolCalls(traces: TraceEntry[]): Array<{ name: string; input: unknown }> {
  return traces.flatMap((t) => t.output.toolCalls);
}

/** Extracts all browse tool commands from traces. */
function extractBrowserCommands(traces: TraceEntry[]): string[] {
  return extractToolCalls(traces)
    .filter((tc) => tc.name === "browse")
    .map((tc) => {
      const parsed = BrowseToolInput.safeParse(tc.input);
      return parsed.success ? parsed.data.command : "";
    })
    .filter(Boolean);
}

/**
 * Checks if the agent took a snapshot before its first interaction on each
 * new page. "Interaction" means a click, fill, or type command. A snapshot
 * command contains "snapshot".
 */
function snapshotBeforeInteract(traces: TraceEntry[]): boolean {
  const commands = extractBrowserCommands(traces);
  if (commands.length === 0) return false;

  const interactionPatterns = [/^click\b/, /^fill\b/, /^type\b/, /^select\b/];
  let hasSnapshot = false;

  for (const cmd of commands) {
    const isSnapshot = cmd.includes("snapshot");
    const isNavigation = cmd.startsWith("open ");

    if (isSnapshot) {
      hasSnapshot = true;
      continue;
    }

    if (isNavigation) {
      // New page -- need a new snapshot before next interaction
      hasSnapshot = false;
      continue;
    }

    const isInteraction = interactionPatterns.some((p) => p.test(cmd));
    if (isInteraction && !hasSnapshot) {
      return false;
    }
  }

  return true;
}

/**
 * Calculates step efficiency: ratio of minimum expected steps to actual steps.
 * Clamped to [0, 1]. A perfect score means the agent used exactly the minimum
 * number of steps.
 */
function stepEfficiency(traces: TraceEntry[], minSteps: number): number {
  const commands = extractBrowserCommands(traces);
  const actualSteps = commands.length;
  if (actualSteps === 0) return 0;
  return Math.min(minSteps / actualSteps, 1);
}

/**
 * Stringifies trace message content for error detection.
 * AI SDK tool results have content as an array of objects, not a plain string.
 */
function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return JSON.stringify(content);
  if (content != null && typeof content === "object") return JSON.stringify(content);
  return String(content);
}

/**
 * Checks if the agent recovered from errors by re-snapshotting.
 *
 * Walks consecutive trace pairs. For each pair, checks if the NEW tool results
 * (from trace[i]'s tool calls, appearing in trace[i+1]'s input) contain errors.
 * If so, checks if trace[i+1]'s output includes a snapshot command -- indicating
 * recovery.
 *
 * Each trace includes the full conversation history, so we slice to get only
 * the new messages -- otherwise every past error would be re-counted in every
 * subsequent trace, causing false "failed to recover" results.
 */
function errorRecovery(traces: TraceEntry[]): { score: number; reason: string } {
  let totalErrors = 0;
  let recoveredErrors = 0;

  for (let i = 0; i < traces.length - 1; i++) {
    const current = traces[i];
    const next = traces[i + 1];
    if (!current || !next) continue;
    // New messages = everything in next trace's input beyond what current had.
    const newMessages = next.input.slice(current.input.length);
    const hasNewError = newMessages.some(
      (msg) => msg.role === "tool" && stringifyContent(msg.content).includes("Error:"),
    );
    if (!hasNewError) continue;

    totalErrors++;
    const recoveredWithSnapshot = next.output.toolCalls.some((tc) => {
      if (tc.name !== "browse") return false;
      const parsed = BrowseToolInput.safeParse(tc.input);
      return parsed.success && parsed.data.command.includes("snapshot");
    });
    if (recoveredWithSnapshot) {
      recoveredErrors++;
    }
  }

  // No errors = perfect score (nothing to recover from)
  if (totalErrors === 0) return { score: 1, reason: "No errors encountered" };
  const score = recoveredErrors / totalErrors;
  return { score, reason: `Recovered ${recoveredErrors}/${totalErrors} errors with re-snapshot` };
}

/**
 * Checks which tool names the agent used across all traces.
 * Returns a deduplicated list of tool names in call order.
 */
function getToolsUsed(traces: TraceEntry[]): string[] {
  const toolCalls = extractToolCalls(traces);
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const tc of toolCalls) {
    if (!seen.has(tc.name)) {
      seen.add(tc.name);
      ordered.push(tc.name);
    }
  }
  return ordered;
}

// ---------------------------------------------------------------------------
// Assert helpers
// ---------------------------------------------------------------------------

/**
 * Asserts the agent actually interacted with the browser.
 * Throws if the agent returned an error or made zero successful browse calls.
 */
function assertBrowserFunctional(result: WebResult, traces: TraceEntry[]): void {
  if (!result.ok) {
    throw new Error(`Agent returned error: ${result.error.reason}`);
  }

  const commands = extractBrowserCommands(traces);
  if (commands.length === 0) {
    throw new Error("Agent made zero browse commands -- browser may not be functional");
  }

  // Check if ALL browse tool results were errors (total infrastructure failure).
  const browseCalls = extractToolCalls(traces).filter((tc) => tc.name === "browse");
  const lastTrace = traces[traces.length - 1];
  const toolResults = lastTrace
    ? lastTrace.input
        .filter((msg) => msg.role === "tool")
        .map((msg) => stringifyContent(msg.content))
    : [];
  const errorResults = toolResults.filter((r) => r.includes("Error:"));

  if (browseCalls.length > 0 && errorResults.length >= browseCalls.length) {
    throw new Error(
      `All ${browseCalls.length} browse commands returned errors -- browser infrastructure failure`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

/** Builds scoring dimensions for a browser eval case. */
async function buildBrowserScores(
  result: WebResult,
  traces: TraceEntry[],
  testCase: BrowserCase,
): Promise<ReturnType<typeof createScore>[]> {
  const scores: ReturnType<typeof createScore>[] = [];

  // task-complete: LLM judge on agent output
  const output = result.ok ? result.data.response : `Error: ${result.error.reason}`;
  const judge = await llmJudge(output, testCase.expectedOutput);
  scores.push(createScore("task-complete", judge.value, judge.reason));

  // snapshot-before-interact
  const snapshotOk = snapshotBeforeInteract(traces);
  scores.push(
    createScore(
      "snapshot-before-interact",
      snapshotOk ? 1 : 0,
      snapshotOk
        ? "Snapshot taken before first interaction"
        : "Missing snapshot before interaction",
    ),
  );

  // step-efficiency
  const efficiency = stepEfficiency(traces, testCase.minSteps);
  scores.push(
    createScore(
      "step-efficiency",
      efficiency,
      `min=${testCase.minSteps}, actual=${extractBrowserCommands(traces).length}`,
    ),
  );

  // error-recovery
  const recovery = errorRecovery(traces);
  scores.push(createScore("error-recovery", recovery.score, recovery.reason));

  return scores;
}

/**
 * Scores tool selection: checks whether the agent used the expected tool
 * and avoided the tool it shouldn't need.
 */
function scoreToolSelection(
  traces: TraceEntry[],
  expectedTool: string,
  avoidTool: string,
): ReturnType<typeof createScore> {
  const toolCalls = extractToolCalls(traces);
  const usedExpected = toolCalls.some((tc) => tc.name === expectedTool);
  const usedAvoided = toolCalls.some((tc) => tc.name === avoidTool);

  if (usedExpected && !usedAvoided) {
    return createScore("tool-selection", 1, `Used ${expectedTool}, avoided ${avoidTool}`);
  }
  if (usedExpected && usedAvoided) {
    return createScore(
      "tool-selection",
      0.5,
      `Used ${expectedTool} but also used unnecessary ${avoidTool}`,
    );
  }
  return createScore("tool-selection", 0, `Did not use expected tool ${expectedTool}`);
}

// ---------------------------------------------------------------------------
// Browser cases (ported from browser.eval.ts, dynamic pages only)
// ---------------------------------------------------------------------------

const browserCases: BrowserCase[] = [
  {
    id: "hackernews/read-front-page",
    name: "hacker news - read dynamic list page",
    input: "Go to Hacker News and tell me the title and URL of the current #1 story",
    category: "browser",
    expectedOutput:
      "The agent navigated to Hacker News (news.ycombinator.com), read the front page, and reported the title and URL of the #1 story. The output should contain a specific story title (not generic placeholder text) and a valid external URL (not news.ycombinator.com itself). The content is dynamic so any real title and URL is acceptable -- do not penalize for unfamiliar titles.",
    minSteps: 3,
  },
  {
    id: "craigslist/search",
    name: "craigslist - search form interaction",
    input:
      "Go to craigslist.org and search for 'standing desk', then tell me the title and price of the first result",
    category: "browser",
    expectedOutput:
      "The agent navigated to craigslist.org, performed a search for 'standing desk', and reported the title and price of the first search result. The output should contain a specific listing title and a dollar amount.",
    minSteps: 5,
  },
];

// ---------------------------------------------------------------------------
// Search cases (ported from research.eval.ts + coverage extensions)
// ---------------------------------------------------------------------------

const searchCases: SearchCase[] = [
  {
    id: "wroclaw-local-news",
    name: "search - Wroclaw local news",
    input:
      "Find recent news from Wroclaw, Poland from the last 23 hours. Look for local news, events, developments, and stories specifically related to Wroclaw city. Include headlines, brief summaries, and source links.",
    category: "search",
    relevancy: `The research should:
1. Focus specifically on Wroclaw, Poland
2. Include recent news (within last 23 hours timeframe)
3. Cover local news, events, and developments
4. Provide headlines and brief summaries
5. Include source links/citations`,
    entities: ["Wroclaw"],
  },
  {
    id: "gravel-bikes-tire-clearance",
    name: "search - gravel bikes tire clearance",
    input:
      "What are new options for gravel bikes which fit larger than 2-inch tires? Prefer titanium frames, but open to carbon as well.",
    category: "search",
    relevancy: `The research should:
1. Provide a list of specific bike makes/models
2. Explicitly mention wheel size, tire clearance (>2 inches)
3. Explicitly mention frame material (titanium or carbon)
4. Include citations with links`,
    entities: ["tire", "titanium", "carbon"],
  },
  {
    id: "meeting-contacts-portfolio",
    name: "search - meeting contacts portfolio",
    input: `Research the people I'm meeting with today and their companies.
'Today's Meetings (September 18, 2025):
  "meetings": [
    {
      "title": "Meeting with Parker Conrad @ Rippling",
      "startTime": "2025-09-18T10:00:00 PDT",
      "endTime": "2025-09-18T11:00:00 PDT",
      "duration": "1 hour",
      "isPortfolioCompany": true,
      "portfolioCompany": "Rippling",
      "contactPerson": "Parker Conrad"
    },
    {
      "title": "Meeting with Amjad Masad @ Replit",
      "startTime": "2025-09-18T12:15:00 PDT",
      "endTime": "2025-09-18T13:15:00 PDT",
      "duration": "1 hour",
      "isPortfolioCompany": true,
      "portfolioCompany": "Replit",
      "contactPerson": "Amjad Masad"
    },
    {
      "title": "Meeting with Feross Aboukhadijeh @ Socket",
      "startTime": "2025-09-18T14:15:00 PDT",
      "endTime": "2025-09-18T15:30:00 PDT",
      "duration": "1 hour 15 minutes",
      "isPortfolioCompany": true,
      "portfolioCompany": "Socket",
      "contactPerson": "Feross Aboukhadijeh"
    }
  ]
'`,
    category: "search",
    relevancy: `The research should:
1. Research Parker Conrad, Amjad Masad, and Feross Aboukhadijeh
2. Include background and company info for each person
3. Include citations for facts`,
    entities: [
      "Parker Conrad",
      "Amjad Masad",
      "Feross Aboukhadijeh",
      "Rippling",
      "Replit",
      "Socket",
    ],
  },
  {
    id: "technical-lookup-zod-v4",
    name: "search - technical API lookup (Zod v4 breaking changes)",
    input:
      "What are the breaking changes in Zod v4 compared to Zod v3? Focus on API-level changes a TypeScript developer would need to adapt their code for.",
    category: "search",
    relevancy: `The research should:
1. Identify that Zod v4 was released with breaking API changes
2. List specific API-level differences from v3 (e.g. z.record signature, error customization, string format validators)
3. Reference the official Zod documentation or changelog
4. Include citations with links`,
    entities: ["Zod", "v4", "v3"],
  },
  {
    id: "entity-disambiguation-mercury",
    name: "search - entity disambiguation (Mercury)",
    input:
      "Tell me about Mercury the fintech banking company used by startups. I'm not asking about the planet, the element, or the rock band.",
    category: "search",
    relevancy: `The research should:
1. Correctly identify Mercury as the banking/fintech company (mercury.com) for startups and businesses
2. Not confuse it with the planet, chemical element, or Queen's band Mercury
3. Cover what the company does (banking services, target customers)
4. Include citations with links to mercury.com or reputable sources`,
    entities: ["Mercury", "banking", "startup"],
  },
  {
    id: "obscure-hallucination-bait",
    name: "search - obscure lookup resistant to hallucination",
    input:
      "Who wrote the paper 'Attention Is All You Need' and in what year was it published? Also list the institutional affiliations of the authors at the time of publication.",
    category: "search",
    relevancy: `The research should:
1. Identify the paper was published in 2017
2. Name the authors (Vaswani, Shazeer, Parmar, Uszkoreit, Jones, Gomez, Kaiser, Polosukhin) or at least several of them
3. Mention Google Brain and/or Google Research and/or University of Toronto as institutional affiliations
4. Include a citation (arXiv link or Google Scholar link)`,
    entities: ["Attention Is All You Need", "2017", "Google"],
  },
];

// ---------------------------------------------------------------------------
// Failure cases (2 ported from research.eval.ts)
// ---------------------------------------------------------------------------

const failureCases: FailureCase[] = [
  {
    id: "false-premise-ceo",
    name: "failure - false premise CEO",
    input: "When was Tim Cook appointed the new CEO of OpenAI?",
    category: "failure",
    criteria: `The agent should determine that Tim Cook is *not* the CEO of OpenAI. It should correct the false premise and provide accurate information about OpenAI's actual leadership (Sam Altman).`,
    shouldFail: false,
  },
  {
    id: "no-calendar-access",
    name: "failure - no calendar access",
    input: "Who are the people I'm meeting with today and what are their companies?",
    category: "failure",
    criteria: `The agent should recognize it cannot complete this task and explain that it doesn't have access to calendar information or knowledge of who the user is meeting with.`,
    shouldFail: true,
  },
];

// ---------------------------------------------------------------------------
// Mixed-mode cases (2 new)
// ---------------------------------------------------------------------------

const mixedModeCases: MixedModeCase[] = [
  {
    id: "search-then-browse",
    name: "mixed - search for product then interact with site",
    input:
      "Search for the Wikipedia page about 'Rust (programming language)', then navigate to it and tell me the name of its original designer and the year it first appeared.",
    category: "mixed",
    expectedOutput:
      "The agent searched for the Rust programming language Wikipedia page, found the URL, then browsed to it and extracted that Graydon Hoare is the original designer and Rust first appeared in 2015. The response should contain both the designer name and the year.",
    expectedTools: ["search", "browse"],
  },
  {
    id: "fetch-then-browse-escalation",
    name: "mixed - fetch static page then browse dynamic page",
    input:
      "First, read the content at https://httpbin.org/html (a simple static page). Then go to Hacker News (news.ycombinator.com) and tell me the title of the #1 story. Report both: the heading from httpbin and the HN story title.",
    category: "mixed",
    expectedOutput:
      "The agent fetched the httpbin.org/html page and extracted the heading (Herman Melville - Moby Dick). Then it browsed Hacker News and reported the #1 story title. The response should contain both the httpbin heading and a specific HN story title.",
    expectedTools: ["fetch", "browse"],
  },
];

// ---------------------------------------------------------------------------
// Decision-quality cases (2 new)
// ---------------------------------------------------------------------------

const decisionQualityCases: DecisionQualityCase[] = [
  {
    id: "static-url-uses-fetch",
    name: "decision - static URL should use fetch not browse",
    input: "Read the content at https://httpbin.org/html and tell me what the main heading says.",
    category: "decision",
    expectedOutput:
      "The agent read the httpbin.org/html page and reported the heading 'Herman Melville - Moby Dick'. It should have used fetch (HTTP GET) rather than launching a full browser session, since this is a simple static HTML page.",
    expectedTool: "fetch",
    avoidTool: "browse",
  },
];

// ---------------------------------------------------------------------------
// Eval registrations: Browser cases
// ---------------------------------------------------------------------------

const browserEvals: EvalRegistration[] = browserCases.map((c) =>
  defineEval({
    name: `web/browser/${c.id}`,
    adapter,
    config: {
      input: c.input,
      run: (input, context) => webAgent.execute(input, context),
      assert: (result, traces) => assertBrowserFunctional(result, traces),
      score: (result, traces) => buildBrowserScores(result, traces, c),
      metadata: { case: c.id, category: "browser", minSteps: c.minSteps },
    },
  }),
);

// ---------------------------------------------------------------------------
// Eval registrations: Search cases
// ---------------------------------------------------------------------------

const searchEvals: EvalRegistration[] = searchCases.map((testCase) =>
  defineEval({
    name: `web/search/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: (input, context) => webAgent.execute(input, context),
      assert: (result) => {
        if (!result.ok) {
          throw new Error(`Agent returned error: ${result.error.reason}`);
        }
      },
      score: async (result) => {
        const output = result.ok ? result.data.response : `Error: ${result.error.reason}`;
        const judge = await llmJudge(output, testCase.relevancy);

        // synthesis-quality: LLM judge on research quality specifically
        const synthesisJudge = await llmJudge(
          output,
          `Evaluate the synthesis quality of this research response:
1. Are sources properly attributed (mentions where information came from)?
2. Is the information factually presented (not speculative)?
3. Is the report well-structured with clear sections?
4. Does it cover the key entities: ${testCase.entities.join(", ")}?`,
        );
        const synthesisScore = createScore(
          "synthesis-quality",
          synthesisJudge.value,
          synthesisJudge.reason,
        );

        // Entity presence scorer
        const presentCount = testCase.entities.filter((entity) =>
          output.toLowerCase().includes(entity.toLowerCase()),
        ).length;
        const entityValue = presentCount / testCase.entities.length;
        const entityScore = createScore(
          "entity-presence",
          entityValue,
          `Found ${presentCount}/${testCase.entities.length} entities`,
        );

        // Citation presence
        const hasCitations = output.includes("http");
        const citationScore = createScore(
          "has-citations",
          hasCitations ? 1 : 0,
          hasCitations ? "Contains URLs" : "No URLs found",
        );

        return [
          createScore("task-complete", judge.value, judge.reason),
          synthesisScore,
          entityScore,
          citationScore,
        ];
      },
      metadata: { case: testCase.id, category: "search", entities: testCase.entities },
    },
  }),
);

// ---------------------------------------------------------------------------
// Eval registrations: Failure cases
// ---------------------------------------------------------------------------

const failureEvals: EvalRegistration[] = failureCases.map((testCase) =>
  defineEval({
    name: `web/failure/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: (input, context) => webAgent.execute(input, context),
      score: async (result) => {
        const output = result.ok ? result.data.response : `Error: ${result.error.reason}`;
        const wasFailure = !result.ok;

        const judge = await llmJudge(output, testCase.criteria);

        const correctBehavior = wasFailure === testCase.shouldFail;
        const behaviorScore = createScore(
          "failure-behavior",
          correctBehavior ? 1 : 0,
          testCase.shouldFail
            ? `Should fail: ${wasFailure ? "failed" : "succeeded"}`
            : `Should succeed: ${wasFailure ? "failed" : "succeeded"}`,
        );

        return [createScore("task-complete", judge.value, judge.reason), behaviorScore];
      },
      metadata: { case: testCase.id, category: "failure", shouldFail: testCase.shouldFail },
    },
  }),
);

// ---------------------------------------------------------------------------
// Eval registrations: Mixed-mode cases
// ---------------------------------------------------------------------------

const mixedModeEvals: EvalRegistration[] = mixedModeCases.map((testCase) =>
  defineEval({
    name: `web/mixed/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: (input, context) => webAgent.execute(input, context),
      assert: (result) => {
        if (!result.ok) {
          throw new Error(`Agent returned error: ${result.error.reason}`);
        }
      },
      score: async (result, traces) => {
        const output = result.ok ? result.data.response : `Error: ${result.error.reason}`;
        const judge = await llmJudge(output, testCase.expectedOutput);

        // tool-selection: verify expected tools were both used
        const toolsUsed = getToolsUsed(traces);
        const allExpectedUsed = testCase.expectedTools.every((t) => toolsUsed.includes(t));
        const toolScore = createScore(
          "tool-selection",
          allExpectedUsed ? 1 : 0,
          allExpectedUsed
            ? `Used expected tools: ${testCase.expectedTools.join(", ")}`
            : `Expected tools [${testCase.expectedTools.join(", ")}], used [${toolsUsed.join(", ")}]`,
        );

        // step-efficiency: browse commands if any
        const commands = extractBrowserCommands(traces);
        const efficiencyScore = createScore(
          "step-efficiency",
          commands.length > 0 ? Math.min(3 / commands.length, 1) : 1,
          `${commands.length} browse commands`,
        );

        return [
          createScore("task-complete", judge.value, judge.reason),
          toolScore,
          efficiencyScore,
        ];
      },
      metadata: { case: testCase.id, category: "mixed", expectedTools: testCase.expectedTools },
    },
  }),
);

// ---------------------------------------------------------------------------
// Eval registrations: Decision-quality cases
// ---------------------------------------------------------------------------

const decisionQualityEvals: EvalRegistration[] = decisionQualityCases.map((testCase) =>
  defineEval({
    name: `web/decision/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: (input, context) => webAgent.execute(input, context),
      score: async (result, traces) => {
        const output = result.ok ? result.data.response : `Error: ${result.error.reason}`;
        const judge = await llmJudge(output, testCase.expectedOutput);

        const toolSelectionScore = scoreToolSelection(
          traces,
          testCase.expectedTool,
          testCase.avoidTool,
        );

        return [createScore("task-complete", judge.value, judge.reason), toolSelectionScore];
      },
      metadata: {
        case: testCase.id,
        category: "decision",
        expectedTool: testCase.expectedTool,
        avoidTool: testCase.avoidTool,
      },
    },
  }),
);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = [
  ...browserEvals,
  ...searchEvals,
  ...failureEvals,
  ...mixedModeEvals,
  ...decisionQualityEvals,
];
