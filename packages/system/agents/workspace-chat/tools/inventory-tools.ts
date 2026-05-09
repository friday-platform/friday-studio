/**
 * Inventory tools — list / describe across workspace-scoped domains.
 *
 * Most domains have identical shape: `list_X(scope=workspace)` returns a
 * names index, `describe_X(name, scope=workspace)` returns a single record.
 * Defaults to the current chat's workspace; scope parameters opt into
 * broader views (registry, all). Each tool is intentionally small — the
 * complexity lives in describing the verb against its peers in the tool
 * description, not in the execute body.
 *
 * Tools shipped here:
 *   - list_workspaces, describe_workspace
 *   - list_agents, describe_agent
 *   - list_jobs, describe_job
 *   - list_signals, describe_signal
 *   - list_memory_stores, describe_memory_store
 *   - list_communicators
 *   - describe_user_identity
 *   - describe_draft
 *   - list_artifacts (artifact listing — describe via `artifacts_get`)
 */

import type { AtlasTools } from "@atlas/agent-sdk";
import { client, parseResult } from "@atlas/client/v2";
import { CommunicatorKindSchema, type WorkspaceConfig } from "@atlas/config";
import type { Logger } from "@atlas/logger";
import { getAtlasDaemonUrl } from "@atlas/oapi-client";
import { stringifyError } from "@atlas/utils";
import { tool } from "ai";
import { z } from "zod";

const WorkspaceScope = z
  .enum(["workspace"])
  .optional()
  .describe("Scope. 'workspace' (default) is the current chat's workspace.");

const AgentScope = z
  .enum(["workspace", "registry", "all"])
  .default("workspace")
  .describe(
    "Where to look. 'workspace' (default) — agents wired into this chat's workspace. " +
      "'registry' — every user agent installed under {FRIDAY_HOME}/agents. " +
      "'all' — registry plus bundled atlas agents.",
  );

interface DaemonResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status?: number;
}

async function daemonGet<T>(path: string, logger: Logger, op: string): Promise<DaemonResponse<T>> {
  const url = `${getAtlasDaemonUrl()}${path}`;
  try {
    const res = await fetch(url);
    if (!res.ok) {
      logger.warn(`${op} failed`, { url, status: res.status });
      const text = await res.text();
      return {
        ok: false,
        status: res.status,
        error: `${op} failed: HTTP ${res.status}${text ? `: ${text}` : ""}`,
      };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (err) {
    logger.warn(`${op} threw`, { url, error: stringifyError(err) });
    return { ok: false, error: `${op} failed: network error` };
  }
}

// =============================================================================
// Workspaces
// =============================================================================

export interface WorkspaceListEntry {
  id: string;
  name: string;
  description?: string;
  type: "persistent" | "ephemeral";
}

export function createListWorkspacesTool(logger: Logger): AtlasTools {
  return {
    list_workspaces: tool({
      description:
        "List every workspace registered with the daemon. Returns id + name + type + description. " +
        "Use this when the chat needs to point at or compare workspaces beyond the current one — " +
        "describe_workspace pulls full details for any id from this list.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await daemonGet<Array<WorkspaceListEntry & { metadata?: unknown }>>(
          "/api/workspaces",
          logger,
          "list_workspaces",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        const data = result.data ?? [];
        return { ok: true as const, workspaces: data, count: data.length };
      },
    }),
  };
}

export function createDescribeWorkspaceTool(
  defaultWorkspaceId: string,
  logger: Logger,
): AtlasTools {
  return {
    describe_workspace: tool({
      description:
        "Return the full workspace record (id, name, description, type, config) for a single id. " +
        "Defaults to the current chat's workspace; pass `id` to inspect another. Output includes " +
        "the full `config` object (workspace.yml shape) so the caller can read agents, jobs, " +
        "signals, MCP servers, memory stores, and communicators in one shot.",
      inputSchema: z.object({
        id: z
          .string()
          .min(1)
          .optional()
          .describe("Workspace id. Defaults to the current chat's workspace."),
      }),
      execute: async ({ id }) => {
        const target = id ?? defaultWorkspaceId;
        const result = await daemonGet<unknown>(
          `/api/workspaces/${encodeURIComponent(target)}`,
          logger,
          "describe_workspace",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, workspace: result.data };
      },
    }),
  };
}

// =============================================================================
// Agents
// =============================================================================

export function createListAgentsTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    list_agents: tool({
      description:
        "List agents. Default scope='workspace' returns agents wired into the current chat's " +
        "workspace (id + type — `bundled`, `user`, `llm` — and description). scope='registry' " +
        "returns every user agent installed under the local agents dir. scope='all' returns the " +
        "registry plus bundled atlas agents (web, gh, slack, etc.). To inspect a single agent, " +
        "follow up with describe_agent(id).",
      inputSchema: z.object({ scope: AgentScope.optional() }),
      execute: async ({ scope }) => {
        const target = scope ?? "workspace";
        if (target === "workspace") {
          const result = await daemonGet<unknown>(
            `/api/workspaces/${encodeURIComponent(defaultWorkspaceId)}/agents`,
            logger,
            "list_agents",
          );
          if (!result.ok) return { ok: false as const, error: result.error };
          const agents = Array.isArray(result.data) ? result.data : [];
          return { ok: true as const, scope: target, agents, count: agents.length };
        }
        const result = await daemonGet<{ agents?: unknown[]; total?: number }>(
          "/api/agents",
          logger,
          "list_agents",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        const agents = Array.isArray(result.data?.agents) ? result.data.agents : [];
        return { ok: true as const, scope: target, agents, count: agents.length };
      },
    }),
  };
}

