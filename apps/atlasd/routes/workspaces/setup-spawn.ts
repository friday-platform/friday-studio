/**
 * Initial-setup spawn at workspace import time (Decision 1).
 *
 * Three import endpoints (`/create`, `/import-bundle`, `/import-bundle-all`)
 * share this hook. After the workspace's config has been parsed and the
 * existing `toIdRefs` auto-pin step has run, the importer calls
 * {@link spawnBootstrapSessionIfNeeded}. If the workspace requires setup,
 * the helper creates a chat session, inserts a single `workspace-setup`
 * elicitation scoped to that session pre-seeded with the requirements
 * snapshot, and persists the new session id on workspace metadata as
 * `active_setup_session_id` so the chat-no-session redirect (T21) and the
 * importer's response can route the user straight into the form.
 *
 * This is the **only** server-side spawn site for initial setup —
 * there is no daemon-side autonomous spawn and no workspace-scoped KV
 * singleton (Decision 1 alternative rejected). Re-setup post-import is
 * agent-driven via T18/T19 (Decision 4) and never reaches this code.
 *
 * The derivation runs with `allowStaleIdRecovery: false`: an imported
 * bundle that carries a pinned credential id the importing user has never
 * owned is a hard creation error per Decision 5, surfaced as
 * `StaleCredentialIdAtImportError` for the caller to convert into a 400.
 */

import type { AtlasUIMessage } from "@atlas/agent-sdk";
import type { WorkspaceConfig } from "@atlas/config";
import { generateChatId } from "@atlas/core/chat/id";
import { ChatStorage } from "@atlas/core/chat/storage";
import { ElicitationStorage } from "@atlas/core/elicitations";
import { createLogger } from "@atlas/logger";
import {
  loadWorkspaceEnv,
  resolveWorkspaceSetupRequirements,
  type SetupRequirement,
  type WorkspaceEntry,
  type WorkspaceManager,
  type WorkspaceMetadata,
} from "@atlas/workspace";
import { assembleLinkCredentialState } from "../../src/assemble-link-credential-state.ts";

const spawnLogger = createLogger({ component: "workspace-setup-spawn" });

/**
 * `workspace-setup` elicitations are exempt from the 30-minute expiry sweep
 * (see Decision 1 / Po's #9), but the schema still requires `expiresAt`.
 * Pick a far-future timestamp so the read-time derivation never marks the
 * row expired during the form's lifetime.
 */
const FAR_FUTURE_EXPIRES_AT_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function buildWelcomeMessage(parsedConfig: WorkspaceConfig): AtlasUIMessage {
  const name = parsedConfig.workspace.name;
  const text =
    parsedConfig.workspace.welcome ??
    `Welcome to **${name}** — this workspace needs a few values before it can run. Fill the form below to finish setup.`;
  return { id: crypto.randomUUID(), role: "system", parts: [{ type: "text", text }] };
}

export interface SpawnBootstrapResult {
  requires_setup: boolean;
  /** Set only when `requires_setup === true`. */
  bootstrap_session_id?: string;
  /** Snapshot of the requirements written into the elicitation. */
  setup_requirements: SetupRequirement[];
}

export interface SpawnBootstrapArgs {
  manager: WorkspaceManager;
  workspaceId: string;
  workspacePath: string;
  parsedConfig: WorkspaceConfig;
  userId: string;
  /**
   * Existing workspace metadata to merge `active_setup_session_id` onto.
   * Pass the value returned by `registerWorkspace` so the merge preserves
   * `createdBy`, `description`, etc. set by the registrar.
   */
  existingMetadata: WorkspaceMetadata | undefined;
}

/**
 * Live-derive setup requirements, then — if the workspace needs setup —
 * spawn the bootstrap chat session, pre-seed the `workspace-setup`
 * elicitation, and persist `active_setup_session_id` on metadata.
 *
 * The derivation runs with `allowStaleIdRecovery: false`. A pinned
 * credential id that does not resolve at this stage throws
 * `StaleCredentialIdAtImportError`; callers should map it to a 400 with the
 * stale id surfaced to the user.
 */
