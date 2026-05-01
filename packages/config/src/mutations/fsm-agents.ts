/**
 * FSM agent extraction and mutation functions for workspace configuration
 *
 * Pure functions that extract FSM-embedded agents and transform WorkspaceConfig,
 * returning MutationResult. No side effects - callers are responsible for persistence.
 */

import { type Draft, produce } from "immer";
import { z } from "zod";
import { type JobSpecification, JobSpecificationSchema } from "../jobs.ts";
import type { WorkspaceConfig } from "../workspace.ts";
import { type FSMAction, parseInlineFSM } from "./fsm-types.ts";
import { type MutationResult, notFoundError, typeChangeError, validationError } from "./types.ts";

// ==============================================================================
// FSM AGENT RESPONSE TYPE
// ==============================================================================

/**
 * FSM-embedded agent response format for API.
 * Agents are identified by path: jobId:stateId
 *
 * Each FSM state has at most one agent/llm action in its entry array.
 */
export interface FSMAgentResponse {
  id: string;
  jobId: string;
  stateId: string;
  entryIndex: number;
  type: "agent" | "llm";
  // Agent-specific (type: agent)
  agentId?: string;
  // LLM-specific (type: llm)
  provider?: string;
  model?: string;
  // Common editable fields
  prompt?: string;
  tools?: string[];
  outputTo?: string;
  outputType?: string;
}

// ==============================================================================
// INTERNAL HELPERS
// ==============================================================================

/**
 * Type-safe accessor for job specifications using Zod parsing.
 * Returns undefined if the job doesn't exist or fails schema validation.
 *
 * @param config - Workspace configuration
 * @param jobId - Job identifier
 * @returns Parsed JobSpecification or undefined
 */
function getJob(config: WorkspaceConfig, jobId: string): JobSpecification | undefined {
  const rawJob = config.jobs?.[jobId];
  if (rawJob === undefined) return undefined;
  const result = JobSpecificationSchema.safeParse(rawJob);
  return result.success ? result.data : undefined;
}

// ==============================================================================
// PATH RESOLUTION
// ==============================================================================

/**
 * Resolved FSM agent path. Contains indices needed to navigate to the action.
 * Returned by resolveFSMAgent after locating an agent.
 */
interface ResolvedFSMAgentPath {
  jobId: string;
  stateId: string;
  entryIndex: number;
  actionType: "agent" | "llm";
}

/**
 * Schema for validating a single job's FSM structure.
 * Entry arrays are optional since final states don't have them.
 */
const FSMJobSchema = z.object({
  fsm: z.object({
    states: z.record(z.string(), z.object({ entry: z.array(z.unknown()).optional() })),
  }),
});

/**
 * Safely navigates to and returns the entry array for mutation.
 * Uses Zod parsing to validate the specific path exists in the draft.
 */
function getEntryArrayFromDraft(
  draft: Draft<WorkspaceConfig>,
  jobId: string,
  stateId: string,
): Draft<FSMAction>[] | null {
  // Get raw job from draft
  const rawJob = (draft.jobs as Record<string, unknown> | undefined)?.[jobId];
  if (!rawJob) return null;

  // Parse just this job to validate FSM structure
  const parsed = FSMJobSchema.safeParse(rawJob);
  if (!parsed.success) return null;

  // Validate state exists
  const state = parsed.data.fsm.states[stateId];
  if (!state) return null;

  // Return the draft's entry array for mutation (not the parsed copy)
  const draftJob = rawJob as { fsm?: { states?: Record<string, { entry?: Draft<FSMAction>[] }> } };
  return draftJob.fsm?.states?.[stateId]?.entry ?? null;
}

/**
 * Resolves an FSM agent path to its entry index within the workspace config.
 *
 * Each FSM state has at most one agent/llm action in its entry array.
 * This function finds that action by scanning the entry array and returns
 * the path info needed to navigate to it.
 *
 * Path format: `{jobId}:{stateId}`
 *
 * Examples:
 * - "monitor-and-summarize-updates:step_0" → the LLM in step_0
 * - "manual-research-and-save:step_0" → the bundled agent in step_0
 *
 * @param config - Workspace configuration to search
 * @param pathId - Path ID in format "jobId:stateId"
 * @returns Resolved path with entry index and action type, or null if not found
 */
function resolveFSMAgent(config: WorkspaceConfig, pathId: string): ResolvedFSMAgentPath | null {
  const parts = pathId.split(":");

  // Exactly 2 parts: jobId:stateId
  if (parts.length !== 2) return null;

  const jobId = parts[0];
  const stateId = parts[1];

  if (!jobId || !stateId) return null;

  // Navigate to job/state
  const job = getJob(config, jobId);
  if (!job?.fsm) return null;

  // Parse FSM with Zod schema - return null for invalid FSMs.
  const parsed = parseInlineFSM(job.fsm, jobId);
  if (!parsed.success) return null;
  const fsm = parsed.data;

  const state = fsm.states?.[stateId];
  if (!state?.entry) return null;

  // Find the single agent/llm action in entry array
  for (let i = 0; i < state.entry.length; i++) {
    const rawAction = state.entry[i];
    if (rawAction?.type === "agent" || rawAction?.type === "llm") {
      return { jobId, stateId, entryIndex: i, actionType: rawAction.type };
    }
  }

  return null;
}

