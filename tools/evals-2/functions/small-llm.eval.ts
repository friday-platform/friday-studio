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
