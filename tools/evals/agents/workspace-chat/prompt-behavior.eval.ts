// deno-lint-ignore-file require-await
//
// Phase 9 + Phase 5 anti-regression eval.
//
// Verifies the LLM uses programmatically-injected `<retrieved_content>` and
// `<memory>` blocks in workspace-chat's system prompt. The Phase 9 + 5
// implementations inject these blocks at action-start (or per-turn for chat);
// this eval confirms the LLM actually USES them — citing artifact ids when
// asked to summarize, calling parse_artifact when summary alone is
// insufficient, and respecting injected temporal facts over training-cutoff
// hallucinations.
//
// The eval doesn't spin up a daemon — it builds the prompt the runtime would
// build (memory + artifact blocks + chat prompt), runs streamText, and
// scores tool-call shape + response content against case expectations.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import {
  buildRegistryModelId,
  isRegistryProvider,
  type RegistryModelId,
  registry,
  traceModel,
} from "@atlas/llm";
import { getFridayHome } from "@atlas/utils/paths.server";
import { stepCountIs, streamText, tool } from "ai";
import dotenv from "dotenv";
import { z } from "zod";
import { AgentContextAdapter } from "../../lib/context.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

dotenv.config();
const globalAtlasEnv = join(getFridayHome(), ".env");
if (existsSync(globalAtlasEnv)) {
  dotenv.config({ path: globalAtlasEnv, override: true });
}
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is required to run workspace-chat evals");
}

const adapter = new AgentContextAdapter();

const ROOT = resolve(import.meta.dirname ?? ".", "../../../..");

