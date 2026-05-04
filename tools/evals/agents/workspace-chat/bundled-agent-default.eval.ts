// deno-lint-ignore-file require-await
// AI SDK v6's `tool({ execute })` types the callback as returning a Promise,
// so the mock executes here are structurally `async` even though their bodies
// are pure synchronous fixture code. File-level disable keeps the per-callback
// surface clean.

/**
 * Bundled-agent default behavior — anti-regression eval.
 *
 * Gate test for the bundled-agent discovery workstream (tasks #30-#37). Verifies
 * that for canonical user prompts, the workspace-chat LLM emits `upsert_agent`
 * calls with `type: "atlas"` and the appropriate bundled `agent` id (web,
 * email, slack) — instead of falling back to `type: "llm"` plus an MCP server.
 *
 * Why an eval, not a unit test: the assertion is on the LLM's *judgment* given
 * the SKILL/description signals the workstream landed. A mock-LLM unit test
 * would pass even if those signals shipped no information; only a real-model
 * run actually exercises that decision.
 *
 * Why a synthesized harness, not the real workspace-chat handler: the handler
 * pulls in the daemon HTTP client, ChatStorage, and MCP discovery — none of
 * which are headlessly invokable. We reproduce just the signals the LLM sees:
 *
 * - The actual `prompt.txt` system prompt
 * - The actual `workspace-api/SKILL.md` content (returned by the `load_skill`
 *   tool)
 * - The actual `upsert_agent` tool description (which the workstream rewrote
 *   to enumerate atlas/user/llm shapes)
 * - The `list_capabilities` tool returning the real bundled-agent set plus a
 *   synthetic MCP catalog (playwright-mcp, smtp-mcp, slack-mcp) so the LLM has
 *   a meaningful choice between bundled and MCP-as-tool
 *
 * Tool execute() functions capture the LLM's calls and return synthetic
 * success — we assert on the captured tool-call shapes, not the bytes returned.
 *
 * ## Manual repro against a real daemon
 *
 * The same scenario can be reproduced end-to-end against a running daemon:
 *
 *   deno task atlas daemon start --detached
 *   deno task atlas prompt "I want a workspace that scrapes the top headlines from Hacker News every morning"
 *   # Inspect the chat transcript and confirm:
 *   #   - upsert_agent was called with config.type === "atlas" and config.agent === "web"
 *   #   - enable_mcp_server was NOT called for playwright-mcp / puppeteer-mcp
 *   deno task atlas daemon stop
 *
 * That repro is the integration-test path against a real daemon — not
 * automated here because it needs a real workspace, real credentials, and
 * real LLM cost. The eval below is the closest CI-runnable approximation.
 */

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";
import { bundledAgents } from "@atlas/bundled-agents";
import {
  buildRegistryModelId,
  isRegistryProvider,
  type RegistryModelId,
  registry,
  traceModel,
} from "@atlas/llm";
import { getFridayHome } from "@atlas/utils/paths.server";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import dotenv from "dotenv";
import { z } from "zod";
import { AgentContextAdapter } from "../../lib/context.ts";
import { type BaseEvalCase, defineEval, type EvalRegistration } from "../../lib/registration.ts";
import { createScore } from "../../lib/scoring.ts";

// This eval only needs an inference key — no bundled-agent credentials. Skip
// `loadCredentials()` (which requires FRIDAY_KEY for the gateway fetch) and
// load just the dotenv files. ANTHROPIC_API_KEY is the minimum.
dotenv.config();
const globalAtlasEnv = join(getFridayHome(), ".env");
if (existsSync(globalAtlasEnv)) {
  dotenv.config({ path: globalAtlasEnv, override: true });
}
if (!process.env.ANTHROPIC_API_KEY) {
  throw new Error("ANTHROPIC_API_KEY is required to run workspace-chat evals");
}

const adapter = new AgentContextAdapter();

// ---------------------------------------------------------------------------
// Source-of-truth content loaded from the live tree
// ---------------------------------------------------------------------------

const ROOT = resolve(import.meta.dirname ?? ".", "../../../..");

