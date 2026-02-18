/**
 * Small LLM — Progress message generation eval.
 *
 * Tests that smallLLM and Haiku produce proper short status-line outputs
 * (≤50 chars, -ing verb) given tool invocation or research stage prompts.
 */

import { registry, smallLLM, traceModel } from "@atlas/llm";
import { generateText } from "ai";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore, type Score } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

// System prompts from the actual agents
const CLAUDE_CODE_SYSTEM = `Format tool invocation as single-line status. Output only the status line, no explanations.

<rules>
- Single line, ≤50 chars
- Use -ing verbs: Reading, Writing, Executing
- Preserve technical terms, numbers, HTTP codes, filenames
- Abbreviate long paths to filename only (>20 chars)
- Remove articles: the, this, my, a, an
</rules>

<examples>
Write to /tmp/agent-output.txt → "Writing agent-output.txt"
Read package.json → "Reading package.json"
</examples>`;

const RESEARCH_SYSTEM = `Generate a research progress update.

<constraints>
- Maximum 4 words
- Start with active verb
- Be specific about WHAT is being researched
- Match the research topic/question in context
- No generic phrases like "conducting research"
</constraints>`;

const WEB_SEARCH_PROGRESS_SYSTEM = `Output a single research status line (≤40 chars, -ing verb, no punctuation).

When multiple items: describe the category or purpose, not individual names.

Examples:
"Compare AWS and GCP pricing" → "Comparing cloud pricing"
"What is Parker Conrad known for?" → "Researching Parker Conrad"
"Latest quantum computing news" → "Finding quantum computing news"
"Research 3 people for today's meetings" → "Researching meeting contacts"
"Find info on Rippling, Replit, Socket" → "Researching portfolio companies"`;

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

function latencyScore(latencyMs: number): Score {
  const value = Math.max(0, Math.min(1, 1 - (latencyMs - 200) / 1900));
  return createScore("Latency", value, `${Math.round(latencyMs)}ms`);
}

function relevanceScore(text: string, keywords: string[]): Score {
  const lower = text.toLowerCase();
  const matches = keywords.filter((k) => lower.includes(k.toLowerCase()));
  const value = matches.length / keywords.length;
  return createScore("Relevance", value, `${matches.length}/${keywords.length} keywords`);
}