export function createDescribeAgentTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    describe_agent: tool({
      description:
        "Return full details for a single agent. scope='registry' (default) hits the global " +
        "agent registry at /api/agents/:id and returns metadata + inputSchema + outputSchema + " +
        "sourceLocation. scope='workspace' returns the wired config from the workspace's " +
        "agents list — useful for inspecting type:llm overrides like prompt or tools.",
      inputSchema: z.object({
        id: z.string().min(1).describe("Agent id (e.g. 'triage-agent', 'web', 'gh')."),
        scope: z
          .enum(["registry", "workspace"])
          .default("registry")
          .describe(
            "Where to look up the agent. 'registry' (default) returns global metadata; " +
              "'workspace' returns the wired entry from this chat's workspace.",
          )
          .optional(),
      }),
      execute: async ({ id, scope }) => {
        const target = scope ?? "registry";
        const path =
          target === "workspace"
            ? `/api/workspaces/${encodeURIComponent(defaultWorkspaceId)}/agents/${encodeURIComponent(id)}`
            : `/api/agents/${encodeURIComponent(id)}`;
        const result = await daemonGet<unknown>(path, logger, "describe_agent");
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, scope: target, agent: result.data };
      },
    }),
  };
}

// =============================================================================
// Jobs
// =============================================================================

interface JobEntry {
  id: string;
  name: string;
  description?: string;
}

export function createListJobsTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    list_jobs: tool({
      description:
        "List jobs configured on the current chat's workspace. Returns id + name + description " +
        "per job. Each workspace job is also bound as a callable tool with the same name — this " +
        "tool gives a flat overview of which jobs exist and what they do, separate from invoking " +
        "them. Use describe_job(name) to pull the full FSM definition.",
      inputSchema: z.object({ scope: WorkspaceScope }),
      execute: async () => {
        const result = await daemonGet<JobEntry[]>(
          `/api/workspaces/${encodeURIComponent(defaultWorkspaceId)}/jobs`,
          logger,
          "list_jobs",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        const jobs = Array.isArray(result.data) ? result.data : [];
        return { ok: true as const, jobs, count: jobs.length };
      },
    }),
  };
}

export function createDescribeJobTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    describe_job: tool({
      description:
        "Return the full FSM definition for a single job in this workspace, including agents, " +
        "trigger, validation strategy, and skill filter. For invocation, call the bound job tool " +
        "directly (its name matches the job name).",
      inputSchema: z.object({
        name: z.string().min(1).describe("Job name as listed in workspace.yml jobs."),
        scope: WorkspaceScope,
      }),
      execute: async ({ name }) => {
        const cfgResult = await parseResult(
          client.workspace[":workspaceId"].config.$get({
            param: { workspaceId: defaultWorkspaceId },
          }),
        );
        if (!cfgResult.ok) {
          logger.warn("describe_job: config fetch failed", {
            workspaceId: defaultWorkspaceId,
            error: cfgResult.error,
          });
          return { ok: false as const, error: "describe_job: failed to load workspace config" };
        }
        const config = (cfgResult.data as { config?: WorkspaceConfig }).config;
        const job = config?.jobs?.[name];
        if (!job) {
          return { ok: false as const, error: `Job "${name}" not found in this workspace.` };
        }
        return { ok: true as const, job };
      },
    }),
  };
}

