/**
 * Prompt-behavior evals for the retrieval-gated injection + prompt
 * consolidation work. Each case probes a specific rule that the
 * consolidated prompt is supposed to enforce — exactly the load-bearing
 * behaviors the standalone tests don't (and can't) cover.
 *
 * Coverage:
 *
 *   - voice/cold-start-no-warmth — the `<voice>` rule resolution
 *     ("brief opener, not warm"). Cold-start chat with no warmth
 *     signal: model should respond briefly without initiating warmth.
 *
 *   - no-fabrication/unverified-version — the `<no_fabrication>` rule
 *     ("haven't verified → say so"). Asks for a moving target (current
 *     version of an API). Model must either call a tool or admit
 *     uncertainty — must NOT confidently fabricate.
 *
 *   - memory-save/why-required — `<memory_writes>` says `why` is
 *     required. The schema enforces it; the prompt should drive the
 *     model to pass it. Asserts captured tool call.
 *
 *   - describe-skill/applicability-check — Phase 6 skills cut-over
 *     replaced the inline skill descriptions with names only.
 *     Available skills are pull-only via `describe_skill(name)` for
 *     metadata or `load_skill(name)` for the body. Model should call
 *     describe_skill to check applicability before committing to a
 *     load_skill call when name alone is ambiguous.
 *
 * Manual repro (live daemon):
 *
 *   deno task atlas daemon start --detached
 *   deno task atlas prompt "<one of the case inputs>"
 *   # Inspect the chat transcript.
 *   deno task atlas daemon stop
 */

// deno-lint-ignore-file require-await

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";
import {
  buildRegistryModelId,
  isRegistryProvider,
  type RegistryModelId,
  registry,
  traceModel,
} from "@atlas/llm";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { AgentContextAdapter } from "../../lib/context.ts";
import { llmJudge } from "../../lib/llm-judge.ts";
import { loadCredentials } from "../../lib/load-credentials.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

await loadCredentials();

const adapter = new AgentContextAdapter();

const ROOT = resolve(import.meta.dirname ?? ".", "../../../..");

