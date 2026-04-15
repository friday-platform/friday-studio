import type { NarrativeEntry } from "@atlas/agent-sdk";
import { z } from "zod";
import type { ReviewFinding } from "../jobs/review-target-workspace.types.ts";

export interface ReviewerInput {
  sessions: NarrativeEntry[];
  workspaceYml: string;
}

export type ReviewAgentFn = (input: ReviewerInput) => Promise<ReviewFinding[]>;

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

function detectWorkspaceDrift(
  sessions: NarrativeEntry[],
  config: ParsedWorkspaceConfig,
): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const configAgentIds = new Set(Object.keys(config.agents ?? {}));

  for (const session of sessions) {
    const agentId = session.metadata?.agentId;
    if (typeof agentId === "string" && !configAgentIds.has(agentId)) {
      const targetJobId =
        typeof session.metadata?.jobId === "string" ? session.metadata.jobId : undefined;
      findings.push({
        category: "drift",
        severity: "warn",
        summary: `Agent "${agentId}" referenced in session but missing from workspace.yml`,
        detail: `Session ${session.id} references agent "${agentId}" which is not declared in the workspace configuration.`,
        target_job_id: targetJobId ?? null,
      });
    }
  }

  return findings;
}

function detectAgentPromptIssues(config: ParsedWorkspaceConfig): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const agents = config.agents ?? {};

  for (const [agentId, agent] of Object.entries(agents)) {
    if (!agent.prompt) {
      findings.push({
        category: "prompt",
        severity: "warn",
        summary: `Agent "${agentId}" has no system-prompt stanza in workspace.yml`,
        detail: `Agent "${agentId}" is declared but missing a prompt field. This may cause unpredictable behavior.`,
      });
    }
  }

  return findings;
}

function detectFsmSmells(config: ParsedWorkspaceConfig): ReviewFinding[] {
  const findings: ReviewFinding[] = [];

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
      findings.push({
        category: "fsm",
        severity: "warn",
        summary: `State "${stateId}" is unreachable from initial state`,
        detail: `FSM state "${stateId}" cannot be reached from the initial state "${initial ?? "(none)"}". This may indicate dead configuration.`,
      });
    }
  }

  for (const [stateId, state] of Object.entries(states)) {
    const hasTransitions = state.transitions && Object.keys(state.transitions).length > 0;
    if (!hasTransitions && !state.terminal) {
      findings.push({
        category: "fsm",
        severity: "warn",
        summary: `State "${stateId}" has no outbound transitions and is not terminal`,
        detail: `FSM state "${stateId}" has no transitions and is not marked as terminal. Sessions entering this state will be stuck.`,
      });
    }
  }

  return findings;
}

export function reviewWorkspaceConfig(
  sessions: NarrativeEntry[],
  config: ParsedWorkspaceConfig,
): ReviewFinding[] {
  return [
    ...detectWorkspaceDrift(sessions, config),
    ...detectAgentPromptIssues(config),
    ...detectFsmSmells(config),
  ];
}

export function parseWorkspaceConfig(raw: string): ParsedWorkspaceConfig {
  const parsed: unknown = JSON.parse(raw);
  return ParsedWorkspaceConfigSchema.parse(parsed);
}

export const reviewWorkspace: ReviewAgentFn = (input) => {
  const config = parseWorkspaceConfig(input.workspaceYml);
  return Promise.resolve(reviewWorkspaceConfig(input.sessions, config));
};