const WORKSPACE_CHAT_PROMPT = await readFile(
  resolve(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Synthesized envelope blocks — mirrors the runtime's injection format.
// `composeArtifactBlocks` (packages/core/src/agent-context/compose-blocks.ts)
// emits `<retrieved_content provenance="artifact:<id>" origin="..." fetched_at="...">`
// envelopes; this eval reproduces that shape so the LLM sees the same prompt
// surface a real session would see.
// ---------------------------------------------------------------------------

function buildRetrievedContentBlock(opts: {
  artifactId: string;
  origin: string;
  fetchedAt: string;
  body: string;
}): string {
  return [
    `<retrieved_content provenance="artifact:${opts.artifactId}" origin="${opts.origin}" fetched_at="${opts.fetchedAt}">`,
    opts.body,
    "</retrieved_content>",
  ].join("\n");
}

function buildMemoryBlock(opts: {
  store: string;
  entries: Array<{ ts: string; body: string }>;
}): string {
  const lines = opts.entries.map((e) => `<entry ts="${e.ts}">${e.body}</entry>`).join("\n");
  return `<memory store="${opts.store}">\n${lines}\n</memory>`;
}

function buildTemporalBlock(opts: { now: string; tz: string }): string {
  return `<temporal>\n<now>${opts.now}</now>\n<tz>${opts.tz}</tz>\n</temporal>`;
}

// ---------------------------------------------------------------------------
// Tool stubs — mirror the chat tool surface the LLM would have access to so
// scoring can observe real tool-call shape.
// ---------------------------------------------------------------------------

interface CapturedToolCalls {
  parseArtifactCalls: Array<{ id: string }>;
  displayArtifactCalls: Array<{ id: string }>;
  memorySaveCalls: Array<{ store: string; body: string }>;
  finalResponse: string;
}

function emptyCaptures(): CapturedToolCalls {
  return {
    parseArtifactCalls: [],
    displayArtifactCalls: [],
    memorySaveCalls: [],
    finalResponse: "",
  };
}

function buildTools(captures: CapturedToolCalls) {
  return {
    parse_artifact: tool({
      description:
        "Read the full contents of an artifact by id. Use when the prompt's " +
        "summary of an artifact isn't enough detail to answer the user.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        captures.parseArtifactCalls.push({ id });
        return { ok: true, content: `[stub body for artifact ${id}; eval doesn't actually fetch]` };
      },
    }),

    display_artifact: tool({
      description: "Render an artifact inline for the user.",
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        captures.displayArtifactCalls.push({ id });
        return { ok: true };
      },
    }),

    memory_save: tool({
      description: "Save a narrative entry to a memory store.",
      inputSchema: z.object({ store: z.string(), body: z.string() }),
      execute: async ({ store, body }) => {
        captures.memorySaveCalls.push({ store, body });
        return { ok: true };
      },
    }),
  };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface PromptBehaviorCase extends BaseEvalCase {
  /** Extra blocks prepended to the system prompt to simulate retrieval injection. */
  injectedBlocks: string[];
  /** Subset of `parse_artifact`/`display_artifact` ids we expect the LLM to reference. */
  expectArtifactIdsCited?: string[];
  /** When set, the LLM must call parse_artifact on the listed ids. */
  expectParseArtifactCalls?: string[];
  /** Expected substrings in the LLM's final text response. */
  expectInResponse?: string[];
  /** Forbidden substrings in the response (e.g. wrong year hallucination). */
  forbiddenInResponse?: string[];
}

const FROZEN_NOW = "2026-04-15T12:00:00Z";

const cases: PromptBehaviorCase[] = [
  {
    id: "cites-artifact-when-retrieved-content-present",
    name: "cites artifact id when summarizing from injected retrieved_content",
    input: "Summarize the artifact you have access to in the prompt. Reference it by its id.",
    injectedBlocks: [
      buildRetrievedContentBlock({
        artifactId: "art_abc123",
        origin: "session:test",
        fetchedAt: FROZEN_NOW,
        body: "Artifact body: Q3 review summary — revenue up 12%, churn down 2%. Net new logos 47.",
      }),
    ],
    expectInResponse: ["art_abc123"],
  },
  {
    id: "calls-parse-artifact-when-summary-insufficient",
    name: "calls parse_artifact when retrieved_content summary is too thin",
    input:
      "What were the exact action items from the meeting? Look at the artifact in the prompt — its summary is brief; you'll need the full content.",
    injectedBlocks: [
      buildRetrievedContentBlock({
        artifactId: "art_meeting_notes",
        origin: "session:test",
        fetchedAt: FROZEN_NOW,
        body: "Summary: Q3 planning meeting (full body 14KB; retrieve via parse_artifact for action items).",
      }),
    ],
    expectParseArtifactCalls: ["art_meeting_notes"],
  },
  {
    id: "respects-injected-temporal-facts",
    name: "answers from injected <temporal> block, not training cutoff",
    input: "What year is it right now? Answer in one sentence with the year.",
    injectedBlocks: [buildTemporalBlock({ now: FROZEN_NOW, tz: "UTC" })],
    expectInResponse: ["2026"],
    forbiddenInResponse: ["2024", "2025", "I don't know", "I cannot"],
  },
  {
    id: "uses-memory-block-context",
    name: "answers from injected <memory> block, not vague guess",
    input: "What was my last decision about the migration plan?",
    injectedBlocks: [
      buildMemoryBlock({
        store: "notes",
        entries: [
          {
            ts: "2026-04-12T09:00:00Z",
            body: "Decision: ship the auth migration this quarter; defer the gateway split to Q4.",
          },
        ],
      }),
    ],
    expectInResponse: ["auth migration", "this quarter"],
  },
];

// ---------------------------------------------------------------------------
// Run helper
// ---------------------------------------------------------------------------

function resolveModelId(): RegistryModelId {
  const raw = process.env.WORKSPACE_CHAT_EVAL_MODEL;
  if (!raw) return "anthropic:claude-sonnet-4-20250514";
  const colonIdx = raw.indexOf(":");
  if (colonIdx === -1) {
    throw new Error(`WORKSPACE_CHAT_EVAL_MODEL must be in "provider:model" form, got "${raw}".`);
  }
  const provider = raw.slice(0, colonIdx);
  const model = raw.slice(colonIdx + 1);
  if (!isRegistryProvider(provider)) {
    throw new Error(`Unknown provider "${provider}" in WORKSPACE_CHAT_EVAL_MODEL.`);
  }
  return buildRegistryModelId(provider, model);
}

const MODEL_ID = resolveModelId();

interface RunOutcome {
  captures: CapturedToolCalls;
  responseText: string;
}

async function runCase(testCase: PromptBehaviorCase): Promise<RunOutcome> {
  const captures = emptyCaptures();
  const tools = buildTools(captures);
  const system = [WORKSPACE_CHAT_PROMPT, ...testCase.injectedBlocks].join("\n\n");

  const result = streamText({
    model: traceModel(registry.languageModel(MODEL_ID)),
    system,
    messages: [{ role: "user", content: testCase.input }],
    tools,
    temperature: 0,
    stopWhen: stepCountIs(8),
  });

  let text = "";
  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") {
      const delta =
        (chunk as { textDelta?: string; text?: string }).textDelta ??
        (chunk as { text?: string }).text ??
        "";
      text += delta;
    }
  }
  captures.finalResponse = text;
  return { captures, responseText: text };
}

