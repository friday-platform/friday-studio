/**
 * Signal mutation functions for workspace configuration partial updates
 *
 * Pure functions that transform WorkspaceConfig, returning MutationResult.
 * No side effects - callers are responsible for persistence.
 */

import { produce } from "immer";
import type { WorkspaceSignalConfig } from "../signals.ts";
import type { WorkspaceConfig } from "../workspace.ts";
import {
  conflictError,
  type DeleteOptions,
  type JobCascadeTarget,
  type MutationResult,
  notFoundError,
  typeChangeError,
} from "./types.ts";

/**
 * Creates a new signal in the workspace configuration.
 * Fails if a signal with the given ID already exists.
 *
 * @param config - Current workspace configuration
 * @param signalId - ID for the new signal
 * @param signal - Signal configuration to create
 * @returns MutationResult with updated config or conflict error
 */
export function createSignal(
  config: WorkspaceConfig,
  signalId: string,
  signal: WorkspaceSignalConfig,
): MutationResult<WorkspaceConfig> {
  const existingSignals = config.signals ?? {};

  if (signalId in existingSignals) {
    return { ok: false, error: conflictError() };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      draft.signals ??= {};
      draft.signals[signalId] = signal;
    }),
  };
}

/**
 * Updates an existing signal in the workspace configuration.
 * Fails if the signal doesn't exist or if attempting to change the provider type.
 *
 * @param config - Current workspace configuration
 * @param signalId - ID of the signal to update
 * @param signal - New signal configuration (full replacement)
 * @returns MutationResult with updated config or error
 */
export function updateSignal(
  config: WorkspaceConfig,
  signalId: string,
  signal: WorkspaceSignalConfig,
): MutationResult<WorkspaceConfig> {
  const existingSignals = config.signals ?? {};
  const existingSignal = existingSignals[signalId];

  if (!existingSignal) {
    return { ok: false, error: notFoundError(signalId, "signal") };
  }

  if (existingSignal.provider !== signal.provider) {
    return {
      ok: false,
      error: typeChangeError(existingSignal.provider, signal.provider, "signal provider type"),
    };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      draft.signals ??= {};
      draft.signals[signalId] = signal;
    }),
  };
}

/**
 * Finds all jobs that reference a given signal in their triggers.
 * Returns cascade targets with remaining trigger counts.
 */
function findAffectedJobs(config: WorkspaceConfig, signalId: string): JobCascadeTarget[] {
  const jobs = config.jobs ?? {};
  const affected: JobCascadeTarget[] = [];

  for (const [jobId, job] of Object.entries(jobs)) {
    const triggers = job.triggers ?? [];
    const matchingTriggers = triggers.filter((t) => t.signal === signalId);

    if (matchingTriggers.length > 0) {
      affected.push({
        type: "job",
        jobId,
        remainingTriggers: triggers.length - matchingTriggers.length,
      });
    }
  }

  return affected;
}

/**
 * Deletes a signal from the workspace configuration.
 *
 * Without force: Returns conflict error if any jobs reference the signal.
 * With force: Removes the signal and cascades to remove matching triggers from jobs.
 *
 * @param config - Current workspace configuration
 * @param signalId - ID of the signal to delete
 * @param options - Delete options (force for cascade)
 * @returns MutationResult with updated config or error
 */
export function deleteSignal(
  config: WorkspaceConfig,
  signalId: string,
  options?: DeleteOptions,
): MutationResult<WorkspaceConfig> {
  const existingSignals = config.signals ?? {};

  if (!(signalId in existingSignals)) {
    return { ok: false, error: notFoundError(signalId, "signal") };
  }

  const affectedJobs = findAffectedJobs(config, signalId);

  if (affectedJobs.length > 0 && !options?.force) {
    return { ok: false, error: conflictError(affectedJobs) };
  }

  return {
    ok: true,
    value: produce(config, (draft) => {
      // Remove signal
      draft.signals ??= {};
      delete draft.signals[signalId];

      // Cascade: remove triggers referencing this signal from jobs
      if (affectedJobs.length > 0 && options?.force && draft.jobs) {
        for (const job of Object.values(draft.jobs)) {
          if (job.triggers) {
            job.triggers = job.triggers.filter((t) => t.signal !== signalId);
          }
        }
      }
    }),
  };
}
