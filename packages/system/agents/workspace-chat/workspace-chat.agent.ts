import process from "node:process";
import type { AtlasTools, AtlasUIMessage, ToolCall, ToolResult } from "@atlas/agent-sdk";
import {
  closePendingToolParts,
  createAgent,
  ok,
  repairToolCall,
  validateAtlasUIMessages,
} from "@atlas/agent-sdk";
import {
  collectToolUsageFromSteps,
  extractArtifactRefsFromToolResults,
  pipeUIMessageStream,
} from "@atlas/agent-sdk/vercel-helpers";
import { bundledAgents } from "@atlas/bundled-agents";
import { client, parseResult } from "@atlas/client/v2";
import { CommunicatorKindSchema, type WorkspaceConfig } from "@atlas/config";
import { composePreface, type PrefaceEntry } from "@atlas/core/agent-context/compose-preface";
import { scrubAssistantMessage } from "@atlas/core/artifacts/scrubber";
import { ChatStorage } from "@atlas/core/chat/storage";
import { createDelegateTool } from "@atlas/core/delegate";
import { createErrorCause, getErrorDisplayMessage } from "@atlas/core/errors";
import {
  buildTemporalFacts,
  enterUsageScope,
  type PlatformModels,
  resolveModelFromString,
  smallLLM,
  type UsageCounter,
} from "@atlas/llm";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import type { SkillSummary } from "@atlas/skills";
import { createLoadSkillTool, resolveVisibleSkills, SkillStorage } from "@atlas/skills";
import {
  convertToModelMessages,
  createUIMessageStream,
  type ModelMessage,
  smoothStream,
  stepCountIs,
  streamText,
} from "ai";
import { z } from "zod";
import { fetchLinkSummary } from "../link-context.ts";
import { getBlock2Inputs } from "./block2-cache.ts";
import {
  composeArtifactBlocks,
  composeMemoryBlocks,
  composeTools,
  composeWorkspaceSections,
  fetchForegroundContexts,
} from "./compose-context.ts";
import { buildOnboardingClause, buildUserProfileClause } from "./onboarding.ts";
import SYSTEM_PROMPT from "./prompt.txt" with { type: "text" };
import { connectCommunicatorSucceeded, connectServiceSucceeded } from "./stop-conditions.ts";
import {
  createDeleteAgentFromRegistryTool,
  createRegisterAgentTool,
} from "./tools/agent-registry-tools.ts";
import { artifactTools, createCreateArtifactTool } from "./tools/artifact-tools.ts";
import {
  createDescribeBundledAgentTool,
  createListBundledAgentsTool,
} from "./tools/bundled-agent-discovery-tools.ts";
import { createAgentTool, rebindAgentTool } from "./tools/bundled-agent-tools.ts";
import { createRunCodeTool } from "./tools/code-exec.ts";
import { createConnectCommunicatorTool } from "./tools/connect-communicator.ts";
import { createConnectServiceTool } from "./tools/connect-service.ts";
import { createCreateMcpServerTool } from "./tools/create-mcp-server.ts";
import { createDisableMcpServerTool } from "./tools/disable-mcp-server.ts";
import { createBoundDraftTools } from "./tools/draft-tools.ts";
import { createEnableMcpServerTool } from "./tools/enable-mcp-server.ts";
import { createEnvTools } from "./tools/env-tools.ts";
import { createFileIOTools, createReadAttachmentTool } from "./tools/file-io.ts";
import { createInstallMcpServerTool } from "./tools/install-mcp-server.ts";
import {
  createDescribeIntegrationTool,
  createListIntegrationsTool,
} from "./tools/integration-tools.ts";
import {
  createDescribeAgentTool,
  createDescribeDraftTool,
  createDescribeJobTool,
  createDescribeMemoryStoreTool,
  createDescribeSignalTool,
  createDescribeUserIdentityTool,
  createDescribeWorkspaceTool,
  createListAgentsTool,
  createListArtifactsTool,
  createListCommunicatorsTool,
  createListJobsTool,
  createListMemoryStoresTool,
  createListSignalsTool,
  createListWorkspacesTool,
} from "./tools/inventory-tools.ts";
import { createJobTools } from "./tools/job-tools.ts";
import { createListCapabilitiesTool } from "./tools/list-capabilities.ts";
import { createListMcpToolsTool } from "./tools/list-mcp-tools.ts";
import {
  createDescribeSkillTool,
  createListSkillsTool,
  createSearchSkillsTool,
} from "./tools/list-skills.ts";
import {
  createDescribeMcpServerTool,
  createDescribeMcpToolTool,
  createListMcpServersTool,
} from "./tools/mcp-discovery-tools.ts";
import {
  createDescribeMemoryEntryTool,
  createListMemoryEntriesTool,
} from "./tools/memory-entry-tools.ts";
import { createMemorySaveTool } from "./tools/memory-save.ts";
import { createPublishSkillTool } from "./tools/publish-skill.ts";
import { createRequestToolAccessTool } from "./tools/request-tool-access.ts";
import { createSearchMcpServersTool } from "./tools/search-mcp-servers.ts";
import { createDescribeSessionTool, createListSessionsTool } from "./tools/session-tools.ts";
import { createSetUserIdentityTool } from "./tools/set-user-identity.ts";
import {
  createAssignWorkspaceSkillTool,
  createUnassignWorkspaceSkillTool,
} from "./tools/skill-tools.ts";
import { createBoundUpsertTools } from "./tools/upsert-tools.ts";
import { createWebFetchTool } from "./tools/web-fetch.ts";
import { createWebSearchTool } from "./tools/web-search.ts";
import { createBoundWorkspaceOpsTools, createWorkspaceOpsTools } from "./tools/workspace-ops.ts";
import { fetchUserIdentitySection } from "./user-identity.ts";
import { fetchUserProfileState } from "./user-profile.ts";

interface WorkspaceChatResult {
  text: string | undefined;
}

/** Artifact shape from the artifacts storage endpoint. */
export interface ArtifactSummary {
  id: string;
  type: string;
  title: string;
  summary: string;
}

const ArtifactsResponseSchema = z.object({
  artifacts: z.array(
    z.object({ id: z.string(), type: z.string(), title: z.string(), summary: z.string() }),
  ),
});

/**
 * Parse artifact summaries from raw daemon API response.
 * Returns empty array on invalid data.
 */
export function parseArtifactSummaries(data: unknown): ArtifactSummary[] {
  const parsed = ArtifactsResponseSchema.safeParse(data);
  return parsed.success ? parsed.data.artifacts : [];
}

export interface WorkspaceDetails {
  name: string;
  description?: string;
  agents: string[];
  jobs: Array<{ id: string; name: string; description?: string }>;
  signals: Array<{ name: string }>;
  artifacts: ArtifactSummary[];
}

