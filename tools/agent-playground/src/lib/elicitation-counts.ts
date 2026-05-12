import type {
  Elicitation,
  ElicitationStatus,
} from "@atlas/core/elicitations/model";

export function effectiveElicitationStatus(
  elicitation: Elicitation,
  nowMs: number,
): ElicitationStatus {
  if (
    elicitation.status === "pending" &&
    new Date(elicitation.expiresAt).getTime() <= nowMs
  ) {
    return "expired";
  }
  return elicitation.status;
}

export function countPendingElicitations(
  elicitations: readonly Elicitation[],
  nowMs: number,
  workspaceId: string | null = null,
): number {
  let pending = 0;
  for (const elicitation of elicitations) {
    if (workspaceId !== null && elicitation.workspaceId !== workspaceId) {
      continue;
    }
    if (effectiveElicitationStatus(elicitation, nowMs) === "pending") pending++;
  }
  return pending;
}

/**
 * The next time some pending elicitation's display would change. Returns
 * the soonest of:
 *   - any pending elicitation's `expiresAt` (the `pending → expired` flip)
 *   - if `includeCountdown` is set, `nowMs + 1_000` whenever a pending
 *     entry is within 60s of expiring (so the "in Xs" countdown label
 *     updates at second granularity without a continuously-running
 *     clock interval).
 *
 * Returns `null` when nothing is pending or every pending entry is
 * already past its deadline — callers use that signal to skip arming a
 * timer at all. Two modes match the two surfaces: sidebars / badges
 * care only about the count (no countdown), Activity rows and detail
 * panels render the live label.
 */
export function nextElicitationTickMs(
  elicitations: readonly Elicitation[],
  nowMs: number,
  includeCountdown: boolean,
): number | null {
  let soonest = Number.POSITIVE_INFINITY;
  for (const e of elicitations) {
    if (e.status !== "pending") continue;
    const expiresAt = new Date(e.expiresAt).getTime();
    if (!Number.isFinite(expiresAt)) continue;
    if (expiresAt <= nowMs) continue;
    if (expiresAt < soonest) soonest = expiresAt;
    if (includeCountdown && expiresAt - nowMs < 60_000) {
      const nextSec = nowMs + 1_000;
      if (nextSec < soonest) soonest = nextSec;
    }
  }
  return Number.isFinite(soonest) ? soonest : null;
}
