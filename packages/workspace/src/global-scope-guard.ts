import { isGlobalScope } from "@atlas/agent-sdk";
import { MountScopeError } from "./mount-errors.ts";

export function assertGlobalWriteAllowed(
  callerWorkspaceId: string,
  kernelWorkspaceId: string | undefined,
): void {
  if (callerWorkspaceId === kernelWorkspaceId) {
    return;
  }
  throw new MountScopeError("_global", callerWorkspaceId);
}

export function isGlobalWriteAttempt(sourceWsId: string, mode: string): boolean {
  return isGlobalScope(sourceWsId) && mode === "rw";
}