export async function fetchWorkspaceDetails(
  workspaceId: string,
  logger: Logger,
): Promise<WorkspaceDetails> {
  const [wsResult, agentsResult, jobsResult, signalsResult, artifactsResult] = await Promise.all([
    parseResult(client.workspace[":workspaceId"].$get({ param: { workspaceId } })),
    parseResult(client.workspace[":workspaceId"].agents.$get({ param: { workspaceId } })),
    parseResult(client.workspace[":workspaceId"].jobs.$get({ param: { workspaceId } })),
    parseResult(client.workspace[":workspaceId"].signals.$get({ param: { workspaceId } })),
    parseResult(client.artifactsStorage.index.$get({ query: { workspaceId, limit: "50" } })),
  ]);

  const name = wsResult.ok ? (wsResult.data.name ?? workspaceId) : workspaceId;
  const description = wsResult.ok ? wsResult.data.description : undefined;

  if (!wsResult.ok) {
    logger.error("Failed to fetch workspace details", { workspaceId, error: wsResult.error });
  }

  const agents: string[] = [];
  if (agentsResult.ok && Array.isArray(agentsResult.data)) {
    for (const a of agentsResult.data) {
      const parsed = z.object({ id: z.string() }).safeParse(a);
      if (parsed.success) agents.push(parsed.data.id);
    }
  } else {
    logger.warn("Failed to fetch workspace agents", {
      workspaceId,
      error: agentsResult.ok ? "invalid shape" : agentsResult.error,
    });
  }

  const jobs: Array<{ id: string; name: string; description?: string }> = [];
  if (jobsResult.ok && Array.isArray(jobsResult.data)) {
    for (const j of jobsResult.data) {
      const parsed = z
        .object({ id: z.string(), name: z.string(), description: z.string().optional() })
        .safeParse(j);
      if (parsed.success) jobs.push(parsed.data);
    }
  } else {
    logger.warn("Failed to fetch workspace jobs", {
      workspaceId,
      error: jobsResult.ok ? "invalid shape" : jobsResult.error,
    });
  }

  const signals: Array<{ name: string }> = [];
  if (signalsResult.ok) {
    const parsed = z
      .object({ signals: z.array(z.object({ name: z.string() })) })
      .safeParse(signalsResult.data);
    if (parsed.success) {
      signals.push(...parsed.data.signals);
    }
  } else {
    logger.warn("Failed to fetch workspace signals", { workspaceId, error: signalsResult.error });
  }

  let artifacts: ArtifactSummary[] = [];
  if (artifactsResult.ok) {
    artifacts = parseArtifactSummaries(artifactsResult.data);
  } else {
    logger.warn("Failed to fetch workspace artifacts", {
      workspaceId,
      error: artifactsResult.error,
    });
  }

  return { name, description, agents, jobs, signals, artifacts };
}

/**
 * Describe a signal trigger so Friday can answer "how do I run this?" without
 * guessing. Falls back to the provider name when the config shape doesn't
 * carry a user-facing identifier.
 */
function describeSignalTrigger(sig: unknown): string {
  if (typeof sig !== "object" || sig === null) return "";
  const s = sig as { provider?: unknown; config?: unknown };
  const provider = typeof s.provider === "string" ? s.provider : undefined;
  const cfg =
    typeof s.config === "object" && s.config !== null
      ? (s.config as Record<string, unknown>)
      : undefined;

  if (provider === "http" && cfg && typeof cfg.path === "string") {
    return `POST ${cfg.path}`;
  }
  if (provider === "schedule" && cfg) {
    const cron = typeof cfg.cron === "string" ? cfg.cron : undefined;
    const interval = typeof cfg.interval === "string" ? cfg.interval : undefined;
    return cron ? `cron ${cron}` : interval ? `every ${interval}` : "schedule";
  }
  if (provider === "fs-watch" && cfg && typeof cfg.path === "string") {
    return `watch ${cfg.path}`;
  }
  if (provider === "slack") return "slack message";
  if (provider === "telegram") return "telegram message";
  if (provider === "whatsapp") return "whatsapp message";
  if (provider === "discord") return "discord message";
  if (provider === "system") return "system";
  return provider ?? "";
}

/**
 * Format workspace capabilities as a system prompt section.
 *
 * When the full `wsConfig` is available, signal triggers (HTTP paths, cron
 * schedules, platform providers) and MCP tool names are inlined so Friday can
 * answer workspace-specific "how do I run this?" / "where's my data?" without
 * guessing. Without a config, falls back to a summary of names only.
 */
export function formatWorkspaceSection(
  workspaceId: string,
  details: WorkspaceDetails,
  config?: WorkspaceConfig,
): string {
  let section = `<workspace id="${workspaceId}" name="${details.name}">`;

  if (details.description) {
    section += `\n${details.description}`;
  }

  if (details.agents.length > 0) {
    section += `\n<agents>${details.agents.join(", ")}</agents>`;
  }

  // Jobs are already bound as callable tools by createJobTools — each job's
  // name + description ride on the tool schema and are visible to the model
  // through the AI SDK's tools array. The earlier per-job description block
  // here was duplicate signal that mutated alongside `upsert_job`. Drop it.

  if (details.signals.length > 0) {
    const signalConfigs = config?.signals;
    // Map signal → job that triggers from it. When a job covers a signal,
    // the signal is reachable via the bound job tool — pointing the model
    // at the tool name (instead of the HTTP path) closes the failure mode
    // where chat web_fetched localhost/webhook URLs instead of calling
    // the registered tool. Locked by tools/qa/live-daemon/scenarios/
    // chat-job-tool-routing.ts.
    const signalToJob = new Map<string, string>();
    for (const [jobName, jobSpec] of Object.entries(config?.jobs ?? {})) {
      for (const trig of jobSpec.triggers ?? []) {
        if (trig.signal && !signalToJob.has(trig.signal)) {
          signalToJob.set(trig.signal, jobName);
        }
      }
    }
    const signalEntries = details.signals.map((s) => {
      const job = signalToJob.get(s.name);
      if (job) return `${s.name} (use tool: ${job})`;
      const trigger = signalConfigs ? describeSignalTrigger(signalConfigs[s.name]) : "";
      return trigger ? `${s.name} (${trigger})` : s.name;
    });
    section += `\n<signals>\n${signalEntries.join("\n")}\n</signals>`;
  }

  const mcpServerIds = Object.keys(config?.tools?.mcp?.servers ?? {});
  if (mcpServerIds.length > 0) {
    section += `\n<mcp_servers>${mcpServerIds.join(", ")}</mcp_servers>`;
  }

  const ownStores = config?.memory?.own ?? [];
  const rwMounts = (config?.memory?.mounts ?? []).filter((m) => m.mode === "rw");
  if (ownStores.length > 0 || rwMounts.length > 0) {
    const entries = [
      ...ownStores.map((s) => `<store name="${s.name}" type="${s.type}"/>`),
      ...rwMounts.map((m) => `<store name="${m.name}" type="mount-rw"/>`),
    ];
    section += `\n<memory_stores>\n${entries.join("\n")}\n</memory_stores>`;
  }

  if (config?.communicators) {
    const wired = config.communicators;
    const entries = CommunicatorKindSchema.options.map(
      (kind) => `<communicator kind="${kind}" wired="${kind in wired ? "true" : "false"}"/>`,
    );
    section += `\n<communicators>\n${entries.join("\n")}\n</communicators>`;
  }

  section += "\n</workspace>";
  return section;
}

/**
 * Cap a skill description at the first line break / sentence boundary, then a
 * fixed character limit, so the inline `<available_skills>` index stays
 * cheap. The full description is still retrievable via `describe_skill`,
 * and the body via `load_skill`. Trims trailing whitespace + dangling
 * partial-word tails, appends `…` when truncated.
 *
 * The 80-char cap is a soft target — at ~25 skills per workspace it keeps
 * the index under ~600 tokens regardless of skill-author description length.
 */
const SKILL_SUMMARY_MAX_CHARS = 80;

/**
 * Truncate by code points, not UTF-16 code units. `String#slice(n)` cuts at
 * the n-th code unit and can split an astral-plane code point (emoji, some
 * CJK, mathematical symbols) into a lone high surrogate that renders as a
 * replacement character downstream. Iterating with `Array.from` yields one
 * entry per code point, so the cap is grapheme-safe to a first
 * approximation (combining marks remain code-point-pair-only, but we don't
 * assemble graphemes).
 */
function sliceByCodePoints(s: string, n: number): string {
  const points = Array.from(s);
  return points.length <= n ? s : points.slice(0, n).join("");
}