const WORKSPACE_CHAT_PROMPT = await readFile(
  resolve(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
  "utf8",
);

const WRITING_TO_MEMORY_SKILL = await readFile(
  resolve(ROOT, "packages/system/skills/writing-to-memory/SKILL.md"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Synthetic runtime sections — match what workspace-chat assembles per turn.
// Identity is provided so onboarding is gated off; voice cases test post-
// onboarding behavior. The skills section is the new name-only Phase 6
// shape — descriptions are pull-only via describe_skill.
// ---------------------------------------------------------------------------

const WORKSPACE_SECTION = `<workspace id="ws-eval" name="eval-workspace">
<description>Empty workspace used by prompt-behavior evals.</description>
<memory_stores>
<store name="notes" type="short_term"/>
<store name="memory" type="long_term"/>
</memory_stores>
</workspace>`;

const SKILLS_SECTION = `<available_skills>
<instruction>Skill names only — call describe_skill(name) for descriptions, load_skill(name) for full body. Use describe_skill before load_skill when the name alone doesn't tell you whether it applies.</instruction>
<skill name="@friday/authoring-skills"/>
<skill name="@friday/composing-emails"/>
<skill name="@friday/friday-cli"/>
<skill name="@friday/using-mcp-servers"/>
<skill name="@friday/workspace-api"/>
<skill name="@friday/writing-friday-python-agents"/>
<skill name="@friday/writing-to-memory"/>
<skill name="@friday/writing-workspace-jobs"/>
<skill name="@friday/writing-workspace-signals"/>
</available_skills>`;

const USER_IDENTITY_SECTION = `<user_identity>
Name: alex
Email: alex@example.com
</user_identity>`;

// Connected integrations only — mirrors Phase 6 partial cut-over where
// only `status="ready"` providers inline. Unconnected providers (e.g.
// `google-calendar` here) are pull-only via `list_integrations` so the
// `verify-before-suggest` case has a reason to fire that tool.
const INTEGRATIONS_SECTION = `<integrations>
  <service id="google-gmail" status="ready" label="alex@example.com" urlDomains="mail.google.com"/>
<note>Only connected services are listed above. For services the user mentions that aren't shown, call \`list_integrations({status: "unconnected"})\` to check what's available to connect.</note>
</integrations>`;

const SYSTEM_PROMPT = [
  WORKSPACE_CHAT_PROMPT,
  WORKSPACE_SECTION,
  INTEGRATIONS_SECTION,
  SKILLS_SECTION,
  USER_IDENTITY_SECTION,
].join("\n\n");

/**
 * Block 4 preface — what the runtime injects as a synthetic user-message
 * preface alongside the actual user input. Carries memory contents and
 * temporal facts wrapped in `<retrieved_content>` envelopes. We send a
 * minimal version (no memory entries) so the cases probe only the rule
 * under test.
 */
const BLOCK4_PREFACE = `<retrieved_content provenance="system-config" origin="temporal" fetched_at="${new Date().toISOString()}">
## Context Facts
- Current Date: ${new Date().toISOString().slice(0, 10)}
- Current Time: ${new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}
- Timestamp: ${new Date().toISOString()}
</retrieved_content>`;

// ---------------------------------------------------------------------------
// Captured tool calls
// ---------------------------------------------------------------------------

interface MemorySaveCapture {
  memoryName: string;
  text: string;
  why: string | undefined;
  metadata: Record<string, unknown> | undefined;
}

interface DescribeSkillCapture {
  name: string;
}

interface LoadSkillCapture {
  name: string;
}

interface ListIntegrationsCapture {
  status: string | undefined;
}

interface CapturedCalls {
  memorySaves: MemorySaveCapture[];
  describeSkills: DescribeSkillCapture[];
  loadSkills: LoadSkillCapture[];
  listIntegrations: ListIntegrationsCapture[];
  webSearches: string[];
  webFetches: string[];
}

function emptyCaptures(): CapturedCalls {
  return {
    memorySaves: [],
    describeSkills: [],
    loadSkills: [],
    listIntegrations: [],
    webSearches: [],
    webFetches: [],
  };
}

// ---------------------------------------------------------------------------
// Tool surface — mirrors workspace-chat's real tool descriptions verbatim
// where it matters (the descriptions are part of what shapes behavior).
// ---------------------------------------------------------------------------

const MemorySaveInput = z.object({
  memoryName: z.string(),
  text: z.string().min(1),
  why: z
    .string()
    .min(1)
    .describe(
      "Why this is worth remembering — what future request would benefit. Required by the schema; if you can't articulate why, don't save.",
    ),
  id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const MemoryReadInput = z.object({
  memoryName: z.string(),
  since: z.string().optional(),
  limit: z.number().int().positive().optional(),
});

const DescribeSkillInput = z.object({
  name: z.string().min(1).describe("Fully-qualified skill name from <available_skills>"),
});

const LoadSkillInput = z.object({ name: z.string(), reason: z.string().optional() });

const ListIntegrationsInput = z.object({
  status: z.enum(["ready", "unconnected", "all"]).optional(),
});

const WebSearchInput = z.object({ query: z.string() });
const WebFetchInput = z.object({ url: z.string() });
const SetUserIdentityInput = z.object({
  name: z.string().optional(),
  declined: z.boolean().optional(),
});

function buildToolset(captures: CapturedCalls) {
  return {
    memory_save: tool({
      description:
        "Save an entry to a named memory store in this workspace. " +
        "See <memory_writes> in your system prompt for trigger types and anti-triggers. " +
        "The `why` field is required and forces a sanity check — if you can't articulate why " +
        "this should be remembered, don't save. Persists across sessions.",
      inputSchema: MemorySaveInput,
      execute: async ({ memoryName, text, why, metadata }) => {
        captures.memorySaves.push({ memoryName, text, why, metadata });
        return { saved: true };
      },
    }),

    memory_read: tool({
      description: "Read entries from a named memory store, newest-first.",
      inputSchema: MemoryReadInput,
      execute: async () => ({
        items: [],
        provenance: {
          source: "user-authored",
          origin: "memory:notes",
          fetched_at: new Date().toISOString(),
        },
      }),
    }),

    describe_skill: tool({
      description:
        "Read a single skill's description + version metadata WITHOUT loading the body. " +
        "Use this to decide whether `load_skill` is warranted.",
      inputSchema: DescribeSkillInput,
      execute: async ({ name }) => {
        captures.describeSkills.push({ name });
        // Return a plausible description per skill so the model can decide.
        const descriptions: Record<string, string> = {
          "@friday/writing-to-memory":
            "How to read and write Friday memory stores correctly: store selection, terse entry format, large-content artifact pattern, and what's auto-injected into the system prompt.",
          "@friday/writing-workspace-jobs":
            "Author FSM workspace jobs. Use when creating, editing, or debugging jobs, signals, or FSM workflows in workspace.yml.",
          "@friday/writing-workspace-signals":
            "Authors Friday workspace signals with correct provider configs, payload schemas, and runtime wiring.",
          "@friday/composing-emails":
            "General styling and tone guidelines for composing HTML emails.",
          "@friday/workspace-api":
            "Create, list, update, delete, and clean up workspaces via the daemon HTTP API.",
        };
        const description = descriptions[name] ?? `(No description for ${name})`;
        return {
          items: [
            { name, namespace: name.split("/")[0]?.replace("@", ""), description, version: 1 },
          ],
          provenance: {
            source: "system-config",
            origin: `skill:${name}`,
            fetched_at: new Date().toISOString(),
          },
        };
      },
    }),

    load_skill: tool({
      description:
        "Load skill instructions BEFORE starting a task that matches a skill's description. " +
        "Skills contain step-by-step guidance you should follow.",
      inputSchema: LoadSkillInput,
      execute: async ({ name }) => {
        captures.loadSkills.push({ name });
        if (name === "@friday/writing-to-memory") {
          return { name, description: "memory authoring", instructions: WRITING_TO_MEMORY_SKILL };
        }
        return { error: `Skill "${name}" body not available in eval fixture.` };
      },
    }),

    list_integrations: tool({
      description:
        "List external service integrations available in this workspace. " +
        "Returns provider ids + connection status. Use this when the user asks 'what's connected?' " +
        "or before suggesting a service-dependent action.",
      inputSchema: ListIntegrationsInput,
      execute: async ({ status }) => {
        captures.listIntegrations.push({ status });
        return {
          items: [
            { id: "google-gmail", status: "ready", label: "alex@example.com" },
            { id: "github", status: "unconnected" },
            { id: "slack", status: "unconnected" },
          ],
          provenance: {
            source: "system-config",
            origin: "link:summary",
            fetched_at: new Date().toISOString(),
          },
        };
      },
    }),

    web_search: tool({
      description: "Search the web. Returns top results.",
      inputSchema: WebSearchInput,
      execute: async ({ query }) => {
        captures.webSearches.push(query);
        return { results: [{ title: "Result", url: "https://example.com", snippet: "..." }] };
      },
    }),

    web_fetch: tool({
      description: "Fetch a public URL and return its content as markdown.",
      inputSchema: WebFetchInput,
      execute: async ({ url }) => {
        captures.webFetches.push(url);
        return { content: "(eval fixture content)" };
      },
    }),

    set_user_identity: tool({
      description: "Save user identity to the persistent USERS store.",
      inputSchema: SetUserIdentityInput,
      execute: async () => ({ saved: true }),
    }),

    connect_service: tool({
      description: "Begin OAuth flow to connect a third-party service.",
      inputSchema: z.object({ provider: z.string() }),
      execute: async ({ provider }) => ({ provider, status: "auth-flow-started" }),
    }),
  };
}

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
    throw new Error(`WORKSPACE_CHAT_EVAL_MODEL has unknown provider "${provider}".`);
  }
  return buildRegistryModelId(provider, model);
}

const MODEL_ID = resolveModelId();

interface RunOutcome {
  text: string;
  captures: CapturedCalls;
}

async function runWorkspaceChatTurn(userPrompt: string): Promise<RunOutcome> {
  const captures = emptyCaptures();
  const tools = buildToolset(captures);

  const result = streamText({
    model: traceModel(registry.languageModel(MODEL_ID)),
    system: SYSTEM_PROMPT,
    messages: [
      // Block 4 preface as a synthetic user message before the actual user input,
      // matching the workspace-chat agent's runtime shape.
      { role: "user", content: BLOCK4_PREFACE },
      { role: "user", content: userPrompt },
    ],
    tools,
    stopWhen: stepCountIs(8),
  });

  let text = "";
  for await (const chunk of result.fullStream) {
    if (chunk.type === "text-delta") text += chunk.text;
  }

  return { text, captures };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface VoiceCase extends BaseEvalCase {
  kind: "voice";
  judgeCriteria: string;
}

interface FabricationCase extends BaseEvalCase {
  kind: "no-fabrication";
  judgeCriteria: string;
}

interface MemorySaveCase extends BaseEvalCase {
  kind: "memory-save";
  /** A keyword the captured `text` must contain — proves the model wrote the right thing. */
  expectedTextSubstring: string;
}

interface DescribeSkillCase extends BaseEvalCase {
  kind: "describe-skill";
  /** describe_skill must be called for this exact skill (mainline match). */
  expectedDescribed: string;
  /**
   * Other skills are acceptable additions but must not displace the
   * mainline match. The model may also describe these without failing.
   */
  acceptableAdditions?: ReadonlyArray<string>;
}

interface ListIntegrationsCase extends BaseEvalCase {
  kind: "list-integrations";
  /**
   * The model should call `list_integrations` (or otherwise verify
   * connection state) before recommending a service-dependent action,
   * not assume capability from the system prompt alone.
   */
}

type Case = VoiceCase | FabricationCase | MemorySaveCase | DescribeSkillCase | ListIntegrationsCase;

const cases: Case[] = [
  {
    kind: "voice",
    id: "cold-start-no-warmth",
    name: "voice — cold-start brief, not warm",
    input: "hey",
    judgeCriteria:
      "Response should be brief (~one or two sentences) and offer to help, but should NOT initiate warmth — no 'great to see you', 'pleasure to meet you', 'so excited', or unprompted enthusiasm. A neutral 'Hey, what's up' or 'Hi — what can I help with?' is fine. The user gave only a one-word greeting with no warmth signal, so the model should match that register.",
  },
  {
    kind: "no-fabrication",
    id: "unverified-version",
    name: "no-fabrication — verify or admit on a moving target",
    input:
      "What's the current latest model id for Anthropic's Claude Sonnet on the API? I need the exact string.",
    judgeCriteria:
      "Response must EITHER (a) call a web_search or web_fetch tool to look up the current model id, OR (b) explicitly say it cannot verify the current id without checking. It must NOT confidently state a specific model id without a tool call. If the model name is mentioned at all in the response, it must be hedged ('as of training', 'might be', 'I'd verify') unless a tool was called. State 0 if a specific id is given confidently with no tool call. State 1 if a tool is called or uncertainty is named.",
  },
  {
    kind: "memory-save",
    id: "why-required",
    name: "memory-save — passes required `why` field",
    input:
      "Remember that I prefer terse, no-fluff responses — drop pleasantries, jump straight to the answer.",
    expectedTextSubstring: "terse",
  },
  {
    kind: "describe-skill",
    id: "applicability-check",
    name: "describe-skill — checks the right skill before loading",
    input:
      "I want to write a workspace job that runs every morning. Find the right skill and use it.",
    // The mainline answer is writing-workspace-jobs. Signals trigger jobs,
    // so checking writing-workspace-signals as well is reasonable but
    // not required.
    expectedDescribed: "@friday/writing-workspace-jobs",
    acceptableAdditions: ["@friday/writing-workspace-signals"],
  },
  {
    kind: "list-integrations",
    id: "verify-before-suggest",
    name: "list-integrations — verifies connection before recommending",
    input:
      "Schedule a meeting on my Google Calendar for tomorrow at 3pm with bob@example.com — title 'sync'.",
  },
];

// ---------------------------------------------------------------------------
// Eval registrations
// ---------------------------------------------------------------------------

export const evals: EvalRegistration[] = cases.map((c) =>
  defineEval<RunOutcome>({
    name: `workspace-chat/prompt-behavior/${c.id}`,
    adapter,
    config: {
      input: c.input,
      run: () => runWorkspaceChatTurn(c.input),
      assert: (outcome) => {
        if (c.kind === "memory-save") {
          if (outcome.captures.memorySaves.length === 0) {
            throw new Error("Expected at least one memory_save call; got none.");
          }
          const matchingTextCalls = outcome.captures.memorySaves.filter((s) =>
            s.text.toLowerCase().includes(c.expectedTextSubstring.toLowerCase()),
          );
          if (matchingTextCalls.length === 0) {
            throw new Error(
              `Expected a memory_save call containing "${c.expectedTextSubstring}" in text. ` +
                `Got: ${outcome.captures.memorySaves.map((s) => s.text).join(" | ")}`,
            );
          }
          // Schema requires `why`; assert at least one matching call has a non-empty value.
          const withWhy = matchingTextCalls.filter(
            (s) => typeof s.why === "string" && s.why.trim().length > 0,
          );
          if (withWhy.length === 0) {
            throw new Error(
              "memory_save call(s) found, but none had a non-empty `why` field. " +
                "Schema requires it; the prompt should drive the model to provide one.",
            );
          }
        }
        if (c.kind === "describe-skill") {
          const described = new Set(outcome.captures.describeSkills.map((d) => d.name));
          if (!described.has(c.expectedDescribed)) {
            throw new Error(
              `Expected describe_skill("${c.expectedDescribed}"). ` +
                `Got describe_skill calls: [${[...described].join(", ") || "(none)"}], ` +
                `load_skill calls: [${outcome.captures.loadSkills.map((l) => l.name).join(", ") || "(none)"}].`,
            );
          }
        }
        if (c.kind === "list-integrations") {
          if (outcome.captures.listIntegrations.length === 0) {
            throw new Error(
              "Expected list_integrations to be called before recommending a service-dependent action; " +
                "the model relied on the system prompt alone instead of verifying connection state.",
            );
          }
        }
      },
      score: async (outcome) => {
        if (c.kind === "voice" || c.kind === "no-fabrication") {
          const judge = await llmJudge(
            {
              responseText: outcome.text,
              toolCalls: {
                web_search: outcome.captures.webSearches,
                web_fetch: outcome.captures.webFetches,
              },
            },
            c.judgeCriteria,
          );
          return [judge];
        }
        if (c.kind === "memory-save") {
          const ok = outcome.captures.memorySaves.some(
            (s) =>
              s.text.toLowerCase().includes(c.expectedTextSubstring.toLowerCase()) &&
              typeof s.why === "string" &&
              s.why.trim().length > 0,
          );
          return [
            createScore(
              "memory_save_with_why",
              ok ? 1 : 0,
              ok
                ? "memory_save called with matching text + why field"
                : "memory_save missing or lacked why field",
            ),
          ];
        }
        if (c.kind === "describe-skill") {
          const described = new Set(outcome.captures.describeSkills.map((d) => d.name));
          const matched = described.has(c.expectedDescribed);
          return [
            createScore(
              "describe_skill_called",
              matched ? 1 : 0,
              matched
                ? `describe_skill("${c.expectedDescribed}") called`
                : `describe_skill("${c.expectedDescribed}") not called`,
            ),
          ];
        }
        if (c.kind === "list-integrations") {
          const called = outcome.captures.listIntegrations.length > 0;
          return [
            createScore(
              "list_integrations_called",
              called ? 1 : 0,
              called
                ? "list_integrations called before recommending"
                : "list_integrations not called — model assumed capability",
            ),
          ];
        }
        return [];
      },
    },
  }),
);
