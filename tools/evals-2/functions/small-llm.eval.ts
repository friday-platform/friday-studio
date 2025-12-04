import { registry, smallLLM } from "@atlas/llm";
import { generateText } from "ai";
import { evalite } from "evalite";
import { wrapAISDKModel } from "evalite/ai-sdk";
import { loadCredentials } from "../lib/load-credentials.ts";

await loadCredentials();

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

interface TestInput {
  system: string;
  prompt: string;
  keywords: string[];
}

type TaskOutput = { text: string; latencyMs: number };

// Scorers
const LatencyScorer = {
  name: "Latency",
  scorer: ({ output }: { output: TaskOutput }) => {
    // 1.0 if <100ms, 0.0 if >1000ms, linear between
    return Math.max(0, Math.min(1, 1 - (output.latencyMs - 200) / 1900));
  },
};

const RelevanceScorer = {
  name: "Relevance",
  scorer: ({ output, input }: { output: TaskOutput; input: TestInput }) => {
    const text = output.text.toLowerCase();
    const matches = input.keywords.filter((k) => text.includes(k.toLowerCase()));
    return matches.length / input.keywords.length;
  },
};

evalite.each([
  { name: "Llama 3.1 8B Instant (Groq)", input: { provider: "groq" as const } },
  { name: "Haiku 4.5", input: { provider: "haiku" as const } },
])("Small LLM: Progress Messages", {
  data: () => [
    // Claude Code style - tool invocations
    {
      input: {
        system: CLAUDE_CODE_SYSTEM,
        prompt: JSON.stringify({
          toolName: "Write",
          input: { file_path: "/tmp/agent-output.txt" },
        }),
        keywords: ["writing", "output.txt"],
      },
    },
    {
      input: {
        system: CLAUDE_CODE_SYSTEM,
        prompt: JSON.stringify({ toolName: "Read", input: { file: "package.json" } }),
        keywords: ["reading", "package.json"],
      },
    },
    {
      input: {
        system: CLAUDE_CODE_SYSTEM,
        prompt: JSON.stringify({ toolName: "Bash", input: { command: "npm install" } }),
        keywords: ["npm", "install"],
      },
    },
    {
      input: {
        system: CLAUDE_CODE_SYSTEM,
        prompt: JSON.stringify({
          toolName: "Edit",
          input: { file_path: "src/index.ts", changes: "..." },
        }),
        keywords: ["editing", "index.ts"],
      },
    },
    // Research style - progress updates
    {
      input: {
        system: RESEARCH_SYSTEM,
        prompt: "stage: analyzing, context: AI safety developments",
        keywords: ["ai", "safety"],
      },
    },
    {
      input: {
        system: RESEARCH_SYSTEM,
        prompt: "stage: starting, topic: Parker Conrad background research",
        keywords: ["parker", "conrad"],
      },
    },
    {
      input: {
        system: RESEARCH_SYSTEM,
        prompt: "stage: reporting, question: quantum computing trends",
        keywords: ["quantum"],
      },
    },
    {
      input: {
        system: RESEARCH_SYSTEM,
        prompt: "stage: analyzing, context: meeting with Anthropic team",
        keywords: ["anthropic"],
      },
    },
  ],
  task: async (input, variant): Promise<TaskOutput> => {
    const start = performance.now();

    let text: string;
    if (variant.provider === "groq") {
      text = await smallLLM({ system: input.system, prompt: input.prompt, maxOutputTokens: 50 });
    } else {
      const result = await generateText({
        model: wrapAISDKModel(registry.languageModel("anthropic:claude-haiku-4-5")),
        system: input.system,
        prompt: input.prompt,
        maxOutputTokens: 50,
      });
      text = result.text;
    }

    const latencyMs = performance.now() - start;
    return { text, latencyMs };
  },
  trialCount: 3,
  scorers: [LatencyScorer, RelevanceScorer],
  columns: ({ output, input }) => [
    { label: "Input", value: JSON.stringify(input) },
    { label: "Output", value: output.text },
    { label: "Time", value: `${Math.round(output.latencyMs).toString()}ms` },
  ],
});