export function summarizeSkillDescription(description: string): string {
  const collapsed = description.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  const firstLine = collapsed.split(/(?<=[.!?])\s/)[0] ?? collapsed;
  const candidate = firstLine.length <= collapsed.length ? firstLine : collapsed;
  if (Array.from(candidate).length <= SKILL_SUMMARY_MAX_CHARS) return candidate;
  const cut = sliceByCodePoints(candidate, SKILL_SUMMARY_MAX_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  const safe = lastSpace > SKILL_SUMMARY_MAX_CHARS / 2 ? cut.slice(0, lastSpace) : cut;
  return `${safe.replace(/[\s,;:.!?-]+$/, "")}…`;
}

/**
 * Build the `<available_skills>` index that ships in block 2.
 *
 * Each entry carries name + ref + a one-line summary capped at
 * SKILL_SUMMARY_MAX_CHARS — full descriptions are retrievable via
 * `describe_skill(ref)` and bodies via `load_skill(ref)`. Keeping the
 * inline section bounded means a workspace with N skills costs O(N) bytes
 * at ~30 tokens each instead of ~120 tokens of per-skill description text.
 */
export function buildSkillsSection(workspaceSkills: SkillSummary[]): string {
  if (workspaceSkills.length === 0) return "";

  const entries = workspaceSkills.map((s) => {
    const summary = summarizeSkillDescription(s.description);
    const body = summary.length > 0 ? summary : "";
    return `<skill name="@${s.namespace}/${s.name}">${body}</skill>`;
  });

  return `<available_skills>
<instruction>Index of skills visible to this workspace. Each entry is ref + one-line summary. Use describe_skill for full descriptions, load_skill to bring instructions into chat, search_skills/list_skills to discover.</instruction>
${entries.join("\n")}
</available_skills>`;
}

/**
 * Build workspace-chat system prompt blocks.
 *
 * Returns four logical tiers matching the prompt-cache layout:
 *   - block1: weeks-stable static instructions (prompt.txt)
 *   - block2: workspace-stable identity (skills index, user identity)
 *   - block3: session-stable turn-context (onboarding clause, user profile)
 *   - block4: volatile workspace inventory — the `<workspace>` XML
 *     (agents, signals, jobs, MCP servers). Pulled out of block2 because
 *     it changes on every `upsert_*` / `publish_draft`; co-locating it
 *     with the 1h-TTL identity tier burned a full-rate cache write on
 *     every workspace mutation.
 *
 * The cache salt rides on block2 (not block4): a "force fresh" bump must
 * bust *everything*, and a change at block2's prefix cascades through
 * block3 and block4 too. Salting only block4 would leave the skills /
 * identity breakpoint cached.
 *
 * The turn preface (memory + temporal facts) is NOT in the system prompt
 * — it rides as a synthetic user-message preface so the system stays
 * byte-stable across turns and the Anthropic prompt cache hits the
 * prefix. It is not a cache breakpoint.
 *
 * Anthropic supports up to 4 cache breakpoints per request. We wire one
 * each at the block1/block2/block3/block4 boundaries (see the Anthropic
 * branch of the streamText setup). TTLs are non-increasing across the
 * sequence (1h, 1h, 5m, 5m) as Anthropic requires.
 */
export interface SystemBlocks {
  block1: string;
  block2: string;
  block3: string;
  block4: string;
}

export function getSystemBlocks(
  workspaceSection: string,
  options?: {
    skills?: string;
    userIdentity?: string;
    onboarding?: string;
    userProfile?: string;
    /**
     * Optional cache-salt tag prepended to block 2. The /debug page
     * "force fresh next turn" button bumps a workspace-scoped salt;
     * the chat handler reads it and threads the rendered tag here so
     * a one-byte change at block 2's prefix invalidates that breakpoint
     * — and, because block 3 and block 4 sit behind it, the whole
     * cached prefix — for every chat in the workspace. Empty string
     * when the workspace has never bumped — no behavior change then.
     */
    cacheSaltTag?: string;
  },
): SystemBlocks {
  // The salt leads block 2 so a "force fresh" bump cascades: changing
  // block 2's prefix invalidates block 3 and block 4 along with it.
  const block2Parts: string[] = [];
  if (options?.cacheSaltTag) block2Parts.push(options.cacheSaltTag.trimEnd());
  if (options?.skills) block2Parts.push(options.skills);
  if (options?.userIdentity) block2Parts.push(options.userIdentity);

  const block3Parts: string[] = [];
  if (options?.onboarding) block3Parts.push(options.onboarding);
  if (options?.userProfile) block3Parts.push(options.userProfile);

  const block4Parts: string[] = [workspaceSection];

  return {
    block1: SYSTEM_PROMPT,
    block2: block2Parts.join("\n\n"),
    block3: block3Parts.join("\n\n"),
    block4: block4Parts.join("\n\n"),
  };
}

/**
 * Concatenate blocks into a single system-prompt string. Used when the
 * provider doesn't support per-block cache control — non-anthropic
 * providers see the full prompt as one string.
 */
export function flattenSystemBlocks(blocks: SystemBlocks): string {
  const parts = [blocks.block1];
  if (blocks.block2) parts.push(blocks.block2);
  if (blocks.block3) parts.push(blocks.block3);
  if (blocks.block4) parts.push(blocks.block4);
  return parts.join("\n\n");
}

/**
 * Build the Anthropic system-message array — one `role: "system"` message
 * per non-empty block, each carrying its own `cache_control` breakpoint.
 *
 * Anthropic enforces non-increasing TTL across the tools → system →
 * messages sequence (a 1h breakpoint cannot follow a 5m one). Block 1 and
 * block 2 are weeks-/workspace-stable so they take the 1h TTL; block 3
 * (session-stable) and block 4 (volatile workspace inventory, rewritten on
 * every `upsert_*`/`publish_draft`) take the cheaper 5m TTL. The emitted
 * order is 1h, 1h, 5m, 5m — non-increasing, so the rule holds.
 *
 * block2 may be empty (a workspace with no skills and no stored user
 * identity); it's skipped rather than emitted as an empty system message.
 * block3 is likewise conditional. block1 and block4 are always present.
 */
export function buildAnthropicSystemMessages(blocks: SystemBlocks): ModelMessage[] {
  const longTtl = { type: "ephemeral", ttl: "1h" } as const;
  const shortTtl = { type: "ephemeral" } as const;
  const msgs: ModelMessage[] = [
    {
      role: "system",
      content: blocks.block1,
      providerOptions: { anthropic: { cacheControl: longTtl } },
    },
  ];
  if (blocks.block2) {
    msgs.push({
      role: "system",
      content: blocks.block2,
      providerOptions: { anthropic: { cacheControl: longTtl } },
    });
  }
  if (blocks.block3) {
    msgs.push({
      role: "system",
      content: blocks.block3,
      providerOptions: { anthropic: { cacheControl: shortTtl } },
    });
  }
  msgs.push({
    role: "system",
    content: blocks.block4,
    providerOptions: { anthropic: { cacheControl: shortTtl } },
  });
  return msgs;
}

/**
 * Generates a concise 2-3 word title for a conversation based on its messages.
 */
export async function generateChatTitle(
  platformModels: PlatformModels,
  messages: AtlasUIMessage[],
  logger: Logger,
): Promise<string> {
  const messagePreview = messages
    .map((m) => `${m.role}: ${JSON.stringify(m.parts.filter((p) => p.type === "text"))}`)
    .join("\n");

  const result = await smallLLM({
    platformModels,
    system:
      "You generate concise 2-3 word titles for conversations. Only output the title, nothing else.",
    prompt: `Generate a title for this conversation:\n${messagePreview}`,
    maxOutputTokens: 250,
  });

  const title = result.trim();
  if (title.length < 3) {
    logger.warn("Chat title too short, using fallback", { title });
    return "Saved Chat";
  }
  return title;
}

export const workspaceChatAgent = createAgent<string, WorkspaceChatResult>({
  id: "workspace-chat",
  displayName: "Workspace Chat Agent",
  version: "1.0.0",
  description: "Chat agent scoped to a single workspace",
  expertise: { examples: [] },
  useWorkspaceSkills: true,

  handler: async (_, { session, logger, stream, abortSignal, platformModels, envOverlay }) => {
    if (!session.streamId) {
      throw new Error("Stream ID is required");
    }

    const workspaceId = session.workspaceId;
    if (!workspaceId) {
      throw new Error("Workspace ID is required for workspace chat");
    }

    // userId is required for the new identity-aware code paths
    // (USERS-bucket reads, set_user_identity tool). The HTTP route
    // middleware in routes/workspaces/chat.ts populates it from the
    // X-Atlas-User-Id header (set server-side from getUserId()), so it
    // is always present in production. Guard explicitly so the SDK
    // type narrowing works for the rest of the handler.
    const userId = session.userId;
    if (!userId) {
      throw new Error("User ID is required for workspace chat");
    }

    // Load and validate chat history via workspace-scoped HTTP endpoint
    let messages: AtlasUIMessage[] = [];
    const res = await parseResult(
      client
        .workspaceChat(workspaceId)
        [":chatId"].$get({ param: { chatId: session.streamId }, query: {} }),
    );
    if (res.ok) {
      messages = await validateAtlasUIMessages(res.data.messages);
    } else {
      logger.error("Failed to load chat history", { error: res.error });
    }

    let finalText: string | undefined;
    // Per-turn token + cache usage. Mutated in place by traceModel
    // middleware on every wrapped LLM call inside `enterUsageScope`
    // below — that includes the parent streamText (one entry per step),
    // every nested call fired from a tool execute (bundled agents,
    // from-llm agents, delegate, fsm, supervisor), and user-agent
    // `ctx.llm` requests bridged via `CapabilityContext.usageCounter`.
    // Read in `onFinish` and written to the persisted message metadata.
    const usageCounter: UsageCounter = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    let turnUsage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        }
      | undefined;
    // Capture the bundled-agent's internal tool calls so the workspace-runtime
    // side-channel (runtime.ts:executeAgent) can mirror them onto
    // `step:complete.toolCalls`. This keeps `case "agent" → workspace-chat`
    // history aligned with the FSM `case "llm"` path.
    let assembledToolCalls: ToolCall[] = [];
    let assembledToolResults: ToolResult[] = [];
    let assembledReasoning: string | undefined;
    let cleanupSkills: (() => Promise<void>) | undefined;

    const persistStreamMessage = createUIMessageStream<AtlasUIMessage>({
      originalMessages: messages,
      onFinish: async ({ messages }) => {
        if (!session.streamId) {
          throw new Error("Stream ID is missing");
        }

        // Generate title on turns 2 and 4
        if (messages.length === 2 || messages.length === 4) {
          const title = await generateChatTitle(platformModels, messages, logger);
          const titleResult = await parseResult(
            client
              .workspaceChat(workspaceId)
              [":chatId"].title.$patch({ param: { chatId: session.streamId }, json: { title } }),
          );
          if (!titleResult.ok) {
            logger.error("Failed to update chat title", { streamId: session.streamId, title });
          }
        }

        // Persist assistant message directly via ChatStorage. The HTTP route
        // is locked down to user-role messages only — assistant persistence
        // happens in-process to avoid that guard and to skip an unnecessary
        // localhost roundtrip.
        //
        // Before persisting:
        // 1. Sweep any tool-call parts that didn't reach a terminal state.
        //    Cancelled / crashed turns leave the last in-flight tool stuck
        //    in `input-streaming` or `input-available`, which the chat page
        //    would then render as a "running…" spinner forever on reload.
        //    Flipping them to `output-error` gives the UI something to
        //    render and matches the semantics of what actually happened.
        // 2. Strip `data-nested-chunk` parts. These are live-streaming
        //    envelopes from a nested job's inner FSM/tool events — useful
        //    for rendering the running tool-card live in the chat UI, but
        //    pure noise once the parent tool reaches output-available
        //    (which captures the final result). Persisting them bloats
        //    chat history (one observed turn was 82% nested-chunks) and
        //    forces the UI to filter them on every read.
        const lastMessage = messages[messages.length - 1];
        if (lastMessage && lastMessage.role === "assistant") {
          const { closed } = closePendingToolParts(lastMessage);
          if (closed > 0) {
            logger.info("Closed pending tool parts before persist", {
              streamId: session.streamId,
              messageId: lastMessage.id,
              closed,
              aborted: abortSignal?.aborted === true,
            });
          }
          const beforeCount = lastMessage.parts.length;
          lastMessage.parts = lastMessage.parts.filter(
            (p): p is typeof p => p.type !== "data-nested-chunk",
          );
          const stripped = beforeCount - lastMessage.parts.length;
          if (stripped > 0) {
            logger.debug("Stripped nested-chunk parts before persist", {
              streamId: session.streamId,
              messageId: lastMessage.id,
              stripped,
            });
          }

          // F8 (review-2): defense-in-depth pre-persist scrub on the
          // assistant message. The producer-LLM-side
          // `liftToolResultsForPersist` (runtime.ts side-channel) already
          // walks `toolCalls[].result` and replaces oversized strings
          // with markers; this pass operates on a different view (the
          // AI SDK's `message.parts` array, persisted to chat history)
          // and catches anything LLM-fabricated outside the tool-result
          // path. Cost is bounded — already-lifted strings hit the
          // marker-prefix early-exit (`scrubber.ts:scrubString` first
          // check) and short-circuit without re-uploading.
          try {
            const { rewritten } = await scrubAssistantMessage(
              lastMessage.parts as Array<Record<string, unknown>>,
              { workspaceId, chatId: session.streamId, logger },
            );
            if (rewritten > 0) {
              logger.info("Scrubbed binary out of assistant parts before persist", {
                streamId: session.streamId,
                messageId: lastMessage.id,
                rewritten,
              });
            }
          } catch (err) {
            // Persistence path must continue regardless. The MCP-boundary
            // scrubber is the primary defense; this is best-effort.
            logger.warn("Pre-persist scrub failed (continuing with append)", {
              streamId: session.streamId,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          // Stamp final per-turn token + cache usage onto the persisted
          // assistant message. `turnUsage` is captured in streamText's
          // own onFinish callback (which fires before this UIMessageStream
          // onFinish), so it's always settled by the time we get here.
          // The messageMetadata callback during streaming runs too early
          // — it sees `turnUsage = undefined` and the SDK doesn't
          // re-invoke it after the stream's terminal usage event. Writing
          // to `metadata.usage` here is the reliable path.
          if (turnUsage) {
            lastMessage.metadata = { ...(lastMessage.metadata ?? {}), usage: turnUsage };
          }

          const appendResult = await ChatStorage.appendMessage(
            session.streamId,
            lastMessage,
            workspaceId,
          );
          if (!appendResult.ok) {
            logger.error("Failed to append assistant message to chat storage", {
              streamId: session.streamId,
              error: appendResult.error,
            });
          } else {
            logger.debug("Assistant message persisted to chat storage", {
              streamId: session.streamId,
              messageId: lastMessage.id,
            });
          }
        }
      },
      execute: async ({ writer }) => {
        if (!session.streamId) {
          throw new Error("Stream ID is required");
        }

        // Parallel fetch of startup context
        const foregroundIds = session.foregroundWorkspaceIds ?? [];
        logger.info("Fetching workspace chat startup context", {
          workspaceId,
          foregroundCount: foregroundIds.length,
        });
        const [block2, linkSummary, userIdentitySection, foregrounds, profileState] =
          await Promise.all([
            getBlock2Inputs(workspaceId, logger),
            fetchLinkSummary(logger),
            fetchUserIdentitySection(userId, logger),
            foregroundIds.length > 0
              ? fetchForegroundContexts(foregroundIds, logger)
              : Promise.resolve([]),
            fetchUserProfileState(userId, logger),
          ]);

        const workspaceDetails = block2.details;
        const wsConfig = block2.config;

        // Format sections — compose with foreground workspaces. wsConfig
        // carries the workspace.yml details (signal triggers, MCP server names)
        // so Friday can answer "how do I run this?" / "where's my data stored?"
        // without falling back to docker/infra speculation.
        const primaryWorkspaceSection = formatWorkspaceSection(
          workspaceId,
          workspaceDetails,
          wsConfig,
        );
        const workspaceSection = composeWorkspaceSections(primaryWorkspaceSection, foregrounds);

        // Skills — scoped to the primary workspace only. Foreground skills
        // used to merge into <available_skills>, which made any pinned
        // foreground's skill assignment burst the prefix cache. Now the
        // chat reaches across via list_skills(scope=...) / describe_skill
        // when it actually needs a foreground's skill.
        const primarySkills = await resolveVisibleSkills(workspaceId, SkillStorage);
        const skillsSection = buildSkillsSection(primarySkills);

        // Connect service tool
        const connectServiceTool: AtlasTools = {};
        if (linkSummary && linkSummary.providers.length > 0) {
          const providerIds = linkSummary.providers.map((p) => p.id);
          connectServiceTool.connect_service = createConnectServiceTool(providerIds);
        }

        // Connect communicator tool — surfaces the chat-driven flow that
        // wires Slack/Telegram/Discord/Teams/WhatsApp as conversation
        // surfaces. Always registered: the kind enum is the same set
        // regardless of which Link providers happen to be installed.
        const connectCommunicatorTool: AtlasTools = {
          connect_communicator: createConnectCommunicatorTool(),
        };

        // load_skill
        const loadSkillResult = createLoadSkillTool({ workspaceId });
        const loadSkillTool = loadSkillResult.tool;
        cleanupSkills = loadSkillResult.cleanup;

        // Capability discovery tool — bundled agents + enabled/available MCP servers
        const listCapabilitiesTool = createListCapabilitiesTool(
          workspaceId,
          wsConfig,
          linkSummary ?? undefined,
          logger,
        );

        // MCP registry search + install tools
        const searchMcpServersTool = createSearchMcpServersTool(logger);
        const installMcpServerTool = createInstallMcpServerTool(logger);
        const createMcpServerTool = createCreateMcpServerTool(logger);

        // MCP tool discovery (registry-scoped, no workspace state modified)
        const listMcpToolsTool = createListMcpToolsTool(logger);

        // Workspace-scoped MCP management tools
        const enableMcpServerTool = createEnableMcpServerTool(workspaceId, logger);
        const disableMcpServerTool = createDisableMcpServerTool(workspaceId, logger);

        // MCP discovery tools — list/describe servers and tools.
        // describe_mcp_server (scope=workspace) subsumes the prior
        // get_mcp_dependencies tool: it returns the wired config plus the
        // agents/jobs that reference each enabled server.
        const listMcpServersTool = createListMcpServersTool(workspaceId, logger);
        const describeMcpServerTool = createDescribeMcpServerTool(workspaceId, logger);
        const describeMcpToolTool = createDescribeMcpToolTool(logger);

        // Workspace skill management tools
        const publishSkillTool = createPublishSkillTool(logger);
        const assignSkillTool = createAssignWorkspaceSkillTool(workspaceId, logger);
        const unassignSkillTool = createUnassignWorkspaceSkillTool(workspaceId, logger);

        // Skill discovery tools — pair with the names+summary index in
        // <available_skills>. The chat reads names from the index and pulls
        // descriptions/bodies on demand, so skill assignment doesn't burst
        // the prefix cache for every other skill in the workspace.
        const listSkillsTool = createListSkillsTool(workspaceId, logger);
        const searchSkillsTool = createSearchSkillsTool(workspaceId, logger);
        const describeSkillTool = createDescribeSkillTool(logger);

        // Agent registry tools — replace the run_code + curl workaround for
        // user-agent registration. register_agent is idempotent so it doubles
        // as the update path; delete_agent_from_registry removes an installed
        // agent's on-disk artifacts.
        const registerAgentTool = createRegisterAgentTool(logger);
        const deleteAgentFromRegistryTool = createDeleteAgentFromRegistryTool(logger);

        // Integration retrieval — the chat fetches Link credential status on
        // demand instead of carrying a per-provider XML index in block 2.
        // Connect/disconnect events used to bust the 1h workspace-stable
        // cache; pulling the data per-turn-when-needed keeps the prefix
        // stable across connect_service calls.
        const listIntegrationsTool = createListIntegrationsTool(logger);
        const describeIntegrationTool = createDescribeIntegrationTool(logger);

        // Per-domain inventory tools — workspaces, agents, jobs, signals,
        // memory stores, communicators, drafts, user identity. Each
        // surfaces a list_X / describe_X pair scoped to the current
        // chat's workspace by default; scope opt-ins reach broader views.
        const listWorkspacesTool = createListWorkspacesTool(logger);
        const describeWorkspaceTool = createDescribeWorkspaceTool(workspaceId, logger);
        const listAgentsTool = createListAgentsTool(workspaceId, logger);
        const describeAgentTool = createDescribeAgentTool(workspaceId, logger);
        const listJobsTool = createListJobsTool(workspaceId, logger);
        const describeJobTool = createDescribeJobTool(workspaceId, logger);
        const listSignalsTool = createListSignalsTool(workspaceId, logger);
        const describeSignalTool = createDescribeSignalTool(workspaceId, logger);
        const listMemoryStoresTool = createListMemoryStoresTool(workspaceId, logger);
        const describeMemoryStoreTool = createDescribeMemoryStoreTool(workspaceId, logger);
        const listCommunicatorsTool = createListCommunicatorsTool(workspaceId, logger);
        const describeUserIdentityTool = createDescribeUserIdentityTool(logger);
        const describeDraftTool = createDescribeDraftTool(workspaceId, logger);
        const listArtifactsTool = createListArtifactsTool(workspaceId, logger);

        // Bundled atlas agent discovery — distinct from the
        // `agent_<id>` invocation wrappers; these list/describe the
        // bundled-agent catalog with input/output schemas.
        const listBundledAgentsTool = createListBundledAgentsTool(logger);
        const describeBundledAgentTool = createDescribeBundledAgentTool(logger);

        // Session observability — fills the audit-flagged gap (the
        // chat couldn't answer "did my Slack signal fire?" without
        // run_code curl).
        const listSessionsTool = createListSessionsTool(workspaceId, logger);
        const describeSessionTool = createDescribeSessionTool(logger);

        // Memory-entry retrieval (replaces the old list_memory_entries shape
        // with rich substring + time + metadata filters and pagination).
        const listMemoryEntriesTool = createListMemoryEntriesTool(workspaceId, logger);
        const describeMemoryEntryTool = createDescribeMemoryEntryTool(workspaceId, logger);

        // Job tools — pass session.streamId so nested job sessions inherit
        // the chat thread ID. The daemon's broadcast hook reads it to skip
        // the originating chat communicator (no echo back to Discord/Slack/etc).
        // Pass writer + abortSignal so job tools can stream via SSE and render
        // nested inner tool-call cards live in the chat UI.
        const jobTools = createJobTools(
          workspaceId,
          wsConfig?.jobs ?? {},
          wsConfig?.signals ?? {},
          logger,
          session.streamId,
          writer,
          abortSignal,
          // Phase 11 provenance: spawned job sessions record this chat
          // session as their parent so the chat→job tree is recoverable.
          session.sessionId,
        );

        // Ad-hoc freedom tools — modeled on Hermes + OpenClaw patterns.
        // These give the chat agent web fetch + search + code execution +
        // ephemeral file I/O so it can handle "look up X", "run this
        // Python", "analyze this CSV" turns without bouncing off a narrow
        // workspace-only tool set.
        //
        // - web_fetch: SSRF-guarded HTTP → markdown with content-provenance
        //   wrapping, 15-min per-session cache, 2 MB raw / 32 KB extracted
        //   caps, 30 s hard timeout.
        // - web_search: Brave Search API, only registered when
        //   BRAVE_SEARCH_API_KEY is set (Hermes `check_fn` pattern).
        // - run_code: python3 / deno / bash subprocess in a per-session
        //   scratch dir under {FRIDAY_HOME}/scratch/{sessionId}/, 30 s
        //   timeout, 100 KB stdout cap. No network inside the sandbox —
        //   scripts must use web_fetch via the outer tool loop.
        // - read_file / write_file / list_files: scoped to the same scratch
        //   dir so multi-step workflows (fetch → save → analyze in Python
        //   → read results) compose cleanly across turns.
        const adHocSessionId = session.sessionId || `session-${Date.now()}`;
        const webFetchTool = createWebFetchTool(logger);
        const webSearchTool = createWebSearchTool(logger);
        const runCodeTool = createRunCodeTool(adHocSessionId, logger, abortSignal);
        const fileIOTools = createFileIOTools(adHocSessionId, logger);
        // User-attached files (chat-input drop → /api/scratch/upload) live at
        // `{FRIDAY_HOME}/scratch/uploads/{workspaceId}/{chatId}/{md5}`. The
        // chat adapter surfaces them in user messages as `<attachment path="…"
        // mediaType="…" />` tags. read_attachment(path) is how the agent opens
        // them — scoped to this workspace+chat uploads dir.
        const readAttachmentTool = createReadAttachmentTool(workspaceId, session.streamId, logger);

        // delegate runs nested streamText sub-agents in-process. The child's
        // tool set is the parent's full composed set minus `delegate` itself
        // (plus a synthetic `finish` tool the delegate injects). We resolve
        // the child's tool set lazily via a thunk so `composeTools()` below
        // can run first; `allToolsRef` is assigned after composition and the
        // thunk reads it at child-`execute()` time.
        let allToolsRef: AtlasTools = {};
        const delegateTool = createDelegateTool(
          {
            writer,
            session: {
              sessionId: adHocSessionId,
              workspaceId,
              streamId: session.streamId,
              userId: userId,
              datetime: session.datetime,
            },
            platformModels,
            logger,
            abortSignal,
            repairToolCall,
            // Chat composes bundled-agent tools (`agent_<id>`) into the
            // parent's tool set. When the delegate inherits them, we need to
            // re-bind so the inner agent's stream events route through the
            // delegate proxy instead of leaking to the parent writer.
            // FSM-side callers don't compose these wrappers, so they leave
            // this hook unset and the delegate just passes inherited tools
            // through verbatim.
            rebindAgentTool,
            linkSummary: linkSummary ?? undefined,
            // Thread the workspace `.env` overlay so a delegated sub-agent's
            // MCP `from_environment` / `auto` wiring resolves from the
            // workspace `.env` — not just `process.env`. Without this, the
            // env-supply feature silently no-ops for delegated sub-agents.
            ...(envOverlay ? { envOverlay } : {}),
          },
          () => allToolsRef,
        );

        // Bundled-agent tools (`agent_<id>`) give the LLM direct one-step
        // access to Friday's specialist agents (web, gh, data-analyst, etc.)
        // without routing through a planner. Each wrapper self-gates on its
        // declared `environmentConfig.required` keys against `process.env`;
        // agents whose credentials are missing return `{}` and don't appear
        // in the composed tool set. Spread before direct/job/resource tools
        // so any name collision (there shouldn't be — `agent_` prefix) lets
        // direct tools win.
        const processEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        );
        const agentToolDeps = {
          writer,
          session: {
            sessionId: adHocSessionId,
            workspaceId,
            streamId: session.streamId,
            userId: userId,
            datetime: session.datetime,
          },
          platformModels,
          abortSignal,
          env: processEnv,
          logger,
        };
        const bundledAgentTools: AtlasTools = Object.assign(
          {},
          ...bundledAgents.map((agent) => createAgentTool(agent, agentToolDeps)),
        );

        const primaryTools: AtlasTools = {
          ...bundledAgentTools,
          ...connectServiceTool,
          ...connectCommunicatorTool,
          ...jobTools,
          ...artifactTools,
          ...createCreateArtifactTool({
            sessionId: adHocSessionId,
            workspaceId,
            streamId: session.streamId,
          }),
          ...createMemorySaveTool(workspaceId, logger),
          ...createSetUserIdentityTool(userId, logger),
          ...createRequestToolAccessTool({
            workspaceId,
            sessionId: adHocSessionId,
            workspacePermissions: wsConfig?.permissions,
            logger,
          }),
          ...createEnvTools({
            workspaceId,
            sessionId: adHocSessionId,
            daemonUrl: getAtlasDaemonUrl(),
            logger,
          }),
          ...webFetchTool,
          ...webSearchTool,
          ...runCodeTool,
          ...fileIOTools,
          ...readAttachmentTool,
          ...createWorkspaceOpsTools(logger),
          ...createBoundWorkspaceOpsTools(logger, workspaceId),
          ...createBoundDraftTools(logger, workspaceId),
          ...createBoundUpsertTools(logger, workspaceId),
          ...listCapabilitiesTool,
          ...searchMcpServersTool,
          ...installMcpServerTool,
          ...createMcpServerTool,
          ...enableMcpServerTool,
          ...disableMcpServerTool,
          ...listMcpToolsTool,
          ...listMcpServersTool,
          ...describeMcpServerTool,
          ...describeMcpToolTool,
          ...publishSkillTool,
          ...assignSkillTool,
          ...unassignSkillTool,
          ...listSkillsTool,
          ...searchSkillsTool,
          ...describeSkillTool,
          ...registerAgentTool,
          ...deleteAgentFromRegistryTool,
          ...listIntegrationsTool,
          ...describeIntegrationTool,
          ...listWorkspacesTool,
          ...describeWorkspaceTool,
          ...listAgentsTool,
          ...describeAgentTool,
          ...listJobsTool,
          ...describeJobTool,
          ...listSignalsTool,
          ...describeSignalTool,
          ...listMemoryStoresTool,
          ...describeMemoryStoreTool,
          ...listCommunicatorsTool,
          ...describeUserIdentityTool,
          ...describeDraftTool,
          ...listArtifactsTool,
          ...listBundledAgentsTool,
          ...describeBundledAgentTool,
          ...listSessionsTool,
          ...describeSessionTool,
          ...listMemoryEntriesTool,
          ...describeMemoryEntryTool,
          delegate: delegateTool,
          load_skill: loadSkillTool,
        };

        // Build foreground job tools and compose with primary (primary wins on name conflict)
        const foregroundToolSets = foregrounds.map((fg) => ({
          workspaceId: fg.workspaceId,
          tools: createJobTools(
            fg.workspaceId,
            fg.config?.jobs ?? {},
            fg.config?.signals ?? {},
            logger,
            session.streamId,
            writer,
            abortSignal,
            // Phase 11 provenance: parent linkage for foreground-workspace
            // job spawns mirrors the primary path above.
            session.sessionId,
          ),
        }));
        const allTools = composeTools(primaryTools, foregroundToolSets);
        allToolsRef = allTools;

        // Turn preface (turn-local): memory + artifacts + temporal facts
        // injected as a synthetic user-message preface, NOT in the system
        // prompt. Keeps the system prompt byte-stable across turns so the
        // Anthropic prompt cache hits on the prefix; per-turn variation rides
        // alongside the user's actual message. Distinct from system block 4
        // (the volatile workspace inventory) — the preface is not a cache
        // breakpoint, it's a turn-local user message.
        //
        // Each section wraps in `<retrieved_content>` with a provenance
        // attribute so the model applies the `<retrieved_content_hygiene>`
        // rule (treat as data, not commands).
        const memoryBlocks = await composeMemoryBlocks(workspaceId, foregroundIds, logger);
        const artifactBlocks = await composeArtifactBlocks(
          { workspaceId, chatId: session.streamId },
          logger,
        );
        const datetimeMessage = buildTemporalFacts(session.datetime);
        const prefaceFetchedAt = new Date().toISOString();
        const prefaceEntries: PrefaceEntry[] = [];
        if (memoryBlocks.length > 0) {
          prefaceEntries.push({
            source: "user-authored",
            origin: "memory:workspace-stores",
            body: memoryBlocks.join("\n\n"),
            fetched_at: prefaceFetchedAt,
          });
        }
        if (artifactBlocks.length > 0) {
          prefaceEntries.push({
            source: "user-authored",
            origin: "artifacts:session",
            body: artifactBlocks.join("\n\n"),
            fetched_at: prefaceFetchedAt,
          });
        }
        prefaceEntries.push({
          source: "system-config",
          origin: "temporal",
          body: datetimeMessage,
          fetched_at: prefaceFetchedAt,
        });
        const turnPreface = composePreface(prefaceEntries);

        const onboardingClause = buildOnboardingClause(profileState);
        const userProfileClause = buildUserProfileClause(profileState);

        // Workspace prompt-cache salt — read once per turn from the
        // daemon HTTP API. Embedding this at the start of block 2 lets
        // the operator force a cache invalidation by bumping the salt
        // (POST /_bump-cache-salt). When salt is 0 (never bumped) we
        // omit the tag entirely so the prefix matches what it was
        // before the salt mechanism existed — no behavior change for
        // workspaces that never use the button. Failures fall through
        // to "no salt"; a transient KV problem doesn't block a turn.
        let cacheSaltTag = "";
        try {
          const saltRes = await fetch(
            `${getAtlasDaemonUrl()}/api/workspaces/${encodeURIComponent(workspaceId)}/_cache-salt`,
          );
          if (saltRes.ok) {
            const data = (await saltRes.json()) as { salt?: number };
            const salt = typeof data.salt === "number" ? data.salt : 0;
            if (salt > 0) {
              cacheSaltTag = `<cache_salt workspace="${workspaceId}" version="${salt}"/>\n\n`;
            }
          }
        } catch (err) {
          logger.debug("cache-salt fetch failed; proceeding with no salt", {
            workspaceId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        const systemBlocks = getSystemBlocks(workspaceSection, {
          skills: skillsSection,
          userIdentity: userIdentitySection,
          onboarding: onboardingClause,
          userProfile: userProfileClause,
          cacheSaltTag,
        });
        const systemPrompt = flattenSystemBlocks(systemBlocks);

        // Capture system prompt context on every turn (fire-and-forget). The
        // stored snapshot reflects what the model actually saw on the latest
        // turn — useful for debugging stale-context bugs and replays.
        if (session.streamId) {
          // Capture each cache block separately so the chat-inspector can
          // render the breakpoint layout the model actually saw — block 1
          // (weeks-stable), block 2 (workspace-stable identity, optional),
          // block 3 (session-stable, optional), block 4 (volatile workspace
          // inventory), then the turn preface (memory + temporal, not a
          // breakpoint). The operator can spot prefix drift by comparing
          // block-by-block across turns instead of squinting at a single
          // 26K-char blob.
          const capturedSystemMessages: string[] = [systemBlocks.block1];
          if (systemBlocks.block2) capturedSystemMessages.push(systemBlocks.block2);
          if (systemBlocks.block3) capturedSystemMessages.push(systemBlocks.block3);
          capturedSystemMessages.push(systemBlocks.block4);
          capturedSystemMessages.push(turnPreface);
          ChatStorage.setSystemPromptContext(
            session.streamId,
            { systemMessages: capturedSystemMessages },
            workspaceId,
          ).catch((err: unknown) =>
            logger.warn("Failed to capture system prompt context", { error: err }),
          );
        }

        logger.debug("Workspace chat context prepared", {
          workspaceId,
          workspaceName: workspaceDetails.name,
          agentCount: workspaceDetails.agents.length,
          jobCount: workspaceDetails.jobs.length,
          signalCount: workspaceDetails.signals.length,
          artifactCount: workspaceDetails.artifacts.length,
          integrations: linkSummary ? linkSummary.credentials.length : "unavailable",
          userIdentity: userIdentitySection ? "available" : "unavailable",
        });

        let errorEmitted = false;

        try {
          // Per-turn model override (from the chat-input picker) takes precedence
          // over the daemon-wide default. `resolveModelFromString` throws on bad
          // spec / unknown provider / missing credentials — keep it inside this
          // try so the existing catch routes the resolver's real error through
          // the `data-error` writer (same path as a streamText failure) instead
          // of letting it escape into createUIMessageStream's generic
          // "An error occurred." fallback.
          const conversationalModel = session.modelOverride
            ? resolveModelFromString(session.modelOverride)
            : platformModels.get("conversational");
          logger.info("Conversational model resolved", {
            source: session.modelOverride ? "override" : "default",
            provider: conversationalModel.provider,
            modelId: conversationalModel.modelId,
            workspaceId,
          });
          // Drop cross-model assistant messages that carry reasoning parts.
          //
          // Two providers fail in opposite ways when replayed across model
          // boundaries:
          //   - Groq (llama-3.3): rejects any `reasoning` in input with HTTP 400
          //     "reasoning is not supported with this model".
          //   - OpenAI Responses API (gpt-5*, o*): server-side msg/rs ID pairs
          //     are co-dependent; stripping the reasoning part alone leaves
          //     the message half of the pair orphaned, yielding
          //     "Item 'msg_xxx' ... was provided without its required
          //     'reasoning' item: 'rs_xxx'".
          //
          // The only replay shape every provider tolerates is "message not
          // present at all", so we drop the whole turn rather than trying to
          // surgically edit a multi-provider-incompatible shape. Same-model
          // replays keep reasoning intact (tagged via MessageMetadata.provider
          // + modelId on the originating turn). Untagged messages are treated
          // as "unknown origin" — if they contain reasoning, drop them too.
          const sanitizedMessages = messages.filter((m) => {
            if (m.role !== "assistant") return true;
            const fromSameModel =
              m.metadata?.provider === conversationalModel.provider &&
              m.metadata?.modelId === conversationalModel.modelId;
            if (fromSameModel) return true;
            const hasReasoning = m.parts.some((p) => p.type === "reasoning");
            return !hasReasoning;
          });

          // Turn preface (memory + datetime) injected as a synthetic
          // user-message at position 0 — NOT inside `system`. This keeps
          // `system` byte-stable across turns so the Anthropic prompt
          // cache hits the prefix; turn-local variation lives in the
          // messages array where it doesn't poison the cacheable prefix.
          // The synthetic message is ephemeral — it isn't appended to
          // ChatStorage so it doesn't accumulate in the conversation.
          const messagesWithTurnPreface: AtlasUIMessage[] = turnPreface
            ? [
                {
                  id: crypto.randomUUID(),
                  role: "user",
                  parts: [{ type: "text", text: turnPreface }],
                },
                ...sanitizedMessages,
              ]
            : sanitizedMessages;
          const modelMessages = await convertToModelMessages(messagesWithTurnPreface, {
            convertDataPart: (part) => {
              if (part.type === "data-credential-linked") {
                const data = (
                  part as { type: string; data?: { displayName?: string; provider?: string } }
                ).data;
                const name = data?.displayName ?? data?.provider ?? "service";
                return { type: "text" as const, text: `Connected ${name}.` };
              }
              if (part.type === "data-env-applied") {
                const data = (
                  part as { type: string; data?: { scope?: string; keys?: string[] } }
                ).data;
                const scope = data?.scope === "global" ? "global" : "workspace";
                const keys = Array.isArray(data?.keys) ? data!.keys : [];
                const keyList = keys.length > 0 ? keys.join(", ") : "(none)";
                return {
                  type: "text" as const,
                  text: `Applied env write to ${scope} .env: ${keyList}.`,
                };
              }
              return undefined;
            },
          });

          // For Anthropic, split the system prompt into 3 cache breakpoints
          // (block1 weeks-stable, block2 workspace-stable, block3 session-
          // stable). The Anthropic provider in the AI SDK collects
          // consecutive system messages into a `system` array of text parts,
          // each carrying its own `cache_control`. Anthropic allows up to 4
          // breakpoints per request; we use 3 here, leaving 1 for future
          // turn-level use. Other providers see a single `system` string —
          // multi-system messages are not portable.
          // The AI SDK's Anthropic provider sets `.provider` to surface-
          // qualified ids like "anthropic.messages" and "anthropic.tools",
          // never the bare registry key. Match the family prefix so any
          // future Anthropic surface (Vertex, Bedrock, future endpoints)
          // also gets the multi-system-block + cache_control layout. A
          // strict `=== "anthropic"` check silently bypassed the entire
          // caching path — every turn went through the conventional
          // top-level `system` string, no cache_control was attached, and
          // every prefix wrote fresh.
          const isAnthropic = conversationalModel.provider.startsWith("anthropic");
          const systemModelMessages: ModelMessage[] = isAnthropic
            ? buildAnthropicSystemMessages(systemBlocks)
            : [];

          // Open the usage scope around streamText creation AND stream
          // consumption. `traceModel`'s wrapStream middleware captures
          // the counter reference at scope entry (during the first
          // `model.doStream` invocation); the mutation happens later
          // when the transform sees the `finish` chunk, by which point
          // the captured closure does the work — ALS context at finish
          // time doesn't matter. The await on `result.finishReason`
          // keeps the scope alive until every nested call (tool
          // executes, sub-agents) has settled. Nested in-process calls
          // ride this same scope through async/await propagation;
          // user-agent `ctx.llm` calls cross NATS, so they bridge via
          // `CapabilityContext.usageCounter` (see
          // ProcessAgentExecutor).
          await enterUsageScope(usageCounter, async () => {
            const result = streamText({
              model: conversationalModel,
              experimental_repairToolCall: repairToolCall,
              system: isAnthropic ? undefined : systemPrompt,
              messages: isAnthropic ? [...systemModelMessages, ...modelMessages] : modelMessages,
              allowSystemInMessages: isAnthropic ? true : undefined,
              tools: allTools,
              toolChoice: "auto",
              stopWhen: [
                stepCountIs(40),
                connectServiceSucceeded(),
                connectCommunicatorSucceeded(),
              ],
              maxOutputTokens: 20000,
              experimental_transform: smoothStream({ chunking: "word" }),
              maxRetries: 3,
              abortSignal,
              // Provider-level cache controls.
              //
              // Anthropic — per-block `cacheControl` markers sit on the
              //   system messages above. Setting a top-level
              //   `cache_control` here would land on the messages block
              //   AFTER block 3, violating Anthropic's non-increasing-
              //   TTL rule (1h cannot come after 5m). Leave it off.
              //
              // OpenAI — caching is automatic for prefixes ≥1024 tokens;
              //   no explicit markers are needed. The optional
              //   `promptCacheKey` is a routing hint that pins requests
              //   sharing a long common prefix to the same backend, which
              //   improves cache hit rate when the serving fleet would
              //   otherwise scatter them. Keying on `workspaceId` groups
              //   every chat in the same workspace onto the same cache.
              //
              // Other providers (Gemini, Groq) auto-cache without any
              // markers; their unused providerOptions are no-ops.
              providerOptions: { openai: { promptCacheKey: workspaceId } },
              onFinish: ({ text, steps, toolCalls, toolResults, reasoningText }) => {
                finalText = text;
                // J3: harvest internal tool calls from streamText's terminal
                // event. `collectToolUsageFromSteps` flattens per-step calls
                // (the AI SDK populates them under `steps[*].toolCalls` /
                // `.toolResults`) and falls back to top-level arrays. Mirrors
                // the canonical pattern in `from-llm.ts:195-211`.
                const collected = collectToolUsageFromSteps({ steps, toolCalls, toolResults });
                assembledToolCalls = collected.assembledToolCalls;
                assembledToolResults = collected.assembledToolResults;
                assembledReasoning = reasoningText || undefined;
                // Snapshot the accumulator at turn-end. By the time
                // onFinish fires the wrapStream middleware has already
                // processed the parent's `finish` chunk, and every
                // nested call's `wrapGenerate`/`wrapStream` has
                // resolved, so the counter holds the full turn total
                // (parent multi-step + all in-process nested calls +
                // any cross-NATS user-agent LLM calls).
                turnUsage = {
                  inputTokens: usageCounter.inputTokens,
                  outputTokens: usageCounter.outputTokens,
                  cacheReadTokens: usageCounter.cacheReadTokens,
                  cacheWriteTokens: usageCounter.cacheWriteTokens,
                };
                // Emit a `data-usage` chunk so the UI can render the
                // badge live for the in-flight assistant turn instead of
                // waiting for a page reload to read the persisted
                // metadata. The persisted message metadata (set just
                // before append, below) is the source of truth on
                // refresh; this chunk is a peer signal for the live
                // render path.
                if (stream) {
                  writer.write({ id: crypto.randomUUID(), type: "data-usage", data: turnUsage });
                }
              },
              onError: ({ error }) => {
                if (!error) return;

                logger.error("Stream error in workspace-chat agent", { error });

                const errorCause = createErrorCause(error);
                const displayMessage = getErrorDisplayMessage(errorCause);

                if (stream && !errorEmitted) {
                  writer.write({
                    id: crypto.randomUUID(),
                    type: "data-error",
                    data: { error: displayMessage, errorCause },
                  });
                  errorEmitted = true;
                }
              },
            });

            // Start piping the UI message stream
            let startTimestamp: string | undefined;
            let endTimestamp: string | undefined;

            writer.merge(
              result.toUIMessageStream({
                originalMessages: messages,
                messageMetadata: (metadata) => {
                  if (!startTimestamp) {
                    startTimestamp = new Date().toISOString();
                  }
                  if (metadata.part.type === "finish") {
                    endTimestamp = new Date().toISOString();
                  }
                  return {
                    startTimestamp,
                    endTimestamp,
                    provider: conversationalModel.provider,
                    modelId: conversationalModel.modelId,
                    agentId: "workspace-chat",
                    // Usage is set by `onFinish` (above) once the stream
                    // settles. On in-flight metadata frames this is
                    // undefined — UI consumers treat absence as
                    // "still streaming".
                    ...(turnUsage ? { usage: turnUsage } : {}),
                  };
                },
              }),
            );

            // Keep the usage scope alive until the stream actually
            // completes. Awaiting any of `result.finishReason`,
            // `result.usage`, etc. blocks here until the underlying
            // stream settles — at which point every wrapStream
            // middleware (parent + nested) has already mutated the
            // counter and the onFinish snapshot above has fired. The
            // outer pipeUIMessageStream consumer continues to pull
            // chunks while we're parked here, so this await doesn't
            // deadlock the merge.
            await result.finishReason;
          });
        } catch (error) {
          const errorCause = createErrorCause(error);
          const displayMessage = getErrorDisplayMessage(errorCause);

          logger.error("Workspace chat agent failed", { error, errorCause, displayMessage });

          if (stream && !errorEmitted) {
            writer.write({
              id: crypto.randomUUID(),
              type: "data-error",
              data: { error: displayMessage, errorCause },
            });
          }
        }
      },
    });

    try {
      await pipeUIMessageStream(persistStreamMessage, stream).catch((pipeError) => {
        logger.error("pipeUIMessageStream failed", { error: pipeError });
        throw pipeError;
      });
    } finally {
      cleanupSkills?.();
    }

    // J3: surface assembled tool-call telemetry on the result envelope.
    // The workspace-runtime side-channel writer (runtime.ts) reads
    // `result.toolCalls` / `result.toolResults` / `result.reasoning` to
    // populate `step:complete.{toolCalls,reasoning,artifactRefs}`. Without
    // these `extras`, agentBlocks for `type: atlas` agents (workspace-chat,
    // auto-triage flows) showed an empty `toolNames` array in the session
    // view even when many tools had been invoked internally.
    const artifactRefs = extractArtifactRefsFromToolResults(assembledToolResults, logger);
    return ok(
      { text: finalText },
      {
        toolCalls: assembledToolCalls,
        toolResults: assembledToolResults,
        ...(assembledReasoning && { reasoning: assembledReasoning }),
        ...(artifactRefs.length > 0 && { artifactRefs }),
      },
    );
  },
  environment: {
    required: [],
    optional: [{ name: "FRIDAY_DAEMON_URL", description: "Platform MCP server URL" }],
  },
});
