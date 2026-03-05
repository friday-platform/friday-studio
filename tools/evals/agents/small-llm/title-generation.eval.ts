/**
 * Small LLM — Chat title generation eval.
 *
 * Regression guard for the empty-title bug: reasoning models exhaust their
 * token budget on internal reasoning tokens, producing empty output.
 */

import { smallLLM } from "@atlas/llm";
import { AgentContextAdapter } from "../../lib/context.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore, type Score } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

const TITLE_SYSTEM =
  "You generate concise 2-3 word titles for conversations. Only output the title, nothing else.";

// ---------------------------------------------------------------------------
// Scorers
// ---------------------------------------------------------------------------

function nonEmptyScore(text: string): Score {
  const trimmed = text.trim();
  if (trimmed.length < 3) {
    return createScore("NonEmpty", 0, `Too short: "${trimmed}" (${trimmed.length} chars)`);
  }
  return createScore("NonEmpty", 1, `"${trimmed}"`);
}

function titleLengthScore(text: string): Score {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2 && words.length <= 3) {
    return createScore("TitleLength", 1, `${words.length} words`);
  }
  return createScore("TitleLength", 0, `${words.length} words (expected 2-3)`);
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const titleCases: BaseEvalCase[] = [
  {
    id: "short-greeting",
    name: "short greeting - who are you",
    input:
      'user: [{"type":"text","text":"who are you"}]\nassistant: [{"type":"text","text":"I\'m Friday, an AI assistant."}]',
  },
  {
    id: "technical-question",
    name: "technical - OAuth flows",
    input:
      'user: [{"type":"text","text":"Can you explain the difference between OAuth 2.0 authorization code flow and the implicit flow?"}]\nassistant: [{"type":"text","text":"The authorization code flow is a two-step process where the server exchanges a code for tokens. The implicit flow returns tokens directly in the URL fragment."}]',
  },
  {
    id: "creative-request",
    name: "creative - write a story",
    input:
      'user: [{"type":"text","text":"Write me a dark fantasy short story about a lighthouse keeper who discovers the light lures ancient leviathans from the deep ocean."}]\nassistant: [{"type":"text","text":"The fog had not lifted in eleven days. Maren Sollis kept count by the scratch marks she\'d carved into the doorframe..."}]',
  },
  {
    id: "code-help",
    name: "code - fix a bug",
    input:
      'user: [{"type":"text","text":"My React useEffect is firing twice in development mode, what\'s going on?"}]\nassistant: [{"type":"text","text":"In React 18 with StrictMode enabled, effects intentionally fire twice in development to help you find bugs."}]',
  },
  {
    id: "long-technical",
    name: "long - microservices migration",
    input:
      'user: [{"type":"text","text":"We\'re planning a microservices migration from a Django monolith. The current app handles user authentication, product catalog with search, order processing with payment integration via Stripe, email notifications via SendGrid, and a recommendation engine using collaborative filtering. We want to decompose this into separate services."}]\nassistant: [{"type":"text","text":"I\'d recommend starting with 5 bounded contexts: Auth, Product/Search, Orders, Notifications, and Recommendations. Migrate in order of lowest risk first..."}]',
  },
];

// ---------------------------------------------------------------------------
// Registrations
// ---------------------------------------------------------------------------

const MAX_OUTPUT_TOKENS = 250;

const titleEvals = titleCases.map((testCase) =>
  defineEval({
    name: `small-llm/groq/title/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: async () => {
        const start = performance.now();
        const text = await smallLLM({
          system: TITLE_SYSTEM,
          prompt: `Generate a title for this conversation:\n${testCase.input}`,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
        });
        return { text, latencyMs: performance.now() - start };
      },
      score: (result) => [nonEmptyScore(result.text), titleLengthScore(result.text)],
      metadata: { system: TITLE_SYSTEM },
    },
  }),
);

export const evals: EvalRegistration[] = titleEvals;