const WORKSPACE_CHAT_PROMPT = await readFile(
  resolve(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
  "utf8",
);

const WORKSPACE_API_SKILL = await readFile(
  resolve(ROOT, "packages/system/skills/workspace-api/SKILL.md"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Synthesized session sections — match what workspace-chat assembles at runtime
// ---------------------------------------------------------------------------

const WORKSPACE_SECTION = `<workspace id="ws-eval" name="eval-workspace">
<description>Empty workspace used by the bundled-agent-default eval.</description>
</workspace>`;

const AVAILABLE_SKILLS_SECTION = `<available_skills>
<instruction>Load skills with load_skill when task matches.</instruction>
<skill name="@friday/workspace-api">Create, list, update, delete, and clean up workspaces via the daemon HTTP API. Use when the user asks to create, edit, delete, or list workspaces.</skill>
</available_skills>`;

const SYSTEM_PROMPT = [WORKSPACE_CHAT_PROMPT, WORKSPACE_SECTION, AVAILABLE_SKILLS_SECTION].join(
  "\n\n",
);

// ---------------------------------------------------------------------------
// Synthetic MCP catalog — gives the LLM a real choice between bundled and MCP
// ---------------------------------------------------------------------------

interface SyntheticMCP {
  id: string;
  description: string;
  provider: string;
  requiresConfig: string[];
}

const SYNTHETIC_MCP_CATALOG: SyntheticMCP[] = [
  {
    id: "playwright-mcp",
    description:
      "Playwright browser automation MCP — drive a real browser to scrape JS-rendered pages.",
    provider: "playwright-mcp",
    requiresConfig: [],
  },
  {
    id: "puppeteer-mcp",
    description:
      "Puppeteer browser automation MCP — Chromium control for scraping and form-filling.",
    provider: "puppeteer-mcp",
    requiresConfig: [],
  },
  {
    id: "smtp-mcp",
    description:
      "SMTP email transport MCP — send transactional email via a configured SMTP server.",
    provider: "smtp-mcp",
    requiresConfig: ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"],
  },
  {
    id: "slack-mcp",
    description: "Slack messaging MCP — post messages, read channel history, manage threads.",
    provider: "slack-mcp",
    requiresConfig: ["SLACK_BOT_TOKEN"],
  },
];

// ---------------------------------------------------------------------------
// Captured tool-call types — the eval's primary observation
// ---------------------------------------------------------------------------

interface CapturedUpsertAgent {
  id: string;
  config: { type?: string; agent?: string } & Record<string, unknown>;
  workspaceId?: string;
}

interface CapturedEnableMcp {
  serverId: string;
}

interface CapturedToolCalls {
  upsertAgents: CapturedUpsertAgent[];
  enabledMcpServers: CapturedEnableMcp[];
  loadedSkills: string[];
  listCapabilitiesCallCount: number;
}

function emptyCaptures(): CapturedToolCalls {
  return {
    upsertAgents: [],
    enabledMcpServers: [],
    loadedSkills: [],
    listCapabilitiesCallCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Tool factory — builds a real tool surface mirroring workspace-chat
// ---------------------------------------------------------------------------

/**
 * Real tool description string from
 * `packages/system/agents/workspace-chat/tools/upsert-tools.ts`'s
 * `createBoundUpsertTools`. Kept verbatim so the eval exercises the same
 * description bytes a live workspace-chat session would.
 */
const UPSERT_AGENT_DESCRIPTION =
  "Upsert an agent into the current workspace's draft (or live config if no draft). " +
  "The `config` field's shape depends on `config.type`:\n\n" +
  '- `type: "llm"` — inline LLM agent. Shape: ' +
  "`{ type, description, config: { provider, model, prompt, tools? } }`. " +
  'Use when the work is open-ended ("figure out what to do") and no bundled agent fits.\n' +
  '- `type: "atlas"` — bundled platform agent (web, email, slack, gh, etc.). Shape: ' +
  "`{ type, agent, description, prompt, config?, env? }`. " +
  "Does not accept a `tools` array — the bundled agent is a self-contained black box. " +
  'If you need to call MCP tools, use `type: "llm"`. ' +
  "Discover available `agent` ids by calling `list_capabilities` first. " +
  "The `prompt` is task-specific context layered on the agent's bundled behavior — " +
  "describe the user's intent, not the mechanics. " +
  "Use when a bundled agent fits the task domain — this should be your default for " +
  "web scraping, email sending, Slack messaging, GitHub ops, image generation, " +
  "data analysis, and similar.\n" +
  '- `type: "user"` — registered Python/TS SDK code agent. Shape: ' +
  "`{ type, agent, prompt?, env? }`. " +
  "Use when the work is mechanical (parsing, transforming, deterministic routing) " +
  "or when LLM-loop cost dominates the value. See `writing-friday-python-agents` skill.\n\n" +
  "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing. " +
  "Pass `workspaceId` to target a workspace other than the current session.";

/** Same JSON schema shape used by `tools/upsert-tools.ts`. */
const UPSERT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    id: { type: "string" as const, description: "Unique identifier for the entity" },
    config: {
      type: "object" as const,
      description: "Entity configuration object",
      additionalProperties: true,
    },
    workspaceId: { type: "string" as const, description: "Optional target workspace" },
  },
  required: ["id", "config"],
};

const UpsertConfigSchema = z
  .object({ type: z.string().optional(), agent: z.string().optional() })
  .catchall(z.unknown());

const UpsertInputSchema = z.object({
  id: z.string(),
  config: UpsertConfigSchema,
  workspaceId: z.string().optional(),
});

// Hoisted Zod schemas — `ai`'s `tool()` overload resolution narrows to never
// when given an inline `z.object(...)` (Zod v4 + AI SDK v6 quirk). Pulling
// the schema to a const sidesteps it.
const LoadSkillInputSchema = z.object({
  name: z.string().describe("Skill name from <available_skills>"),
  reason: z.string().optional(),
});

const ListCapabilitiesInputSchema = z.object({ workspaceId: z.string().optional() });

const EnableMcpServerInputSchema = z.object({
  serverId: z.string(),
  workspaceId: z.string().optional(),
});

const SearchMcpServersInputSchema = z.object({ query: z.string() });

const CreateWorkspaceInputSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
});

const WorkspaceIdOnlyInputSchema = z.object({ workspaceId: z.string().optional() });

function buildBundledCapabilityList() {
  return bundledAgents
    .map((a) => ({
      kind: "bundled" as const,
      id: a.metadata.id,
      description: a.metadata.description,
      examples: a.metadata.expertise.examples,
      constraints: a.metadata.constraints,
      requiresConfig: [],
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function buildToolset(captures: CapturedToolCalls) {
  return {
    load_skill: tool({
      description:
        "Load skill instructions BEFORE starting a task that matches a skill's description. " +
        "Skills contain step-by-step guidance you should follow. Check <available_skills> — " +
        "if your task matches, load the skill first.",
      inputSchema: LoadSkillInputSchema,
      execute: async ({ name }) => {
        captures.loadedSkills.push(name);
        if (name === "@friday/workspace-api") {
          return {
            name: "@friday/workspace-api",
            description: "Workspace authoring guide.",
            instructions: WORKSPACE_API_SKILL,
          } as const;
        }
        return { error: `Skill "${name}" not found.` } as const;
      },
    }),

    list_capabilities: tool({
      description:
        "List every capability available to this workspace: bundled atlas agents (web, email, " +
        "slack, gh, etc.), enabled MCP servers, and MCP servers in the platform catalog. " +
        "Output is bundled-first, alphabetical within each kind. Scan top-down and pick the " +
        "first match — bundled agents are zero-config and should be your default when the " +
        "domain fits. Each entry carries `requiresConfig` (env keys / credentials still needed " +
        "to function); bundled entries also carry `examples` and `constraints`.",
      inputSchema: ListCapabilitiesInputSchema,
      execute: async () => {
        captures.listCapabilitiesCallCount++;
        const bundled = buildBundledCapabilityList();
        const mcpAvailable = SYNTHETIC_MCP_CATALOG.map((m) => ({
          kind: "mcp_available" as const,
          id: m.id,
          description: m.description,
          provider: m.provider,
          requiresConfig: m.requiresConfig,
        })).sort((a, b) => a.id.localeCompare(b.id));
        return { capabilities: [...bundled, ...mcpAvailable] };
      },
    }),

    enable_mcp_server: tool({
      description:
        "Enable an MCP server in this workspace's `tools.mcp.servers` block so its tools " +
        "become available to agents. Only call this when no bundled atlas agent covers the " +
        "domain (use `list_capabilities` to check first).",
      inputSchema: EnableMcpServerInputSchema,
      execute: async ({ serverId }) => {
        captures.enabledMcpServers.push({ serverId });
        return { ok: true, serverId };
      },
    }),

    search_mcp_servers: tool({
      description:
        "Search the MCP server catalog by keyword. Returns a ranked list of candidate " +
        "servers with descriptions. Use for catalog browsing only — for full discovery call " +
        "`list_capabilities` instead.",
      inputSchema: SearchMcpServersInputSchema,
      execute: async ({ query }) => {
        const q = query.toLowerCase();
        const matches = SYNTHETIC_MCP_CATALOG.filter(
          (m) => m.id.includes(q) || m.description.toLowerCase().includes(q),
        );
        return { servers: matches };
      },
    }),

    create_workspace: tool({
      description:
        "Create a new empty workspace. Returns `{ workspace: { id, name } }`. Pass the " +
        "returned `id` as `workspaceId` to subsequent draft / upsert tools.",
      inputSchema: CreateWorkspaceInputSchema,
      execute: async ({ name }) => ({
        workspace: { id: `ws-${name.toLowerCase().replace(/\s+/g, "-")}`, name },
      }),
    }),

    begin_draft: tool({
      description: "Begin a draft of the workspace config for atomic multi-entity edits.",
      inputSchema: WorkspaceIdOnlyInputSchema,
      execute: async () => ({ ok: true }),
    }),

    upsert_agent: tool({
      description: UPSERT_AGENT_DESCRIPTION,
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async (rawInput: unknown) => {
        const parsed = UpsertInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return {
            ok: false,
            diff: {},
            structural_issues: null,
            error: `Invalid upsert_agent input: ${parsed.error.message}`,
          };
        }
        captures.upsertAgents.push({
          id: parsed.data.id,
          config: parsed.data.config,
          workspaceId: parsed.data.workspaceId,
        });
        return { ok: true, diff: {}, structural_issues: null };
      },
    }),

    upsert_signal: tool({
      description: "Upsert a signal into the workspace draft. See workspace-api skill.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    upsert_job: tool({
      description: "Upsert a job into the workspace draft. See workspace-api skill.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    validate_workspace: tool({
      description: "Validate the workspace draft. Returns errors[] and warnings[].",
      inputSchema: WorkspaceIdOnlyInputSchema,
      execute: async () => ({ ok: true, errors: [], warnings: [] }),
    }),

    publish_draft: tool({
      description: "Publish the workspace draft to the live config.",
      inputSchema: WorkspaceIdOnlyInputSchema,
      execute: async () => ({ ok: true }),
    }),
  };
}

// ---------------------------------------------------------------------------
// Run helper — wires streamText with the canonical workspace-chat surface
// ---------------------------------------------------------------------------

/**
 * Model id used by workspace-chat's primary path. Override with
 * `WORKSPACE_CHAT_EVAL_MODEL` (`provider:model` form) to compare candidates.
 */
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
    throw new Error(
      `WORKSPACE_CHAT_EVAL_MODEL has unknown provider "${provider}". ` +
        `Expected one of: anthropic, claude-code, google, groq, openai.`,
    );
  }
  return buildRegistryModelId(provider, model);
}

const MODEL_ID = resolveModelId();

interface RunOutcome {
  captures: CapturedToolCalls;
}

async function runWorkspaceChatTurn(userPrompt: string): Promise<RunOutcome> {
  const captures = emptyCaptures();
  const tools = buildToolset(captures);

  const result = streamText({
    model: traceModel(registry.languageModel(MODEL_ID)),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
    tools,
    stopWhen: stepCountIs(12),
  });

  // Drain the stream so tool calls resolve before the function returns.
  for await (const _chunk of result.fullStream) {
    // No-op: we only care about the captured aggregates.
  }

  return { captures };
}

// ---------------------------------------------------------------------------
// Trace inspection helpers — for scoring
// ---------------------------------------------------------------------------

const BROWSER_MCP_IDS = new Set(["playwright-mcp", "puppeteer-mcp", "browser-mcp"]);

function findUpsertWithType(captures: CapturedToolCalls, type: string, agent?: string) {
  return captures.upsertAgents.find(
    (u) => u.config.type === type && (agent === undefined || u.config.agent === agent),
  );
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface BundledAgentCase extends BaseEvalCase {
  /** Required `type` literal in the upsert_agent call. */
  expectedType: "atlas";
  /** Expected bundled `agent` id (`web`, `slack`). */
  expectedAgent: string;
  /** MCP server ids the LLM must NOT enable for this case. Empty = no constraint. */
  forbiddenMcpIds: ReadonlySet<string>;
}

const cases: BundledAgentCase[] = [
  {
    id: "scrape-hacker-news",
    name: "scrape - daily Hacker News headlines",
    input: "I want a workspace that scrapes the top headlines from Hacker News every morning.",
    expectedType: "atlas",
    expectedAgent: "web",
    forbiddenMcpIds: BROWSER_MCP_IDS,
  },
  {
    id: "slack-daily-standup",
    name: "slack - post daily standup",
    input: "I want a workspace that posts a daily standup to Slack.",
    expectedType: "atlas",
    expectedAgent: "slack",
    forbiddenMcpIds: new Set<string>(),
  },
];

interface SmokeCase extends BaseEvalCase {
  /** At least one upsert_agent call must use `type: "atlas"`. */
  requireAnyAtlas: true;
}

const smokeCase: SmokeCase = {
  id: "fetch-and-summarize",
  name: "smoke - fetch URL daily and summarize",
  input: "Build a workspace that fetches a URL daily and summarizes the content.",
  requireAnyAtlas: true,
};

// ---------------------------------------------------------------------------
// Eval registrations
// ---------------------------------------------------------------------------

const targetedEvals: EvalRegistration[] = cases.map((testCase) =>
  defineEval<RunOutcome>({
    name: `workspace-chat/bundled-agent-default/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: () => runWorkspaceChatTurn(testCase.input),
      assert: ({ captures }) => {
        const matched = findUpsertWithType(captures, testCase.expectedType, testCase.expectedAgent);
        if (!matched) {
          const summary = captures.upsertAgents
            .map((u) => `${u.id}(type=${u.config.type ?? "?"}, agent=${u.config.agent ?? "?"})`)
            .join(", ");
          throw new Error(
            `Expected an upsert_agent call with type="${testCase.expectedType}", ` +
              `agent="${testCase.expectedAgent}". ` +
              `Got: ${captures.upsertAgents.length === 0 ? "no upsert_agent calls" : `[${summary}]`}`,
          );
        }
        const forbiddenEnabled = captures.enabledMcpServers.filter((e) =>
          testCase.forbiddenMcpIds.has(e.serverId),
        );
        if (forbiddenEnabled.length > 0) {
          throw new Error(
            `LLM enabled forbidden MCP server(s) ${forbiddenEnabled
              .map((e) => e.serverId)
              .join(", ")} when bundled agent "${testCase.expectedAgent}" should have been used.`,
          );
        }
      },
      score: ({ captures }) => {
        const matched = findUpsertWithType(captures, testCase.expectedType, testCase.expectedAgent);
        const correctShape = matched !== undefined;
        const forbiddenEnabled = captures.enabledMcpServers.some((e) =>
          testCase.forbiddenMcpIds.has(e.serverId),
        );
        return [
          createScore(
            "bundled-agent-chosen",
            correctShape ? 1 : 0,
            correctShape
              ? `upsert_agent emitted with type="${testCase.expectedType}", agent="${testCase.expectedAgent}"`
              : `expected type="${testCase.expectedType}" agent="${testCase.expectedAgent}", got ${captures.upsertAgents.length} upserts`,
          ),
          createScore(
            "no-redundant-mcp-enable",
            forbiddenEnabled ? 0 : 1,
            forbiddenEnabled
              ? `enabled MCP servers: ${captures.enabledMcpServers.map((e) => e.serverId).join(", ")}`
              : "no forbidden MCP servers enabled",
          ),
          createScore(
            "called-list-capabilities",
            captures.listCapabilitiesCallCount > 0 ? 1 : 0,
            `list_capabilities called ${captures.listCapabilitiesCallCount} time(s)`,
          ),
        ];
      },
      metadata: {
        case: testCase.id,
        expectedType: testCase.expectedType,
        expectedAgent: testCase.expectedAgent,
        forbiddenMcpIds: [...testCase.forbiddenMcpIds],
        model: MODEL_ID,
      },
    },
  }),
);

const smokeEval: EvalRegistration = defineEval<RunOutcome>({
  name: `workspace-chat/bundled-agent-default/${smokeCase.id}`,
  adapter,
  config: {
    input: smokeCase.input,
    run: () => runWorkspaceChatTurn(smokeCase.input),
    assert: ({ captures }) => {
      const anyAtlas = captures.upsertAgents.some((u) => u.config.type === "atlas");
      if (!anyAtlas) {
        const summary = captures.upsertAgents
          .map((u) => `${u.id}(type=${u.config.type ?? "?"})`)
          .join(", ");
        throw new Error(
          `Expected at least one upsert_agent call with type="atlas". ` +
            `Got: ${captures.upsertAgents.length === 0 ? "no upsert_agent calls" : `[${summary}]`}`,
        );
      }
    },
    score: ({ captures }) => {
      const atlasCount = captures.upsertAgents.filter((u) => u.config.type === "atlas").length;
      const totalCount = captures.upsertAgents.length;
      return [
        createScore(
          "any-atlas",
          atlasCount > 0 ? 1 : 0,
          `${atlasCount}/${totalCount} upsert_agent calls used type="atlas"`,
        ),
      ];
    },
    metadata: { case: smokeCase.id, model: MODEL_ID },
  },
});

export const evals: EvalRegistration[] = [...targetedEvals, smokeEval];
