// deno-lint-ignore-file require-await
// Same AI SDK v6 + tool() execute() shape constraint as bundled-agent-default.eval.ts.

/**
 * Agent-type default behavior — anti-regression eval.
 *
 * Workspace-chat picks one of three agent types (`atlas`, `user`, `llm`) when
 * authoring a workspace.yml. Real chat transcripts show the choice is unstable:
 * the same user prompt produces opposite outcomes across sessions, and the
 * skill's precedence rule ("atlas → user → llm fallback") doesn't actually
 * drive the decision in either direction.
 *
 * This eval captures the failure surface across three cases:
 *   - "inbox triage" → should be `type: llm` with gmail MCP. Categorization
 *     is the work; tool dispatch (apply user's letter choice → call gmail
 *     tool) is one MCP call per option, no Python required. Real failure shape:
 *     workspaces ended up with `type: user` Python agents fighting JSON
 *     parsing of LLM output.
 *   - "CSV streaming ingest" → should be `type: user`. Streaming a 50MB CSV
 *     and writing rows to SQLite genuinely needs Python (LLM context can't
 *     hold the file; per-row LLM calls are absurd). Failure: `type: llm`
 *     attempts to swallow the whole file and truncates.
 *   - "code generation from natural-language descriptions" → should be
 *     `type: llm` with `write_file`. Single-file script generation does not
 *     earn `agent_claude-code` delegation; the bundled coding agent earns it
 *     for multi-file refactor / iterative compilation, not one-shot scripts.
 *
 * The eval baselines the current skill behavior. Iteration on
 * `workspace-api/SKILL.md` and the workspace-chat prompt is gated on these
 * scores actually moving.
 *
 * ## Manual repro against a real daemon
 *
 *   deno task atlas daemon start --detached
 *   deno task atlas prompt "<one of the case inputs below>"
 *   # Inspect the chat transcript: confirm upsert_agent's config.type matches expected.
 *   deno task atlas daemon stop
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

const WRITING_FRIDAY_AGENTS_SKILL = await readFile(
  resolve(ROOT, "packages/system/skills/writing-friday-agents/SKILL.md"),
  "utf8",
);

// ---------------------------------------------------------------------------
// Synthesized session sections
// ---------------------------------------------------------------------------

const WORKSPACE_SECTION = `<workspace id="ws-eval" name="eval-workspace">
<description>Empty workspace used by the agent-type-default eval.</description>
</workspace>`;

const AVAILABLE_SKILLS_SECTION = `<available_skills>
<instruction>Load skills with load_skill when task matches.</instruction>
<skill name="@friday/workspace-api">Create, list, update, delete, and clean up workspaces via the daemon HTTP API. Use when the user asks to create, edit, delete, or list workspaces.</skill>
<skill name="@friday/writing-friday-agents">Write, edit, or debug a Friday agent using the friday_agent_sdk Python SDK. Use when creating a new Python user agent.</skill>
</available_skills>`;

const SYSTEM_PROMPT = [WORKSPACE_CHAT_PROMPT, WORKSPACE_SECTION, AVAILABLE_SKILLS_SECTION].join(
  "\n\n",
);

// ---------------------------------------------------------------------------
// Synthetic MCP catalog — extended with gmail / calendar so the LLM has a
// realistic choice for the inbox + briefing cases.
// ---------------------------------------------------------------------------

interface SyntheticMCP {
  id: string;
  description: string;
  provider: string;
  requiresConfig: string[];
}

const SYNTHETIC_MCP_CATALOG: SyntheticMCP[] = [
  {
    id: "google-gmail",
    description:
      "Gmail MCP — search, read, and modify Gmail messages (archive, trash, mark unread, label).",
    provider: "google-gmail",
    requiresConfig: ["GMAIL_OAUTH_TOKEN"],
  },
  {
    id: "google-calendar",
    description: "Google Calendar MCP — read, create, and update calendar events.",
    provider: "google-calendar",
    requiresConfig: ["GOOGLE_OAUTH_TOKEN"],
  },
  {
    id: "playwright-mcp",
    description:
      "Playwright browser automation MCP — drive a real browser to scrape JS-rendered pages.",
    provider: "playwright-mcp",
    requiresConfig: [],
  },
  {
    id: "smtp-mcp",
    description:
      "SMTP email transport MCP — send transactional email via a configured SMTP server.",
    provider: "smtp-mcp",
    requiresConfig: ["SMTP_HOST", "SMTP_USER", "SMTP_PASSWORD"],
  },
];

// ---------------------------------------------------------------------------
// Captured tool calls — the eval's primary observation
// ---------------------------------------------------------------------------

interface CapturedUpsertAgent {
  id: string;
  config: { type?: string; agent?: string } & Record<string, unknown>;
  workspaceId?: string;
}

interface CapturedToolCalls {
  upsertAgents: CapturedUpsertAgent[];
  enabledMcpServers: string[];
  loadedSkills: string[];
  registeredUserAgentEntrypoints: string[];
  listCapabilitiesCallCount: number;
}

function emptyCaptures(): CapturedToolCalls {
  return {
    upsertAgents: [],
    enabledMcpServers: [],
    loadedSkills: [],
    registeredUserAgentEntrypoints: [],
    listCapabilitiesCallCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Tool factory — mirrors bundled-agent-default.eval.ts so the LLM sees the
// same tool surface workspace-chat would, plus a stub for agent registration.
// ---------------------------------------------------------------------------

const UPSERT_AGENT_DESCRIPTION =
  "Upsert an agent into the current workspace's draft (or live config if no draft). " +
  "The `config` field's shape depends on `config.type`:\n\n" +
  '- `type: "llm"` — inline LLM agent. Shape: ' +
  "`{ type, description, config: { provider, model, prompt, tools? } }`. " +
  'Use when the work is open-ended ("figure out what to do") and no bundled agent fits.\n' +
  '- `type: "atlas"` — bundled platform agent (web, slack, gh, etc.). Shape: ' +
  "`{ type, agent, description, prompt, config?, env? }`. " +
  "Does not accept a `tools` array — the bundled agent is a self-contained black box and " +
  "does NOT invoke MCP tools. Each atlas agent is tightly scope-limited — some are " +
  "outbound-only (e.g. message senders), some are read-only (e.g. scrapers), and none " +
  "maintain authenticated session state across calls. " +
  "Before picking `type: atlas`, call `list_capabilities` and verify the agent's " +
  "`constraints` field covers the user's intent end-to-end. If the user's task crosses " +
  "a constraint — mutating state the agent only reads, needing a specific MCP tool, or " +
  'operating on a provider the agent does not ship support for — use `type: "llm"` ' +
  "with the right MCP server enabled instead. The `prompt` is task-specific context " +
  "layered on the agent's bundled behavior — describe the user's intent, not the mechanics.\n" +
  '- `type: "user"` — registered Python/TS SDK code agent. Shape: ' +
  "`{ type, agent, prompt?, env? }`. " +
  "Use ONLY when the per-call decision is mechanical: regex/schema validation, " +
  "deterministic routing table, format conversion, fixed dispatch. " +
  "If the agent calls `ctx.llm.generate` to make any decision (classifying, " +
  'summarizing, choosing among options, scoring confidence), use `type: "llm"` ' +
  "instead — the LLM judgment belongs in an inline llm agent with MCP tools, " +
  "not buried inside Python. See `writing-friday-agents` skill.\n\n" +
  "Returns `{ ok, diff, structural_issues }` so you can confirm what changed before publishing. " +
  "Pass `workspaceId` to target a workspace other than the current session.";

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

const RunCodeInputSchema = z.object({ language: z.string(), source: z.string() });

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
        if (name === "@friday/writing-friday-agents") {
          return {
            name: "@friday/writing-friday-agents",
            description: "Python agent authoring guide.",
            instructions: WRITING_FRIDAY_AGENTS_SKILL,
          } as const;
        }
        return { error: `Skill "${name}" not found.` } as const;
      },
    }),

    list_capabilities: tool({
      description:
        "List every capability available to this workspace: bundled atlas agents, enabled MCP " +
        "servers, and MCP servers in the platform catalog. Output is bundled-first, alphabetical.",
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
      description: "Enable an MCP server in this workspace's `tools.mcp.servers` block.",
      inputSchema: EnableMcpServerInputSchema,
      execute: async ({ serverId }) => {
        captures.enabledMcpServers.push(serverId);
        return { ok: true, serverId };
      },
    }),

    search_mcp_servers: tool({
      description: "Search the MCP server catalog by keyword.",
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
      description: "Create a new empty workspace. Returns `{ workspace: { id, name } }`.",
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
      description: "Upsert a signal into the workspace draft.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    upsert_job: tool({
      description: "Upsert a job into the workspace draft.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    upsert_memory_own: tool({
      description: "Upsert a memory store the workspace owns.",
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

    list_mcp_tools: tool({
      description: "List the tools an enabled MCP server exposes.",
      inputSchema: z.object({ serverId: z.string() }),
      execute: async ({ serverId }) => ({
        serverId,
        tools: [
          { name: "search_messages", description: "Search messages.", inputSchema: {} },
          { name: "modify_message", description: "Modify a message.", inputSchema: {} },
        ],
      }),
    }),

    run_code: tool({
      description:
        "Run a code snippet in an ephemeral sandbox. Used for ad-hoc shell calls and registering " +
        "user agents via curl to the daemon.",
      inputSchema: RunCodeInputSchema,
      execute: async ({ source }) => {
        // Detect agent registrations so the eval can score on whether Friday
        // chose to write a Python agent at all.
        const entrypointMatch = source.match(/"entrypoint":\s*"([^"]+)"/);
        if (entrypointMatch?.[1]) {
          captures.registeredUserAgentEntrypoints.push(entrypointMatch[1]);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
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
    // Higher step budget than bundled-agent-default — workspace authoring
    // touches more tools (capabilities + skills + multi-agent + jobs + signals).
    stopWhen: stepCountIs(20),
  });

  for await (const _chunk of result.fullStream) {
    // No-op: we only care about captured aggregates.
  }

  return { captures };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

interface AgentTypeCase extends BaseEvalCase {
  /** Required `type` literal in at least one upsert_agent call. */
  expectedType: "llm" | "user" | "atlas";
  /** When `expectedType` is `"atlas"`, the bundled agent id. */
  expectedAgent?: string;
  /** Forbidden types for any upsert_agent call. */
  forbiddenTypes: ReadonlySet<string>;
  /**
   * Forbidden bundled agent ids — applies to any `type: atlas` upsert
   * regardless of whether `atlas` is in `forbiddenTypes`. Use this to forbid
   * a specific bundled agent that's a black-box wrong fit (e.g. the `email`
   * atlas agent for inbox triage — it sends, doesn't triage).
   */
  forbiddenAtlasAgents?: ReadonlySet<string>;
  /**
   * MCP servers that MUST be enabled. Catches the silent failure where Friday
   * picks the right type but doesn't wire the tools the agent needs to do
   * the actual work.
   */
  requiredMcpServers?: ReadonlySet<string>;
  /** If true, registering a user agent (POST /api/agents/register) fails the case. */
  forbidUserAgentRegistration: boolean;
}

