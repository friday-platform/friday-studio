/**
 * Derives signal details from workspace configuration.
 *
 * Extracts signal metadata (provider, endpoint/schedule, schema) and maps
 * each signal to the jobs it triggers via `config.jobs[*].triggers`.
 *
 * Pure function — no side effects, no daemon API calls.
 *
 * @module
 */

import { JobSpecificationSchema } from "./jobs.ts";
import type { OnMissedPolicy } from "./signals.ts";
import type { WorkspaceConfig } from "./workspace.ts";

// ==============================================================================
// TYPES
// ==============================================================================

export interface SignalDetail {
  /** Signal key from config */
  name: string;
  /** Provider type (http, schedule, etc.) */
  provider: string;
  /** Human-readable title (optional) */
  title?: string;
  /** Endpoint path for HTTP signals */
  endpoint?: string;
  /** Cron expression for schedule signals */
  schedule?: string;
  /** Timezone for schedule signals (defaults to UTC) */
  timezone?: string;
  /**
   * onMissed policy for schedule signals. Surfaced so UIs can render
   * the chosen behavior alongside the cron expression — see /schedules page.
   */
  onMissed?: OnMissedPolicy;
  /** missedWindow Duration string (e.g., "24h"). */
  missedWindow?: string;
  /** Watched path for fs-watch signals */
  watchPath?: string;
  /** Input JSON Schema, null if not defined */
  schema: object | null;
  /** Job names this signal activates */
  triggeredJobs: string[];
}

// ==============================================================================
// IMPLEMENTATION
// ==============================================================================

/**
 * Extracts signal details from a workspace config.
 *
 * For each signal, resolves provider-specific metadata (endpoint path or
 * cron schedule) and maps to triggered jobs by scanning job trigger arrays.
 *
 * @param config - Workspace configuration
 * @returns Array of signal details in declaration order
 */
export function deriveSignalDetails(config: WorkspaceConfig): SignalDetail[] {
  if (!config.signals) return [];

  // Build signal→jobs mapping by scanning all job triggers
  const signalToJobs = buildSignalJobMap(config);

  const details: SignalDetail[] = [];

  for (const [name, signal] of Object.entries(config.signals)) {
    const detail: SignalDetail = {
      name,
      provider: signal.provider,
      schema: signal.schema ?? null,
      triggeredJobs: signalToJobs.get(name) ?? [],
    };

    if (signal.title) {
      detail.title = signal.title;
    }

    if (signal.provider === "http") {
      detail.endpoint = signal.config.path;
    } else if (signal.provider === "schedule") {
      detail.schedule = signal.config.schedule;
      detail.timezone = signal.config.timezone;
      if (signal.config.onMissed !== undefined) detail.onMissed = signal.config.onMissed;
      if (signal.config.missedWindow !== undefined)
        detail.missedWindow = signal.config.missedWindow;
    } else if (signal.provider === "fs-watch") {
      detail.watchPath = signal.config.path;
    }

    details.push(detail);
  }

  return details;
}

/**
 * Builds a map from signal name to the list of job IDs that trigger on it.
 */
function buildSignalJobMap(config: WorkspaceConfig): Map<string, string[]> {
  const map = new Map<string, string[]>();

  if (!config.jobs) return map;

  for (const [jobId, rawJob] of Object.entries(config.jobs)) {
    const job = JobSpecificationSchema.safeParse(rawJob);
    if (!job.success) continue;

    if (!job.data.triggers) continue;

    for (const trigger of job.data.triggers) {
      const existing = map.get(trigger.signal);
      if (existing) {
        existing.push(jobId);
      } else {
        map.set(trigger.signal, [jobId]);
      }
    }
  }

  return map;
}