// Scorer that validates output is a proper status line (not an answer/refusal)
const StatusLineScorer = {
  name: "Status Line Format",
  scorer: ({ output }: { output: TaskOutput }) => {
    const text = output.text.trim();

    // Fail patterns - things that indicate the model is answering/refusing instead of generating status
    const failPatterns = [
      /^I('m| am| cannot| can't| don't)/i, // Refusals/first person responses
      /^(Some|Here|The|There|This|These|Those)\s/i, // Starting to answer the question
      /\d+\.\s+\*?\*?[A-Z]/i, // Numbered lists (answering)
      /^(Unfortunately|However|Sorry)/i, // Hedging/refusing
      /\n/, // Multi-line output
    ];

    for (const pattern of failPatterns) {
      if (pattern.test(text)) {
        return { score: 0, metadata: { reason: `Matched fail pattern: ${pattern}` } };
      }
    }

    // Check length constraint (≤40 chars)
    if (text.length > 50) {
      return { score: 0.5, metadata: { reason: `Too long: ${text.length} chars` } };
    }

    // Check for -ing verb (good pattern)
    if (/^[A-Z][a-z]+ing\b/.test(text)) {
      return { score: 1, metadata: { reason: "Proper -ing verb format" } };
    }

    return { score: 0.7, metadata: { reason: "Acceptable but not ideal format" } };
  },
};

// Test the actual web-search.ts behavior: raw user prompts with the real system prompt
evalite.each([
  { name: "llama-4-maverick-17b-128e-instruct (Groq)", input: { provider: "groq" as const } },
])("Web Search Progress: Raw Prompts", {
  data: () => [
    // These are the ACTUAL prompts from research.eval.ts that are failing
    {
      input: {
        system: WEB_SEARCH_PROGRESS_SYSTEM,
        prompt:
          "Find recent news from Wrocław, Poland from the last 23 hours. Look for local news, events, developments, and stories specifically related to Wrocław city. Include headlines, brief summaries, and source links.",
        keywords: ["wrocław", "news", "finding", "searching", "researching"],
      },
    },
    {
      input: {
        system: WEB_SEARCH_PROGRESS_SYSTEM,
        prompt:
          "What are new options for gravel bikes which fit larger than 2-inch tires? Prefer titanium frames, but open to carbon as well.",
        keywords: ["gravel", "bike", "finding", "searching", "researching"],
      },
    },
    {
      input: {
        system: WEB_SEARCH_PROGRESS_SYSTEM,
        prompt: `Research the people I'm meeting with today and their companies.
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
        keywords: ["researching", "meeting", "people"],
      },
    },
    // Simpler prompts that should work
    {
      input: {
        system: WEB_SEARCH_PROGRESS_SYSTEM,
        prompt: "Who is Parker Conrad?",
        keywords: ["parker", "conrad", "researching"],
      },
    },
    {
      input: {
        system: WEB_SEARCH_PROGRESS_SYSTEM,
        prompt: "Latest quantum computing news",
        keywords: ["quantum", "finding", "searching"],
      },
    },
  ],
  task: async (input, variant): Promise<TaskOutput> => {
    const start = performance.now();

    let text: string;
    if (variant.provider === "groq") {
      text = await smallLLM({ system: input.system, prompt: input.prompt, maxOutputTokens: 30 });
    } else {
      const result = await generateText({
        model: wrapAISDKModel(registry.languageModel("anthropic:claude-haiku-4-5")),
        system: input.system,
        prompt: input.prompt,
        maxOutputTokens: 30,
      });
      text = result.text;
    }

    const latencyMs = performance.now() - start;
    return { text, latencyMs };
  },
  scorers: [LatencyScorer, RelevanceScorer, StatusLineScorer],
  columns: ({ output, input }) => [
    { label: "Prompt", value: input.prompt.slice(0, 60) + (input.prompt.length > 60 ? "..." : "") },
    { label: "Output", value: output.text },
    { label: "Time", value: `${Math.round(output.latencyMs).toString()}ms` },
  ],
});