export async function spawnBootstrapSessionIfNeeded(
  args: SpawnBootstrapArgs,
): Promise<SpawnBootstrapResult> {
  const { manager, workspaceId, workspacePath, parsedConfig, userId, existingMetadata } = args;

  const envSnapshot = loadWorkspaceEnv(workspacePath);
  const linkCredentials = await assembleLinkCredentialState(parsedConfig);
  const derived = resolveWorkspaceSetupRequirements(parsedConfig, envSnapshot, linkCredentials, {
    allowStaleIdRecovery: false,
  });

  if (!derived.requires_setup) {
    return { requires_setup: false, setup_requirements: [] };
  }

  const workspace = await manager.find({ id: workspaceId });
  if (!workspace) {
    throw new Error(`Workspace ${workspaceId} not found after registration`);
  }

  const bootstrapSessionId = generateChatId();

  const chatResult = await ChatStorage.createChat({
    chatId: bootstrapSessionId,
    userId,
    workspaceId,
    source: "atlas",
  });
  if (!chatResult.ok) {
    throw new Error(`Failed to create bootstrap chat session: ${chatResult.error}`);
  }

  const welcomeResult = await ChatStorage.appendMessage(
    bootstrapSessionId,
    buildWelcomeMessage(parsedConfig),
    workspaceId,
  );
  if (!welcomeResult.ok) {
    throw new Error(`Failed to seed bootstrap welcome message: ${welcomeResult.error}`);
  }

  const now = new Date();
  const elicitationResult = await ElicitationStorage.create({
    workspaceId,
    sessionId: bootstrapSessionId,
    kind: "workspace-setup",
    question: "Finish setting up this workspace",
    setupRequirements: derived.setup_requirements,
    expiresAt: new Date(now.getTime() + FAR_FUTURE_EXPIRES_AT_MS).toISOString(),
  });
  if (!elicitationResult.ok) {
    throw new Error(`Failed to create bootstrap elicitation: ${elicitationResult.error}`);
  }

  const newMetadata: WorkspaceMetadata = {
    ...(existingMetadata ?? {}),
    active_setup_session_id: bootstrapSessionId,
  };
  await manager.updateWorkspaceStatus(workspaceId, workspace.status, { metadata: newMetadata });

  spawnLogger.info("Spawned bootstrap setup session", {
    workspaceId,
    bootstrapSessionId,
    requirementCount: derived.setup_requirements.length,
  });

  return {
    requires_setup: true,
    bootstrap_session_id: bootstrapSessionId,
    setup_requirements: derived.setup_requirements,
  };
}

export interface RecoverBootstrapArgs {
  manager: WorkspaceManager;
  workspace: WorkspaceEntry;
  parsedConfig: WorkspaceConfig;
  setupRequirements: SetupRequirement[];
  userId: string;
}

export interface RecoverBootstrapResult {
  recovered: boolean;
  bootstrap_session_id: string | null;
}

/**
 * Re-spawn the bootstrap chat session if the pointer on
 * `WorkspaceMetadata.active_setup_session_id` references a chat the user has
 * since deleted (Decision 1, deletion-recovery paragraph).
 *
 * Called by workspace GET endpoints after they have already derived
 * `requires_setup === true`. Skips work when the pointer is null (re-setup,
 * not initial — agent-driven) or when the chat still exists. The pointer
 * write is the final step so a failed re-spawn leaves the stale pointer in
 * place for the next read to retry, rather than half-committing a fresh id
 * with no session behind it.
 */
export async function recoverBootstrapSessionIfDeleted(
  args: RecoverBootstrapArgs,
): Promise<RecoverBootstrapResult> {
  const { manager, workspace, parsedConfig, setupRequirements, userId } = args;
  const pointer = workspace.metadata?.active_setup_session_id;
  if (!pointer) {
    return { recovered: false, bootstrap_session_id: null };
  }

  const existing = await ChatStorage.getChat(pointer, workspace.id);
  if (existing.ok && existing.data) {
    return { recovered: false, bootstrap_session_id: pointer };
  }

  const newSessionId = generateChatId();

  const chatResult = await ChatStorage.createChat({
    chatId: newSessionId,
    userId,
    workspaceId: workspace.id,
    source: "atlas",
  });
  if (!chatResult.ok) {
    throw new Error(`Failed to recreate bootstrap chat session: ${chatResult.error}`);
  }

  const welcomeResult = await ChatStorage.appendMessage(
    newSessionId,
    buildWelcomeMessage(parsedConfig),
    workspace.id,
  );
  if (!welcomeResult.ok) {
    throw new Error(`Failed to seed bootstrap welcome message: ${welcomeResult.error}`);
  }

  const now = new Date();
  const elicitationResult = await ElicitationStorage.create({
    workspaceId: workspace.id,
    sessionId: newSessionId,
    kind: "workspace-setup",
    question: "Finish setting up this workspace",
    setupRequirements,
    expiresAt: new Date(now.getTime() + FAR_FUTURE_EXPIRES_AT_MS).toISOString(),
  });
  if (!elicitationResult.ok) {
    throw new Error(`Failed to re-seed bootstrap elicitation: ${elicitationResult.error}`);
  }

  const newMetadata: WorkspaceMetadata = {
    ...(workspace.metadata ?? {}),
    active_setup_session_id: newSessionId,
  };
  await manager.updateWorkspaceStatus(workspace.id, workspace.status, { metadata: newMetadata });

  spawnLogger.info("Recovered deleted bootstrap setup session", {
    workspaceId: workspace.id,
    previousSessionId: pointer,
    newSessionId,
  });

  return { recovered: true, bootstrap_session_id: newSessionId };
}