const cases: AgentTypeCase[] = [
  {
    id: "inbox-triage-llm",
    name: "inbox triage — should be type: llm with gmail MCP",
    input:
      "Build me a workspace that pulls my latest 10 unread emails and reviews them with letter " +
      "options for Archive, Keep, Mark Unread, Delete, Unsubscribe. Remember my preferences " +
      "and apply them to future reviews.",
    expectedType: "llm",
    forbiddenTypes: new Set(["user"]),
    // The bundled `email` atlas agent SENDS email — it does not invoke MCP
    // tools and cannot archive/keep/delete via gmail. Using it for the
    // triage role is the silent-failure trap from the real Inbox Zero build.
    forbiddenAtlasAgents: new Set(["email"]),
    requiredMcpServers: new Set(["google-gmail"]),
    forbidUserAgentRegistration: true,
  },
  {
    id: "csv-streaming-user",
    name: "CSV streaming ingest — should be type: user (Python earns it)",
    input:
      "Build me a workspace that ingests 50MB CSV uploads, validates the row schema, and " +
      "streams the rows into a SQLite database. The schema is fixed — id, timestamp, payload.",
    expectedType: "user",
    forbiddenTypes: new Set(["llm", "atlas"]),
    forbidUserAgentRegistration: false,
  },
  {
    id: "code-gen-llm-not-claude-code",
    name: "code generation — should be type: llm, NOT atlas claude-code",
    input:
      "Build me a workspace that takes natural-language descriptions of small Python scripts " +
      "and writes the script files to a directory. Single-file scripts only — no projects.",
    expectedType: "llm",
    forbiddenTypes: new Set(["atlas"]),
    forbiddenAtlasAgents: new Set(["claude-code"]),
    forbidUserAgentRegistration: false,
  },
  {
    // Explicit-instruction case: real user prompt where Eric said "use llm
    // agents" and the model still emitted `type: user`. The prompt's
    // `<agent_types>` rule says explicit type instructions must be respected
    // unless structurally impossible — this case fails any session that
    // overrides the user's choice.
    id: "explicit-llm-override",
    name: "user explicitly names type: llm — must respect it",
    input:
      "Build me a workspace that pulls my latest 5 unread emails and lets me triage them " +
      "with letter options (Archive, Keep, Delete). Use llm agents for this — I do not want " +
      "Python user agents.",
    expectedType: "llm",
    forbiddenTypes: new Set(["user"]),
    requiredMcpServers: new Set(["google-gmail"]),
    forbidUserAgentRegistration: true,
  },
];

