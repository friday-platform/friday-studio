import type { JobExecution, JobSpecification, WorkspaceConfig } from "@atlas/config";
import {
  extractCredentials,
  extractFSMAgents,
  type FSMAgentResponse,
} from "@atlas/config/mutations";
import { daemonFactory } from "../src/factory.ts";
import { extractJobIntegrations } from "./workspaces/index.ts";

/**
 * Format a job key into a display name.
 * Priority: title > formatted key (underscores to spaces, sentence case) > raw key.
 */
function formatJobName(jobId: string, job: JobSpecification): string {
  if (job.title) return job.title;
  const spaced = jobId.replace(/[-_]/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

interface ResolvedSignal {
  description: string;
  title?: string;
  schema?: Record<string, unknown>;
  provider: string;
  config?: Record<string, unknown>;
}

interface ResolvedAgent {
  id: string;
  nickname?: string;
  type: string;
  description?: string;
  prompt?: string;
  model?: string;
  tools?: string[];
  integrations: Array<{ provider: string; envVar: string }>;
}

/** Resolve trigger signal names to full signal definitions from workspace config. */
function resolveSignals(
  triggers: JobSpecification["triggers"],
  config: WorkspaceConfig,
): Record<string, ResolvedSignal> {
  const signals: Record<string, ResolvedSignal> = {};
  const signalDefs = config.signals ?? {};

  for (const trigger of triggers ?? []) {
    const name = trigger.signal;
    if (signals[name]) continue;
    const def = signalDefs[name];
    if (!def) continue;
    const resolved: ResolvedSignal = { description: def.description, provider: def.provider };
    if (def.title) resolved.title = def.title;
    if (def.schema) resolved.schema = def.schema;
    if ("config" in def && def.config) {
      resolved.config = { ...def.config };
    }
    signals[name] = resolved;
  }

  return signals;
}

/** Extract per-agent integration info: which env vars come from which providers. */
function extractAgentIntegrations(
  agentId: string,
  tools: string[] | undefined,
  config: WorkspaceConfig,
): Array<{ provider: string; envVar: string }> {
  const credentials = extractCredentials(config);
  const serverIds = new Set(tools ?? []);
  const result: Array<{ provider: string; envVar: string }> = [];

  for (const cred of credentials) {
    if (!cred.provider) continue;
    const parts = cred.path.split(":");
    const type = parts[0];
    const entityId = parts[1];
    const envVar = parts[2];
    if (!entityId || !envVar) continue;
    if (type === "mcp" && serverIds.has(entityId)) {
      result.push({ provider: cred.provider, envVar });
    } else if (type === "agent" && entityId === agentId) {
      result.push({ provider: cred.provider, envVar });
    }
  }

  return result;
}

/** Resolve agent refs from job execution to full agent details. */
function resolveAgents(
  agentRefs: JobExecution["agents"],
  config: WorkspaceConfig,
): ResolvedAgent[] {
  const agentDefs = config.agents ?? {};

  return agentRefs.map((ref) => {
    const id = typeof ref === "string" ? ref : ref.id;
    const nickname = typeof ref === "string" ? undefined : ref.nickname;
    const def = agentDefs[id];

    if (!def) {
      return { id, nickname, type: "unknown", integrations: [] };
    }

    const resolved: ResolvedAgent = {
      id,
      nickname,
      type: def.type,
      description: def.description,
      integrations: [],
    };

    if (def.type === "llm") {
      resolved.prompt = def.config.prompt;
      resolved.model = def.config.model;
      resolved.tools = def.config.tools;
      resolved.integrations = extractAgentIntegrations(id, def.config.tools, config);
    } else if (def.type === "atlas") {
      resolved.prompt = def.prompt;
      resolved.integrations = extractAgentIntegrations(id, undefined, config);
    } else if (def.type === "system") {
      resolved.prompt = def.config?.prompt;
      resolved.tools = def.config?.tools;
      resolved.integrations = extractAgentIntegrations(id, def.config?.tools, config);
    }

    return resolved;
  });
}

const jobsRoutes = daemonFactory.createApp().get("/:jobId/:workspaceId", async (c) => {
  const jobId = c.req.param("jobId");
  const workspaceId = c.req.param("workspaceId");

  const ctx = c.get("app");
  const manager = ctx.getWorkspaceManager();
  const config = await manager.getWorkspaceConfig(workspaceId);

  if (!config) {
    return c.json({ error: `Workspace not found: ${workspaceId}` }, 404);
  }

  const jobs = config.workspace?.jobs ?? {};
  const job = jobs[jobId];

  if (!job) {
    return c.json({ error: `Job not found: ${jobId}` }, 404);
  }

  const workspaceConfig = config.workspace;

  let agents: (ResolvedAgent | FSMAgentResponse)[];
  let integrations: string[];

  if (job.fsm) {
    agents = Object.values(extractFSMAgents(workspaceConfig)).filter((a) => a.jobId === jobId);
    integrations = extractJobIntegrations(job, workspaceConfig);
  } else {
    const resolved = resolveAgents(job.execution?.agents ?? [], workspaceConfig);
    agents = resolved;
    integrations = [...new Set(resolved.flatMap((a) => a.integrations.map((i) => i.provider)))];
  }

  return c.json({
    id: jobId,
    name: formatJobName(jobId, job),
    description: job.description,
    integrations,
    signals: resolveSignals(job.triggers, workspaceConfig),
    agents,
  });
});

export { jobsRoutes };
export type JobsRoutes = typeof jobsRoutes;
