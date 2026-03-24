/**
 * Blueprint mutation functions for workspace configuration updates.
 *
 * Pure functions that transform WorkspaceBlueprint, returning MutationResult.
 * No side effects - callers are responsible for persistence (artifact storage + recompile).
 *
 * These mutations are the preferred path for UI edits — they modify the blueprint
 * (source of truth) rather than workspace.yml directly, so changes survive recompilation.
 */

import type { WorkspaceBlueprint } from "@atlas/schemas/workspace";
import { produce } from "immer";
import type { MutationResult } from "./types.ts";
import { notFoundError, notSupportedError, validationError } from "./types.ts";

// ==============================================================================
// FSM PATH → BLUEPRINT STEP RESOLUTION
// ==============================================================================

/**
 * Reverse the FSM state name back to the original step ID.
 *
 * FSM compilation: step.id → `step_${id.replace(/-/g, '_')}`
 * Reverse: strip `step_` prefix, replace `_` with `-`
 *
 * This is lossy if step IDs originally contained underscores,
 * but by convention step IDs use kebab-case (hyphens).
 */
function reverseStateName(stateId: string): string {
  const withoutPrefix = stateId.startsWith("step_") ? stateId.slice(5) : stateId;
  return withoutPrefix.replace(/_/g, "-");
}

/**
 * Resolved location of a DAG step within the blueprint.
 */
interface ResolvedBlueprintStep {
  jobIndex: number;
  stepIndex: number;
}

/**
 * Resolve an FSM agent path (jobId:stateId) to a blueprint DAG step.
 *
 * The UI identifies agents by FSM path `jobId:stateId`. This maps that
 * back to the blueprint's `jobs[].steps[]` entry.
 */
function resolveBlueprintStep(
  blueprint: WorkspaceBlueprint,
  fsmPath: string,
): ResolvedBlueprintStep | null {
  const parts = fsmPath.split(":");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const jobId = parts[0];
  const stateId = parts[1];
  const stepId = reverseStateName(stateId);

  const jobIndex = blueprint.jobs.findIndex((j) => j.id === jobId);
  if (jobIndex === -1) return null;

  const job = blueprint.jobs[jobIndex];
  if (!job) return null;

  const stepIndex = job.steps.findIndex((s) => s.id === stepId);
  if (stepIndex === -1) return null;

  return { jobIndex, stepIndex };
}

// ==============================================================================
// BLUEPRINT FSM AGENT MUTATIONS
// ==============================================================================

/**
 * Update an FSM-embedded agent via the blueprint.
 *
 * Only `prompt` is representable in the blueprint schema (mapped to step.description).
 * Other fields (model, etc.) are not part of the blueprint and return `not_supported`.
 *
 * @param blueprint - Current workspace blueprint
 * @param fsmPath - FSM agent path in format "jobId:stateId"
 * @param update - Partial update (prompt and/or model)
 * @returns MutationResult with updated blueprint or not_supported error
 */
export function updateBlueprintFSMAgent(
  blueprint: WorkspaceBlueprint,
  fsmPath: string,
  update: { prompt?: string; model?: string },
): MutationResult<WorkspaceBlueprint> {
  if (!update.prompt) {
    return {
      ok: false,
      error: notSupportedError(
        "Only prompt can be edited via blueprint — other agent fields are not blueprint-representable",
      ),
    };
  }
  return updateBlueprintFSMAgentPrompt(blueprint, fsmPath, update.prompt);
}

/**
 * Update an FSM-embedded agent's prompt via the blueprint.
 *
 * The UI sends `PUT /agents/{jobId}:{stateId}` with a new prompt.
 * This maps the FSM path to the blueprint DAG step and updates its description,
 * which is what the FSM compiler uses as the action prompt.
 *
 * @param blueprint - Current workspace blueprint
 * @param fsmPath - FSM agent path in format "jobId:stateId"
 * @param prompt - New prompt text (stored as step.description in blueprint)
 * @returns MutationResult with updated blueprint or error
 */
export function updateBlueprintFSMAgentPrompt(
  blueprint: WorkspaceBlueprint,
  fsmPath: string,
  prompt: string,
): MutationResult<WorkspaceBlueprint> {
  const resolved = resolveBlueprintStep(blueprint, fsmPath);
  if (!resolved) {
    return { ok: false, error: notFoundError(fsmPath, "agent") };
  }

  return {
    ok: true,
    value: produce(blueprint, (draft) => {
      const step = draft.jobs[resolved.jobIndex]?.steps[resolved.stepIndex];
      if (!step) return;
      step.description = prompt;
    }),
  };
}

// ==============================================================================
// BLUEPRINT AGENT MUTATIONS
// ==============================================================================

/**
 * Schema for updating a blueprint agent.
 * Currently supports updating the agent description (used as prompt context).
 */
export interface BlueprintAgentUpdate {
  /** Agent description / prompt context */
  description?: string;
  /** Agent configuration overrides */
  configuration?: Record<string, unknown>;
}

/**
 * Update an agent in the blueprint.
 *
 * Blueprint agents are identified by their `id` field (kebab-case).
 * This updates the agent definition in `blueprint.agents[]`.
 *
 * @param blueprint - Current workspace blueprint
 * @param agentId - Agent ID (kebab-case identifier)
 * @param update - Partial update to apply
 * @returns MutationResult with updated blueprint or error
 */