function statusLineScore(text: string): Score {
  const trimmed = text.trim();
  const failPatterns = [
    /^I('m| am| cannot| can't| don't)/i,
    /^(Some|Here|The|There|This|These|Those)\s/i,
    /\d+\.\s+\*?\*?[A-Z]/i,
    /^(Unfortunately|However|Sorry)/i,
    /\n/,
  ];

  for (const pattern of failPatterns) {
    if (pattern.test(trimmed)) {
      return createScore("StatusLine", 0, `Matched fail pattern: ${pattern}`);
    }
  }

  if (trimmed.length > 50) {
    return createScore("StatusLine", 0.5, `Too long: ${trimmed.length} chars`);
  }

  if (/^[A-Z][a-z]+ing\b/.test(trimmed)) {
    return createScore("StatusLine", 1, "Proper -ing verb format");
  }

  return createScore("StatusLine", 0.7, "Acceptable but not ideal format");
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

interface ProgressCase extends BaseEvalCase {
  system: string;
  keywords: string[];
}

const progressCases: ProgressCase[] = [
  // Claude Code style - tool invocations
  {
    id: "tool-write-file",
    name: "tool - write file",
    system: CLAUDE_CODE_SYSTEM,
    input: JSON.stringify({ toolName: "Write", input: { file_path: "/tmp/agent-output.txt" } }),
    keywords: ["writing", "output.txt"],
  },
  {
    id: "tool-read-package-json",
    name: "tool - read package.json",
    system: CLAUDE_CODE_SYSTEM,
    input: JSON.stringify({ toolName: "Read", input: { file: "package.json" } }),
    keywords: ["reading", "package.json"],
  },
  {
    id: "tool-bash-npm-install",
    name: "tool - bash npm install",
    system: CLAUDE_CODE_SYSTEM,
    input: JSON.stringify({ toolName: "Bash", input: { command: "npm install" } }),
    keywords: ["npm", "install"],
  },
  {
    id: "tool-edit-index-ts",
    name: "tool - edit index.ts",
    system: CLAUDE_CODE_SYSTEM,
    input: JSON.stringify({
      toolName: "Edit",
      input: { file_path: "src/index.ts", changes: "..." },
    }),
    keywords: ["editing", "index.ts"],
  },
  // Research style - progress updates
  {
    id: "research-ai-safety",
    name: "research - AI safety",
    system: RESEARCH_SYSTEM,
    input: "stage: analyzing, context: AI safety developments",
    keywords: ["ai", "safety"],
  },
  {
    id: "research-parker-conrad",
    name: "research - Parker Conrad",
    system: RESEARCH_SYSTEM,
    input: "stage: starting, topic: Parker Conrad background research",
    keywords: ["parker", "conrad"],
  },
  {
    id: "research-quantum-trends",
    name: "research - quantum trends",
    system: RESEARCH_SYSTEM,
    input: "stage: reporting, question: quantum computing trends",
    keywords: ["quantum"],
  },
  {
    id: "research-anthropic-meeting",
    name: "research - Anthropic meeting",
    system: RESEARCH_SYSTEM,
    input: "stage: analyzing, context: meeting with Anthropic team",
    keywords: ["anthropic"],
  },
];

const webSearchCases: ProgressCase[] = [
  {
    id: "wroclaw-news",
    name: "web search - Wroclaw news",
    system: WEB_SEARCH_PROGRESS_SYSTEM,
    input:
      "Find recent news from Wrocław, Poland from the last 23 hours. Look for local news, events, developments, and stories specifically related to Wrocław city.",
    keywords: ["wrocław", "news", "finding", "searching", "researching"],
  },
  {
    id: "gravel-bikes",
    name: "web search - gravel bikes",
    system: WEB_SEARCH_PROGRESS_SYSTEM,
    input:
      "What are new options for gravel bikes which fit larger than 2-inch tires? Prefer titanium frames, but open to carbon as well.",
    keywords: ["gravel", "bike", "finding", "searching", "researching"],
  },
  {
    id: "parker-conrad",
    name: "web search - Parker Conrad",
    system: WEB_SEARCH_PROGRESS_SYSTEM,
    input: "Who is Parker Conrad?",
    keywords: ["parker", "conrad", "researching"],
  },
  {
    id: "quantum-computing-news",
    name: "web search - quantum computing",
    system: WEB_SEARCH_PROGRESS_SYSTEM,
    input: "Latest quantum computing news",
    keywords: ["quantum", "finding", "searching"],
  },
];

// ---------------------------------------------------------------------------
// Variants — test across different providers
// ---------------------------------------------------------------------------

type Provider = "groq" | "haiku";

const variants: Array<{ name: string; provider: Provider }> = [
  { name: "Groq", provider: "groq" },
  { name: "Haiku", provider: "haiku" },
];

async function runSmallLLM(
  provider: Provider,
  system: string,
  prompt: string,
  maxOutputTokens: number,
): Promise<{ text: string; latencyMs: number }> {
  const start = performance.now();
  let text: string;
  if (provider === "groq") {
    text = await smallLLM({ system, prompt, maxOutputTokens });
  } else {
    const result = await generateText({
      model: traceModel(registry.languageModel("anthropic:claude-haiku-4-5")),
      system,
      prompt,
      maxOutputTokens,
    });
    text = result.text;
  }
  return { text, latencyMs: performance.now() - start };
}

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

const progressEvals = variants.flatMap((variant) =>
  progressCases.map((testCase) =>
    defineEval({
      name: `small-llm/${variant.name}/progress/${testCase.id}`,
      adapter,
      config: {
        input: testCase.input,
        run: async () => {
          return await runSmallLLM(variant.provider, testCase.system, testCase.input, 50);
        },
        score: (result) => [
          latencyScore(result.latencyMs),
          relevanceScore(result.text, testCase.keywords),
        ],
        metadata: { variant: variant.name, system: testCase.system, keywords: testCase.keywords },
      },
    }),
  ),
);

const webSearchEvals = webSearchCases.map((testCase) =>
  defineEval({
    name: `small-llm/groq/web-search-progress/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async () => {
        return await runSmallLLM("groq", testCase.system, testCase.input, 30);
      },
      score: (result) => [
        latencyScore(result.latencyMs),
        relevanceScore(result.text, testCase.keywords),
        statusLineScore(result.text),
      ],
      metadata: { system: testCase.system, keywords: testCase.keywords },
    },
  }),
);

export const evals: EvalRegistration[] = [...progressEvals, ...webSearchEvals];