// =============================================================================
// Signals
// =============================================================================

export function createListSignalsTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    list_signals: tool({
      description:
        "List signals configured on the current chat's workspace. Each signal entry includes " +
        "name, provider, and the trigger config — http path, cron schedule, slack/discord " +
        "channel, etc. Use this to answer 'what signals fire on this workspace?' or 'how do I " +
        "trigger X?'.",
      inputSchema: z.object({ scope: WorkspaceScope }),
      execute: async () => {
        const result = await daemonGet<{ signals?: unknown[] }>(
          `/api/workspaces/${encodeURIComponent(defaultWorkspaceId)}/signals`,
          logger,
          "list_signals",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        const signals = Array.isArray(result.data?.signals) ? result.data.signals : [];
        return { ok: true as const, signals, count: signals.length };
      },
    }),
  };
}

export function createDescribeSignalTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    describe_signal: tool({
      description:
        "Return the full config for a single signal in this workspace — provider, trigger " +
        "config, and any handler / job binding.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Signal name as configured on the workspace."),
        scope: WorkspaceScope,
      }),
      execute: async ({ name }) => {
        const cfgResult = await parseResult(
          client.workspace[":workspaceId"].config.$get({
            param: { workspaceId: defaultWorkspaceId },
          }),
        );
        if (!cfgResult.ok) {
          logger.warn("describe_signal: config fetch failed", {
            workspaceId: defaultWorkspaceId,
            error: cfgResult.error,
          });
          return { ok: false as const, error: "describe_signal: failed to load workspace config" };
        }
        const config = (cfgResult.data as { config?: WorkspaceConfig }).config;
        const signal = config?.signals?.[name];
        if (!signal) {
          return { ok: false as const, error: `Signal "${name}" not found in this workspace.` };
        }
        return { ok: true as const, signal };
      },
    }),
  };
}

// =============================================================================
// Memory stores (config) — distinct from memory entries (data)
// =============================================================================

export function createListMemoryStoresTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    list_memory_stores: tool({
      description:
        "List memory store configurations declared on the current chat's workspace — " +
        "owned stores plus any cross-workspace mounts. For the contents of a store, use " +
        "list_memory_entries(memoryName) instead; this tool is the config view.",
      inputSchema: z.object({ scope: WorkspaceScope }),
      execute: async () => {
        const cfgResult = await parseResult(
          client.workspace[":workspaceId"].config.$get({
            param: { workspaceId: defaultWorkspaceId },
          }),
        );
        if (!cfgResult.ok) {
          logger.warn("list_memory_stores: config fetch failed", {
            workspaceId: defaultWorkspaceId,
            error: cfgResult.error,
          });
          return {
            ok: false as const,
            error: "list_memory_stores: failed to load workspace config",
          };
        }
        const config = (cfgResult.data as { config?: WorkspaceConfig }).config;
        const own = (config?.memory?.own ?? []).map((s) => ({
          name: s.name,
          kind: "own" as const,
          type: s.type,
          ...(s.strategy ? { strategy: s.strategy } : {}),
          ...(s.ttl ? { ttl: s.ttl } : {}),
        }));
        const mounts = (config?.memory?.mounts ?? []).map((m) => ({
          name: m.name,
          kind: "mount" as const,
          mode: m.mode,
          source: m.source,
          scope: m.scope,
        }));
        const stores = [...own, ...mounts];
        return { ok: true as const, stores, count: stores.length };
      },
    }),
  };
}

export function createDescribeMemoryStoreTool(
  defaultWorkspaceId: string,
  _logger: Logger,
): AtlasTools {
  return {
    describe_memory_store: tool({
      description:
        "Return the config for a single memory store on this workspace. Use list_memory_entries " +
        "to read the actual entries inside a store.",
      inputSchema: z.object({
        name: z.string().min(1).describe("Memory store name."),
        scope: WorkspaceScope,
      }),
      execute: async ({ name }) => {
        const cfgResult = await parseResult(
          client.workspace[":workspaceId"].config.$get({
            param: { workspaceId: defaultWorkspaceId },
          }),
        );
        if (!cfgResult.ok) {
          return {
            ok: false as const,
            error: "describe_memory_store: failed to load workspace config",
          };
        }
        const config = (cfgResult.data as { config?: WorkspaceConfig }).config;
        const own = config?.memory?.own?.find((s) => s.name === name);
        if (own) return { ok: true as const, store: { kind: "own", ...own } };
        const mount = config?.memory?.mounts?.find((m) => m.name === name);
        if (mount) return { ok: true as const, store: { kind: "mount", ...mount } };
        return { ok: false as const, error: `Memory store "${name}" not found in this workspace.` };
      },
    }),
  };
}

