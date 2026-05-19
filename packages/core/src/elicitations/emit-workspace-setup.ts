/**
 * Shared emitter for `workspace-setup` elicitations.
 *
 * There are two emission sites for the same elicitation kind: the import-time
 * bootstrap spawn (`apps/atlasd/routes/workspaces/setup-spawn.ts`) and the
 * agent-driven re-setup tool (`request_workspace_setup` on workspace-chat).
 * Both must produce the same envelope so they flow through one dispatcher.
 *
 * Centralizing the create call here keeps the question text, expiry policy,
 * and elicitation kind in a single place — one form, one schema, one answer
 * handler.
 *
 * `workspace-setup` elicitations are exempt from the 30-minute expiry sweep
 * (see Po's #9), but the schema still requires `expiresAt`. Use a far-future
 * timestamp so the read-time derivation never marks the row expired during
 * the form's lifetime.
 */

import type { Result } from "@atlas/utils";
import type { Elicitation, SetupRequirement } from "./model.ts";
import { ElicitationStorage } from "./storage.ts";

const FAR_FUTURE_EXPIRES_AT_MS = 365 * 24 * 60 * 60 * 1000;

const QUESTION = "Finish setting up this workspace";

export interface EmitWorkspaceSetupElicitationArgs {
  workspaceId: string;
  sessionId: string;
  setupRequirements: SetupRequirement[];
}

export function emitWorkspaceSetupElicitation(
  args: EmitWorkspaceSetupElicitationArgs,
): Promise<Result<Elicitation, string>> {
  const { workspaceId, sessionId, setupRequirements } = args;
  const expiresAt = new Date(Date.now() + FAR_FUTURE_EXPIRES_AT_MS).toISOString();
  return ElicitationStorage.create({
    workspaceId,
    sessionId,
    kind: "workspace-setup",
    question: QUESTION,
    setupRequirements,
    expiresAt,
  });
}