// ---------------------------------------------------------------------------
// Eval registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval<RunOutcome>({
    name: `workspace-chat/prompt-behavior/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: () => runCase(testCase),
      assert: ({ captures, responseText }) => {
        if (testCase.expectArtifactIdsCited) {
          for (const id of testCase.expectArtifactIdsCited) {
            if (!responseText.includes(id)) {
              throw new Error(
                `Expected response to cite artifact id "${id}". Got: ${responseText}`,
              );
            }
          }
        }
        if (testCase.expectParseArtifactCalls) {
          const calledIds = new Set(captures.parseArtifactCalls.map((c) => c.id));
          for (const id of testCase.expectParseArtifactCalls) {
            if (!calledIds.has(id)) {
              throw new Error(
                `Expected parse_artifact("${id}") to be called. Got: [${[...calledIds].join(", ")}]`,
              );
            }
          }
        }
        if (testCase.expectInResponse) {
          for (const sub of testCase.expectInResponse) {
            if (!responseText.toLowerCase().includes(sub.toLowerCase())) {
              throw new Error(`Expected response to contain "${sub}". Got: ${responseText}`);
            }
          }
        }
        if (testCase.forbiddenInResponse) {
          for (const sub of testCase.forbiddenInResponse) {
            if (responseText.toLowerCase().includes(sub.toLowerCase())) {
              throw new Error(`Forbidden substring "${sub}" appeared in response: ${responseText}`);
            }
          }
        }
      },
      score: ({ captures, responseText }) => {
        const scores = [];

        if (testCase.expectInResponse) {
          const hits = testCase.expectInResponse.filter((s) =>
            responseText.toLowerCase().includes(s.toLowerCase()),
          ).length;
          scores.push(
            createScore(
              "expected-substrings",
              hits / testCase.expectInResponse.length,
              `${hits}/${testCase.expectInResponse.length} expected substrings present`,
            ),
          );
        }

        if (testCase.forbiddenInResponse) {
          const hits = testCase.forbiddenInResponse.filter((s) =>
            responseText.toLowerCase().includes(s.toLowerCase()),
          ).length;
          scores.push(
            createScore(
              "no-forbidden-substrings",
              hits === 0 ? 1 : 0,
              hits === 0
                ? "none of the forbidden substrings appeared"
                : `${hits} forbidden substring(s) appeared`,
            ),
          );
        }

        if (testCase.expectParseArtifactCalls) {
          const calledIds = new Set(captures.parseArtifactCalls.map((c) => c.id));
          const hits = testCase.expectParseArtifactCalls.filter((id) => calledIds.has(id)).length;
          scores.push(
            createScore(
              "parse-artifact-called",
              hits / testCase.expectParseArtifactCalls.length,
              `${hits}/${testCase.expectParseArtifactCalls.length} expected parse_artifact calls observed`,
            ),
          );
        }

        return scores;
      },
      metadata: {
        case: testCase.id,
        injectedBlockCount: testCase.injectedBlocks.length,
        model: MODEL_ID,
      },
    },
  }),
);