// =============================================================================
// Communicators
// =============================================================================

export function createListCommunicatorsTool(
  defaultWorkspaceId: string,
  _logger: Logger,
): AtlasTools {
  return {
    list_communicators: tool({
      description:
        "List the communicator kinds (slack, telegram, discord, teams, whatsapp) available on " +
        "the platform with their wiring status on the current chat's workspace. Use this before " +
        "`connect_communicator` to see which surfaces are available and which still need wiring.",
      inputSchema: z.object({ scope: WorkspaceScope }),
      execute: async () => {
        const cfgResult = await parseResult(
          client.workspace[":workspaceId"].config.$get({
            param: { workspaceId: defaultWorkspaceId },
          }),
        );
        if (!cfgResult.ok) {
          return {
            ok: false as const,
            error: "list_communicators: failed to load workspace config",
          };
        }
        const config = (cfgResult.data as { config?: WorkspaceConfig }).config;
        const wired = config?.communicators ?? {};
        const communicators = CommunicatorKindSchema.options.map((kind) => ({
          kind,
          wired: kind in wired,
        }));
        return { ok: true as const, communicators, count: communicators.length };
      },
    }),
  };
}

// =============================================================================
// User identity
// =============================================================================

export function createDescribeUserIdentityTool(logger: Logger): AtlasTools {
  return {
    describe_user_identity: tool({
      description:
        "Return the chat user's identity — name, email, and onboarding state from the daemon's " +
        "user record (and `/api/me` when the user record is missing fields). Per-user; no scope " +
        "parameter. Use before personalizing a response or asking onboarding-style questions.",
      inputSchema: z.object({}),
      execute: async () => {
        const result = await daemonGet<{ user?: unknown; userId?: string }>(
          "/api/me",
          logger,
          "describe_user_identity",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        return {
          ok: true as const,
          identity: result.data?.user ?? null,
          userId: result.data?.userId,
        };
      },
    }),
  };
}

// =============================================================================
// Drafts
// =============================================================================

export function createDescribeDraftTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    describe_draft: tool({
      description:
        "Return the current draft state for this workspace — full draft config plus validation " +
        "issues if any. Use this before publish_draft to confirm what's about to land. Returns " +
        "ok:false with a 404 marker when no draft is in flight.",
      inputSchema: z.object({ scope: WorkspaceScope }),
      execute: async () => {
        const result = await daemonGet<unknown>(
          `/api/workspaces/${encodeURIComponent(defaultWorkspaceId)}/draft`,
          logger,
          "describe_draft",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        return { ok: true as const, draft: result.data };
      },
    }),
  };
}

// =============================================================================
// Artifacts (list — describe is the existing artifacts_get)
// =============================================================================

export function createListArtifactsTool(defaultWorkspaceId: string, logger: Logger): AtlasTools {
  return {
    list_artifacts: tool({
      description:
        "List artifacts on the current chat's workspace. Returns id + type + title + summary per " +
        "artifact. To pull the full artifact body, use `artifacts_get(id)`. Optional `sessionId` " +
        "filter scopes the list to a single session's outputs.",
      inputSchema: z.object({
        sessionId: z
          .string()
          .min(1)
          .optional()
          .describe("Filter to artifacts produced by this session id."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .default(50)
          .optional()
          .describe("Max artifacts to return. Defaults to 50, hard cap 200."),
      }),
      execute: async ({ sessionId, limit }) => {
        const params = new URLSearchParams();
        params.set("workspaceId", defaultWorkspaceId);
        if (sessionId) params.set("sessionId", sessionId);
        if (limit !== undefined) params.set("limit", String(limit));
        const result = await daemonGet<{ artifacts?: unknown[] } | unknown[]>(
          `/api/artifacts?${params.toString()}`,
          logger,
          "list_artifacts",
        );
        if (!result.ok) return { ok: false as const, error: result.error };
        const data = result.data;
        const artifacts = Array.isArray(data)
          ? data
          : Array.isArray((data as { artifacts?: unknown[] })?.artifacts)
            ? (data as { artifacts: unknown[] }).artifacts
            : [];
        return { ok: true as const, artifacts, count: artifacts.length };
      },
    }),
  };
}