export function updateBlueprintAgent(
  blueprint: WorkspaceBlueprint,
  agentId: string,
  update: BlueprintAgentUpdate,
): MutationResult<WorkspaceBlueprint> {
  const agentIndex = blueprint.agents.findIndex((a) => a.id === agentId);
  if (agentIndex === -1) {
    return { ok: false, error: notFoundError(agentId, "agent") };
  }

  return {
    ok: true,
    value: produce(blueprint, (draft) => {
      const agent = draft.agents[agentIndex];
      if (!agent) return;
      if (update.description !== undefined) agent.description = update.description;
      if (update.configuration !== undefined) agent.configuration = update.configuration;
    }),
  };
}

// ==============================================================================
// BLUEPRINT SIGNAL MUTATIONS
// ==============================================================================

/**
 * Patch the signal config of a blueprint signal.
 *
 * Blueprint signals are identified by their `id` field (kebab-case).
 * This merges `configPatch` into the signal's `signalConfig.config` sub-object.
 *
 * @param blueprint - Current workspace blueprint
 * @param signalId - Signal ID (kebab-case identifier)
 * @param configPatch - Partial config fields to merge into signalConfig.config
 * @returns MutationResult with updated blueprint or error
 */
export function patchBlueprintSignalConfig(
  blueprint: WorkspaceBlueprint,
  signalId: string,
  configPatch: Record<string, unknown>,
): MutationResult<WorkspaceBlueprint> {
  const signalIndex = blueprint.signals.findIndex((s) => s.id === signalId);
  if (signalIndex === -1) {
    return { ok: false, error: notFoundError(signalId, "signal") };
  }

  const signal = blueprint.signals[signalIndex];
  if (!signal) {
    return { ok: false, error: notFoundError(signalId, "signal") };
  }

  if (!signal.signalConfig) {
    return {
      ok: false,
      error: validationError(`Signal '${signalId}' has no signalConfig — cannot patch config`),
    };
  }

  return {
    ok: true,
    value: produce(blueprint, (draft) => {
      const draftSignal = draft.signals[signalIndex];
      if (!draftSignal?.signalConfig) return;
      draftSignal.signalConfig.config = { ...draftSignal.signalConfig.config, ...configPatch };
    }),
  };
}

/**
 * Update a signal in the blueprint (full replacement of signal config).
 *
 * Returns `not_supported` when `signalConfig` is undefined — this means
 * the signal's provider (e.g. system, fs-watch) has no blueprint-representable
 * config. Callers should surface this as a 422.
 *
 * @param blueprint - Current workspace blueprint
 * @param signalId - Signal ID (kebab-case identifier)
 * @param signalConfig - New signal config to set (undefined = not representable)
 * @returns MutationResult with updated blueprint or error
 */
export function updateBlueprintSignalConfig(
  blueprint: WorkspaceBlueprint,
  signalId: string,
  signalConfig: WorkspaceBlueprint["signals"][number]["signalConfig"],
): MutationResult<WorkspaceBlueprint> {
  if (signalConfig === undefined) {
    return {
      ok: false,
      error: notSupportedError(
        "Signal provider has no blueprint-representable config — edit workspace.yml directly",
      ),
    };
  }

  const signalIndex = blueprint.signals.findIndex((s) => s.id === signalId);
  if (signalIndex === -1) {
    return { ok: false, error: notFoundError(signalId, "signal") };
  }

  return {
    ok: true,
    value: produce(blueprint, (draft) => {
      const draftSignal = draft.signals[signalIndex];
      if (!draftSignal) return;
      draftSignal.signalConfig = signalConfig;
    }),
  };
}

// ==============================================================================
// BLUEPRINT CREDENTIAL MUTATIONS
// ==============================================================================

/**
 * Update a credential binding in the blueprint.
 *
 * @param blueprint - Current workspace blueprint
 * @param targetType - "mcp" or "agent"
 * @param targetId - MCP server ID or agent ID
 * @param field - Environment variable / config field name
 * @param newCredentialId - New Link credential ID
 * @param provider - OAuth provider name
 * @returns MutationResult with updated blueprint or error
 */
export function updateBlueprintCredential(
  blueprint: WorkspaceBlueprint,
  targetType: "mcp" | "agent",
  targetId: string,
  field: string,
  newCredentialId: string,
  provider: string,
): MutationResult<WorkspaceBlueprint> {
  const bindings = blueprint.credentialBindings ?? [];
  const bindingIndex = bindings.findIndex(
    (b) => b.targetType === targetType && b.targetId === targetId && b.field === field,
  );

  if (bindingIndex === -1) {
    return {
      ok: false,
      error: notFoundError(`${targetType}:${targetId}:${field}`, "credential_binding"),
    };
  }

  return {
    ok: true,
    value: produce(blueprint, (draft) => {
      const binding = draft.credentialBindings?.[bindingIndex];
      if (!binding) return;
      binding.credentialId = newCredentialId;
      binding.provider = provider;
    }),
  };
}
