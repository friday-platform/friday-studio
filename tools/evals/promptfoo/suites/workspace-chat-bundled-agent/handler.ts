// Deno handler for the workspace-chat-bundled-agent promptfoo suite.
//
// Migrated from tools/evals/agents/workspace-chat/bundled-agent-default.eval.ts.
// Verifies the LLM picks bundled atlas agents (web, slack, etc.) over MCP
// servers when a bundled option fits — driven by promptfoo so the same cases
// run across the friday-* tier matrix.
//
// Reproduces the LLM-facing surface a real workspace-chat session sees, but
// with mock tool execute() functions that capture the model's decisions
// instead of mutating real state:
//   - Real `prompt.txt` system prompt
//   - Real `workspace-api/SKILL.md` content via load_skill
//   - Real `upsert_agent` tool description (verbatim from production code)
//   - Real `bundledAgents` registry surfaced via list_capabilities
//   - Synthetic MCP catalog so the LLM has a meaningful bundled-vs-MCP choice

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { bundledAgents } from "@atlas/bundled-agents";
import { buildRegistryModelId, isRegistryProvider, registry } from "@atlas/llm";
import { jsonSchema, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

const ROOT = resolve(import.meta.dirname ?? ".", "../../../../..");

const WORKSPACE_CHAT_PROMPT = await readFile(
  resolve(ROOT, "packages/system/agents/workspace-chat/prompt.txt"),
  "utf8",
);

const WORKSPACE_API_SKILL = await readFile(
  resolve(ROOT, "packages/system/skills/workspace-api/SKILL.md"),
  "utf8",
);

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

interface CapturedUpsertAgent {
  id: string;
  config: { type?: string; agent?: string } & Record<string, unknown>;
  workspaceId?: string;
}

interface Captures {
  upsertAgents: CapturedUpsertAgent[];
  enabledMcpServers: Array<{ serverId: string }>;
  loadedSkills: string[];
  listCapabilitiesCallCount: number;
}

// Real tool description verbatim from
// packages/system/agents/workspace-chat/tools/upsert-tools.ts so the LLM sees
// the same description bytes a production session would.
const UPSERT_AGENT_DESCRIPTION =
  "Upsert an agent into the current workspace's draft (or live config if no draft). " +
  "The `config` field's shape depends on `config.type`:\n\n" +
  '- `type: "llm"` — inline LLM agent. Shape: ' +
  "`{ type, description, config: { provider, model, prompt, tools? } }`. " +
  'Use when the work is open-ended ("figure out what to do") and no bundled agent fits.\n' +
  '- `type: "atlas"` — bundled platform agent (web, slack, gh, etc.). Shape: ' +
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

// Hoisted Zod schemas — `ai`'s `tool()` overload resolution narrows to `never`
// with inline `z.object(...)` (Zod v4 + AI SDK v6 quirk). Pulling each schema
// to a const sidesteps it.
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

function buildToolset(captures: Captures) {
  return {
    load_skill: tool({
      description:
        "Load skill instructions BEFORE starting a task that matches a skill's description. " +
        "Skills contain step-by-step guidance you should follow. Check <available_skills> — " +
        "if your task matches, load the skill first.",
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
        return { error: `Skill "${name}" not found.` } as const;
      },
    }),

    list_capabilities: tool({
      description:
        "List every capability available to this workspace: bundled atlas agents (web, " +
        "slack, gh, etc.), enabled MCP servers, and MCP servers in the platform catalog. " +
        "Output is bundled-first, alphabetical within each kind. Scan top-down and pick the " +
        "first match — bundled agents are zero-config and should be your default when the " +
        "domain fits. Each entry carries `requiresConfig` (env keys / credentials still needed " +
        "to function); bundled entries also carry `examples` and `constraints`.",
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
      description:
        "Enable an MCP server in this workspace's `tools.mcp.servers` block so its tools " +
        "become available to agents. Only call this when no bundled atlas agent covers the " +
        "domain (use `list_capabilities` to check first).",
      inputSchema: EnableMcpServerInputSchema,
      // deno-lint-ignore require-await
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
      description:
        "Create a new empty workspace. Returns `{ workspace: { id, name } }`. Pass the " +
        "returned `id` as `workspaceId` to subsequent draft / upsert tools.",
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
      description: "Upsert a signal into the workspace draft. See workspace-api skill.",
      inputSchema: jsonSchema(UPSERT_INPUT_SCHEMA),
      // deno-lint-ignore require-await
      execute: async () => ({ ok: true, diff: {}, structural_issues: null }),
    }),

    upsert_job: tool({
      description: "Upsert a job into the workspace draft. See workspace-api skill.",
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
  };
}

interface Request {
  prompt: string;
  vars: Record<string, unknown>;
  config: { registryId?: string } & Record<string, unknown>;
}

export default async function handle(req: Request): Promise<{ output: string }> {
  if (!req.config.registryId) {
    throw new Error("workspace-chat-bundled-agent: providerConfig.registryId is required");
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
    listCapabilitiesCallCount: 0,
  };
  const tools = buildToolset(captures);

  const result = streamText({
    model: registry.languageModel(typedId),
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: req.prompt }],
    tools,
    stopWhen: stepCountIs(12),
  });

  // Drain — assertions only care about captured tool-call shapes, not text.
  for await (const _chunk of result.fullStream) {
    // no-op
  }

  return { output: JSON.stringify({ captures }) };
}
