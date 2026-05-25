// Deno handler for the workspace-chat-agent-type promptfoo suite.
//
// Migrated from tools/evals/agents/workspace-chat/agent-type-default.eval.ts.
// Baselines workspace-chat's `atlas | user | llm` agent-type decision across
// five cases drawn from real failure shapes (inbox triage, CSV streaming,
// code generation, daily email report, explicit user-named type).
//
// Loads the real `bundledAgentsRegistry` so the phantom-atlas check (every
// `type: atlas` upsert must reference a real bundled id) runs in-process and
// the result is passed to promptfoo assertions via the output JSON.

import { bundledAgents, bundledAgentsRegistry } from "@atlas/bundled-agents";
import { buildRegistryModelId, isRegistryProvider, registry } from "@atlas/llm";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname ?? ".", "../../../../..");

const WORKSPACE_CHAT_PROMPT = await readFile(
  resolve(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
  "utf8",
);
const WORKSPACE_API_SKILL = await readFile(
  resolve(ROOT, "packages/system/skills/workspace-api/SKILL.md"),
  "utf8",
);
const WRITING_FRIDAY_PYTHON_AGENTS_SKILL = await readFile(
  resolve(ROOT, "packages/system/skills/writing-friday-python-agents/SKILL.md"),
  "utf8",
);

const WORKSPACE_SECTION = `<workspace id="ws-eval" name="eval-workspace">
<description>Empty workspace used by the agent-type-default eval.</description>
</workspace>`;

const AVAILABLE_SKILLS_SECTION = `<available_skills>
<instruction>Load skills with load_skill when task matches.</instruction>
<skill name="@friday/workspace-api">Create, list, update, delete, and clean up workspaces via the daemon HTTP API. Use when the user asks to create, edit, delete, or list workspaces.</skill>
<skill name="@friday/writing-friday-python-agents">Authoring guide for Python user agents (type:user) via friday-agent-sdk. Load when an agent.py exists in scope, when imports from friday_agent_sdk are present, when an at-agent decorator is being authored, or when upsert_agent was just called with type:user. Do NOT load to decide whether to author a user agent.</skill>
</available_skills>`;

const SYSTEM_PROMPT = [WORKSPACE_CHAT_PROMPT, WORKSPACE_SECTION, AVAILABLE_SKILLS_SECTION].join(
  "\n\n",
);

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

interface CapturedUpsertAgent {
  id: string;
  config: { type?: string; agent?: string } & Record<string, unknown>;
  workspaceId?: string;
}

interface Captures {
  upsertAgents: CapturedUpsertAgent[];
  enabledMcpServers: string[];
  loadedSkills: string[];
  registeredUserAgentEntrypoints: string[];
  listCapabilitiesCallCount: number;
}

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
  "not buried inside Python. See `writing-friday-python-agents` skill.\n\n" +
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

function buildToolset(captures: Captures) {
  return {
    load_skill: tool({
      description:
        "Load skill instructions BEFORE starting a task that matches a skill's description.",
      inputSchema: LoadSkillInputSchema,
      // deno-lint-ignore require-await
      execute: async ({ name }) => {
        captures.loadedSkills.push(name);
        if (name === "@friday/workspace-api") {
          return {
            name: "@friday/workspace-api",
            description: "Workspace authoring guide.",
            instructions: WORKSPACE_API_SKILL,
          } as const;
        }
        if (name === "@friday/writing-friday-python-agents") {
          return {
            name: "@friday/writing-friday-python-agents",
            description: "Python user agent authoring guide.",
            instructions: WRITING_FRIDAY_PYTHON_AGENTS_SKILL,
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
      // deno-lint-ignore require-await
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
      // deno-lint-ignore require-await
      execute: async ({ serverId }) => {
        captures.enabledMcpServers.push(serverId);
        return { ok: true, serverId };
      },
    }),

    search_mcp_servers: tool({
      description: "Search the MCP server catalog by keyword.",
      inputSchema: SearchMcpServersInputSchema,
      // deno-lint-ignore require-await
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
      // deno-lint-ignore require-await
      execute: async ({ name }) => ({
        workspace: { id: `ws-${name.toLowerCase().replace(/\s+/g, "-")}`, name },
      }),
    }),

    begin_draft: tool({
      description: "Begin a draft of the workspace config for atomic multi-entity edits.",
      inputSchema: WorkspaceIdOnlyInputSchema,
      // deno-lint-ignore require-await
      execute: async () => ({ ok: true }),
    }),

    upsert_agent: tool({
      description: UPSERT_AGENT_DESCRIPTION,
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      // deno-lint-ignore require-await
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
      // deno-lint-ignore require-await
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    upsert_job: tool({
      description: "Upsert a job into the workspace draft.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      // deno-lint-ignore require-await
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    upsert_memory_own: tool({
      description: "Upsert a memory store the workspace owns.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      // deno-lint-ignore require-await
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    validate_workspace: tool({
      description: "Validate the workspace draft. Returns errors[] and warnings[].",
      inputSchema: WorkspaceIdOnlyInputSchema,
      // deno-lint-ignore require-await
      execute: async () => ({ ok: true, errors: [], warnings: [] }),
    }),

    publish_draft: tool({
      description: "Publish the workspace draft to the live config.",
      inputSchema: WorkspaceIdOnlyInputSchema,
      // deno-lint-ignore require-await
      execute: async () => ({ ok: true }),
    }),

    list_mcp_tools: tool({
      description: "List the tools an enabled MCP server exposes.",
      inputSchema: z.object({ serverId: z.string() }),
      // deno-lint-ignore require-await
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
      // deno-lint-ignore require-await
      execute: async ({ source }) => {
        const entrypointMatch = source.match(/"entrypoint":\s*"([^"]+)"/);
        if (entrypointMatch?.[1]) {
          captures.registeredUserAgentEntrypoints.push(entrypointMatch[1]);
        }
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    }),
  };
}

interface Request {
  prompt: string;
  vars: Record<string, unknown>;
  config: { registryId?: string } & Record<string, unknown>;
}

export default async function handle(req: Request): Promise<{ output: string }> {
  if (!req.config.registryId) {
    throw new Error("workspace-chat-agent-type: providerConfig.registryId is required");
  }

  const colon = req.config.registryId.indexOf(":");
  if (colon < 0) {
    throw new Error(`registryId must be 'provider:model', got: ${req.config.registryId}`);
  }
  const providerId = req.config.registryId.slice(0, colon);
  const modelId = req.config.registryId.slice(colon + 1);
  if (!isRegistryProvider(providerId)) {
    throw new Error(`Unknown provider in registryId '${req.config.registryId}'`);
  }
  const typedId = buildRegistryModelId(providerId, modelId);

  const captures: Captures = {
    upsertAgents: [],
    enabledMcpServers: [],
    loadedSkills: [],
    registeredUserAgentEntrypoints: [],
    listCapabilitiesCallCount: 0,
  };
  const tools = buildToolset(captures);

  const result = streamText({
    model: registry.languageModel(typedId),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: req.prompt }],
    tools,
    // Workspace authoring touches more tools (capabilities + skills + multi-agent
    // + jobs + signals) than the bundled-agent suite — 20 steps lines up with
    // the original eval's budget.
    stopWhen: stepCountIs(20),
  });

  for await (const _chunk of result.fullStream) {
    // no-op
  }

  // Surface the known-bundled-agent set so promptfoo assertions can run the
  // phantom-atlas check without re-importing @atlas/bundled-agents (which
  // wouldn't work — assertions run in promptfoo's Node sandbox, not Deno).
  return {
    output: JSON.stringify({
      captures,
      knownBundledAgents: Object.keys(bundledAgentsRegistry),
    }),
  };
}
