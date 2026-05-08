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