// ==============================================================================
// FSM AGENT UPDATE SCHEMA
// ==============================================================================

/**
 * Schema for updating an FSM-embedded agent.
 * Supports both bundled agents (type: agent) and inline LLMs (type: llm).
 */
export const FSMAgentUpdateSchema = z.discriminatedUnion("type", [
  // Bundled agent call - editable: prompt
  z.object({ type: z.literal("agent"), prompt: z.string().optional() }),
  // Inline LLM - editable: prompt, model
  z.object({ type: z.literal("llm"), prompt: z.string().optional(), model: z.string().optional() }),
]);

export type FSMAgentUpdate = z.infer<typeof FSMAgentUpdateSchema>;

// ==============================================================================
// FSM AGENT MUTATIONS
// ==============================================================================

/**
 * Update an FSM-embedded agent in the workspace configuration.
 * Applies partial updates to the agent action at the specified path.
 *
 * @param config - Current workspace configuration
 * @param pathId - Path ID in format "jobId:stateId"
 * @param update - Partial update to apply
 * @returns MutationResult with updated config or error
 */
export function updateFSMAgent(
  config: WorkspaceConfig,
  pathId: string,
  update: FSMAgentUpdate,
): MutationResult<WorkspaceConfig> {
  const resolved = resolveFSMAgent(config, pathId);
  if (!resolved) {
    const parts = pathId.split(":");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return {
        ok: false,
        error: validationError("Invalid agent path ID format. Expected: jobId:stateId"),
      };
    }
    return { ok: false, error: notFoundError(pathId, "agent") };
  }

  const { jobId, stateId, entryIndex, actionType } = resolved;

  // Verify action type matches update type
  if (actionType !== update.type) {
    return { ok: false, error: typeChangeError(actionType, update.type, "action type") };
  }

  const value = produce(config, (draft) => {
    const entry = getEntryArrayFromDraft(draft, jobId, stateId);
    // resolveFSMAgent validated path exists, but defensive check for type safety
    if (!entry) return;

    const draftAction = entry[entryIndex];
    if (!draftAction) return;

    // Mutate draft action in place based on type
    if (update.type === "agent" && draftAction.type === "agent") {
      if (update.prompt !== undefined) draftAction.prompt = update.prompt;
    } else if (update.type === "llm" && draftAction.type === "llm") {
      if (update.prompt !== undefined) draftAction.prompt = update.prompt;
      if (update.model !== undefined) draftAction.model = update.model;
    }
  });

  return { ok: true, value };
}

// ==============================================================================
// FSM AGENT EXTRACTION
// ==============================================================================

/**
 * Extract all FSM-embedded agents from workspace config.
 * Scans jobs for FSM-based workflows and extracts the single agent/llm action from each state.
 *
 * Generates IDs in format: jobId:stateId
 *
 * @param config - Workspace configuration
 * @returns Map of IDs to FSM agent responses
 */
export function extractFSMAgents(config: WorkspaceConfig): Record<string, FSMAgentResponse> {
  const agents: Record<string, FSMAgentResponse> = {};

  if (!config.jobs) return agents;

  for (const [jobId, rawJob] of Object.entries(config.jobs)) {
    const job = JobSpecificationSchema.safeParse(rawJob);
    if (!job.success) continue;
    if (!job.data.fsm) continue;

    // Parse FSM with Zod schema - skip invalid FSMs.
    const parsed = parseInlineFSM(job.data.fsm, jobId);
    if (!parsed.success) continue;
    const fsm = parsed.data;
    if (!fsm.states) continue;

    for (const [stateId, state] of Object.entries(fsm.states)) {
      if (!state.entry) continue;

      // Find the single agent/llm action in this state
      for (let i = 0; i < state.entry.length; i++) {
        const action = state.entry[i] as FSMAction | undefined;
        if (!action) continue;
        if (action.type !== "agent" && action.type !== "llm") continue;

        const id = `${jobId}:${stateId}`;

        if (action.type === "agent") {
          agents[id] = {
            id,
            jobId,
            stateId,
            entryIndex: i,
            type: "agent",
            agentId: action.agentId,
            prompt: action.prompt,
            outputTo: action.outputTo,
          };
        } else {
          agents[id] = {
            id,
            jobId,
            stateId,
            entryIndex: i,
            type: "llm",
            provider: action.provider,
            model: action.model,
            prompt: action.prompt,
            tools: action.tools,
            outputTo: action.outputTo,
            outputType: action.outputType,
          };
        }
        // Only one agent/llm per state, so break after finding it
        break;
      }
    }
  }

  return agents;
}