// ---------------------------------------------------------------------------
// Eval registrations
// ---------------------------------------------------------------------------

function findUpsertWithType(captures: CapturedToolCalls, type: string, agent?: string) {
  return captures.upsertAgents.find(
    (u) => u.config.type === type && (agent === undefined || u.config.agent === agent),
  );
}

function summarizeUpserts(captures: CapturedToolCalls): string {
  if (captures.upsertAgents.length === 0) return "no upsert_agent calls";
  return captures.upsertAgents
    .map((u) => `${u.id}(type=${u.config.type ?? "?"}, agent=${u.config.agent ?? "?"})`)
    .join(", ");
}

export const evals: EvalRegistration[] = cases.map((testCase) =>
  defineEval<RunOutcome>({
    name: `workspace-chat/agent-type-default/${testCase.id}`,
    adapter,
    config: {
      input: testCase.input,
      run: () => runWorkspaceChatTurn(testCase.input),
      assert: ({ captures }) => {
        const matched = findUpsertWithType(captures, testCase.expectedType, testCase.expectedAgent);
        if (!matched) {
          throw new Error(
            `Expected an upsert_agent call with type="${testCase.expectedType}"` +
              (testCase.expectedAgent ? `, agent="${testCase.expectedAgent}"` : "") +
              `. Got: ${summarizeUpserts(captures)}`,
          );
        }

        const wrongTypeUpserts = captures.upsertAgents.filter((u) =>
          testCase.forbiddenTypes.has(u.config.type ?? ""),
        );
        if (wrongTypeUpserts.length > 0) {
          throw new Error(
            `Forbidden agent type(s) used for this case: ` +
              wrongTypeUpserts.map((u) => `${u.id}(type=${u.config.type})`).join(", "),
          );
        }

        if (testCase.forbiddenAtlasAgents) {
          const forbiddenAtlas = captures.upsertAgents.filter(
            (u) =>
              u.config.type === "atlas" && testCase.forbiddenAtlasAgents?.has(u.config.agent ?? ""),
          );
          if (forbiddenAtlas.length > 0) {
            throw new Error(
              `Forbidden atlas agent(s) used: ` +
                forbiddenAtlas.map((u) => `${u.config.agent}`).join(", "),
            );
          }
        }

        if (
          testCase.forbidUserAgentRegistration &&
          captures.registeredUserAgentEntrypoints.length > 0
        ) {
          throw new Error(
            `Registered user agent(s) when none should be needed: ` +
              captures.registeredUserAgentEntrypoints.join(", "),
          );
        }

        if (testCase.requiredMcpServers) {
          const missing = [...testCase.requiredMcpServers].filter(
            (id) => !captures.enabledMcpServers.includes(id),
          );
          if (missing.length > 0) {
            throw new Error(
              `Required MCP server(s) not enabled: ${missing.join(", ")}. ` +
                `Without them the chosen agent type cannot actually do the work. ` +
                `Enabled: [${captures.enabledMcpServers.join(", ") || "none"}].`,
            );
          }
        }
      },
      score: ({ captures }) => {
        const matched = findUpsertWithType(captures, testCase.expectedType, testCase.expectedAgent);
        const correctType = matched !== undefined;
        const wrongTypeUsed = captures.upsertAgents.some((u) =>
          testCase.forbiddenTypes.has(u.config.type ?? ""),
        );
        const forbiddenAtlasUsed =
          testCase.forbiddenAtlasAgents !== undefined &&
          captures.upsertAgents.some(
            (u) =>
              u.config.type === "atlas" && testCase.forbiddenAtlasAgents?.has(u.config.agent ?? ""),
          );
        const userAgentRegistered =
          testCase.forbidUserAgentRegistration &&
          captures.registeredUserAgentEntrypoints.length > 0;

        const scores = [
          createScore(
            "correct-type-chosen",
            correctType ? 1 : 0,
            correctType
              ? `at least one upsert_agent emitted with type="${testCase.expectedType}"`
              : `expected type="${testCase.expectedType}", got [${summarizeUpserts(captures)}]`,
          ),
          createScore(
            "no-wrong-type",
            wrongTypeUsed ? 0 : 1,
            wrongTypeUsed
              ? `forbidden type used: ${captures.upsertAgents
                  .filter((u) => testCase.forbiddenTypes.has(u.config.type ?? ""))
                  .map((u) => `${u.id}(type=${u.config.type})`)
                  .join(", ")}`
              : `no forbidden types in [${[...testCase.forbiddenTypes].join(", ")}]`,
          ),
        ];

        if (testCase.forbiddenAtlasAgents !== undefined) {
          scores.push(
            createScore(
              "no-overdelegated-atlas",
              forbiddenAtlasUsed ? 0 : 1,
              forbiddenAtlasUsed
                ? `forbidden atlas agent used`
                : `no forbidden atlas agents in [${[...testCase.forbiddenAtlasAgents].join(", ")}]`,
            ),
          );
        }

        if (testCase.forbidUserAgentRegistration) {
          scores.push(
            createScore(
              "no-spurious-user-agent",
              userAgentRegistered ? 0 : 1,
              userAgentRegistered
                ? `registered ${captures.registeredUserAgentEntrypoints.length} user agent(s) when none needed`
                : `no user agents registered`,
            ),
          );
        }

        if (testCase.requiredMcpServers) {
          const required = [...testCase.requiredMcpServers];
          const missing = required.filter((id) => !captures.enabledMcpServers.includes(id));
          scores.push(
            createScore(
              "required-mcp-enabled",
              missing.length === 0 ? 1 : 0,
              missing.length === 0
                ? `all required MCP servers enabled: [${required.join(", ")}]`
                : `missing required MCP server(s): [${missing.join(", ")}]; enabled: [${captures.enabledMcpServers.join(", ") || "none"}]`,
            ),
          );
        }

        return scores;
      },
      metadata: {
        case: testCase.id,
        expectedType: testCase.expectedType,
        expectedAgent: testCase.expectedAgent,
        forbiddenTypes: [...testCase.forbiddenTypes],
        forbiddenAtlasAgents: testCase.forbiddenAtlasAgents
          ? [...testCase.forbiddenAtlasAgents]
          : undefined,
        requiredMcpServers: testCase.requiredMcpServers
          ? [...testCase.requiredMcpServers]
          : undefined,
        forbidUserAgentRegistration: testCase.forbidUserAgentRegistration,
        model: MODEL_ID,
      },
    },
  }),
);
