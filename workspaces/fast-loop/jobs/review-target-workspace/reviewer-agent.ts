import type { KVCorpus, MemoryAdapter, NarrativeEntry } from "@atlas/agent-sdk";
import { z } from "zod";
import type { FindingCategory, FindingEntry, FindingSeverity } from "./finding.ts";
import { toNarrativeEntry } from "./finding.ts";

const ParsedAgentConfigSchema = z.object({
  type: z.string().optional(),
  agent: z.string().optional(),
  description: z.string().optional(),
  prompt: z.string().optional(),
});

const ParsedFsmStateSchema = z.object({
  transitions: z.record(z.string(), z.string()).optional(),
  terminal: z.boolean().optional(),
});

const ParsedWorkspaceConfigSchema = z.object({
  agents: z.record(z.string(), ParsedAgentConfigSchema).optional(),
  fsm: z
    .object({ states: z.record(z.string(), ParsedFsmStateSchema), initial: z.string().optional() })
    .optional(),
});

export type ParsedWorkspaceConfig = z.infer<typeof ParsedWorkspaceConfigSchema>;

export interface ReviewerDeps {
  memoryAdapter: MemoryAdapter;
  targetWorkspaceId: string;
}

export interface ReviewerInput {
  sessions: NarrativeEntry[];
}

function makeFinding(
  text: string,
  category: FindingCategory,
  severity: FindingSeverity,
  opts?: { target_job_id?: string; evidence?: string },
): FindingEntry {
  return {
    id: crypto.randomUUID(),
    text,
    author: "reviewer-agent",
    createdAt: new Date().toISOString(),
    metadata: { category, severity, target_job_id: opts?.target_job_id, evidence: opts?.evidence },
  };
}

export function detectDrift(
  sessions: NarrativeEntry[],
  config: ParsedWorkspaceConfig,
): FindingEntry[] {
  const findings: FindingEntry[] = [];
  const configAgentIds = new Set(Object.keys(config.agents ?? {}));

  for (const session of sessions) {
    const agentId = session.metadata?.agentId;
    if (typeof agentId === "string" && !configAgentIds.has(agentId)) {
      const targetJobId =
        typeof session.metadata?.jobId === "string" ? session.metadata.jobId : undefined;
      findings.push(
        makeFinding(
          `Agent "${agentId}" referenced in session but missing from workspace.yml`,
          "drift",
          "warning",
          { target_job_id: targetJobId },
        ),
      );
    }
  }

  return findings;
}

export function detectPromptIssues(config: ParsedWorkspaceConfig): FindingEntry[] {
  const findings: FindingEntry[] = [];
  const agents = config.agents ?? {};

  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent.prompt) {
      findings.push(
        makeFinding(
          `Agent "${agentId}" has no system-prompt stanza in workspace.yml`,
          "prompt",
          "warning",
        ),
      );
    }
  }

  return findings;
}

export function detectFsmSmells(config: ParsedWorkspaceConfig): FindingEntry[] {
  const findings: FindingEntry[] = [];

  if (!config.fsm) return findings;

  const { states, initial } = config.fsm;
  const stateIds = new Set(Object.keys(states));
  const reachable = new Set<string>();

  if (initial && stateIds.has(initial)) {
    const queue = [initial];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || reachable.has(current)) continue;
      reachable.add(current);
      const state = states[current];
      if (state?.transitions) {
        for (const target of Object.values(state.transitions)) {
          if (stateIds.has(target) && !reachable.has(target)) {
            queue.push(target);
          }
        }
      }
    }
  }

  for (const stateId of stateIds) {
    if (!reachable.has(stateId) && stateId !== initial) {
      findings.push(
        makeFinding(`State "${stateId}" is unreachable from initial state`, "fsm", "warning"),
      );
    }
  }

  for (const [stateId, state] of Object.entries(states)) {
    const hasTransitions = state.transitions && Object.keys(state.transitions).length > 0;
    if (!hasTransitions && !state.terminal) {
      findings.push(
        makeFinding(
          `State "${stateId}" has no outbound transitions and is not terminal`,
          "fsm",
          "warning",
        ),
      );
    }
  }

  return findings;
}

export function parseWorkspaceConfig(raw: string): ParsedWorkspaceConfig {
  const parsed: unknown = JSON.parse(raw);
  return ParsedWorkspaceConfigSchema.parse(parsed);
}

export function reviewWorkspaceConfig(
  sessions: NarrativeEntry[],
  config: ParsedWorkspaceConfig,
): FindingEntry[] {
  return [
    ...detectDrift(sessions, config),
    ...detectPromptIssues(config),
    ...detectFsmSmells(config),
  ];
}

export async function runReview(deps: ReviewerDeps, input: ReviewerInput): Promise<FindingEntry[]> {
  const { memoryAdapter, targetWorkspaceId } = deps;

  const kv: KVCorpus = await memoryAdapter.corpus(targetWorkspaceId, "config", "kv");
  const workspaceYml = await kv.get<string>("workspace.yml");
  const config = parseWorkspaceConfig(workspaceYml ?? "{}");

  const findings = reviewWorkspaceConfig(input.sessions, config);

  const notes = await memoryAdapter.corpus(targetWorkspaceId, "notes", "narrative");
  for (const finding of findings) {
    await notes.append(toNarrativeEntry(finding));
  }

  return findings;
}
