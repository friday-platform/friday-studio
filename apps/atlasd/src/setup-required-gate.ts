/**
 * Setup-gate runtime helpers — Decision 7 per-provider response semantics.
 *
 * The gate fires when `requires_setup === true` for a workspace AND a
 * non-chat signal trigger is being processed. Three call sites enforce it:
 *
 * 1. `triggerWorkspaceSignal` (cascade worker path — schedule, fs-watch, the
 *    queued HTTP path). The worker has no Hono context, so the gate runs the
 *    derivation directly via `evaluateWorkspaceSetupGate`.
 * 2. HTTP signal route handlers in `routes/workspaces/index.ts`. They evaluate
 *    via the request-scoped cache, then return the 409 body shape directly.
 * 3. Inbound communicator handler in `chat-sdk/chat-sdk-instance.ts`. Owners
 *    get the setup URL as a reply; non-owners are dropped silently.
 *
 * The helper module owns the derivation + URL construction so the three call
 * sites share one source of truth for what "setup required" means.
 */

import type { WorkspaceManager } from "@atlas/workspace";
import { loadWorkspaceEnv, resolveWorkspaceSetupRequirements } from "@atlas/workspace";
import { assembleLinkCredentialState } from "./assemble-link-credential-state.ts";
import { getAtlasDaemonUrl } from "./utils.ts";

/** Returned to webhook callers in the 409 body and used in communicator replies. */
export const SETUP_REQUIRED_ERROR_CODE = "workspace_setup_required" as const;

const SETUP_REQUIRED_MESSAGE =
  "Workspace setup is incomplete. Open the workspace's chat to finish setup before triggering signals." as const;

/**
 * Per-workspace setup chat URL — the design says construct from
 * `getAtlasDaemonUrl()` + `/workspaces/:id/chat`. Same path the studio uses
 * to land users on the bootstrap chat session.
 */
export function buildWorkspaceSetupUrl(workspaceId: string): string {
  const base = getAtlasDaemonUrl().replace(/\/+$/, "");
  return `${base}/workspaces/${encodeURIComponent(workspaceId)}/chat`;
}

/** 409 JSON body shape — webhook clients treat 409 as non-retryable. */
export interface WorkspaceSetupRequired409Body {
  error: typeof SETUP_REQUIRED_ERROR_CODE;
  message: string;
  setup_url: string;
}

export function buildSetupRequired409Body(workspaceId: string): WorkspaceSetupRequired409Body {
  return {
    error: SETUP_REQUIRED_ERROR_CODE,
    message: SETUP_REQUIRED_MESSAGE,
    setup_url: buildWorkspaceSetupUrl(workspaceId),
  };
}

/**
 * Thrown by `triggerWorkspaceSignal` when a non-chat trigger lands on a
 * setup-required workspace. Carries the setup URL so HTTP callers (e.g. the
 * `bypassConcurrency` route branch) can surface it. Cascade-worker callers
 * log and discard.
 */
export class WorkspaceSetupRequiredError extends Error {
  readonly code = SETUP_REQUIRED_ERROR_CODE;
  readonly workspaceId: string;
  readonly setupUrl: string;
  readonly signalProvider: string | undefined;

  constructor(args: { workspaceId: string; setupUrl: string; signalProvider?: string }) {
    super(SETUP_REQUIRED_MESSAGE);
    this.name = "WorkspaceSetupRequiredError";
    this.workspaceId = args.workspaceId;
    this.setupUrl = args.setupUrl;
    this.signalProvider = args.signalProvider;
  }
}

export type SetupGateResult =
  | { requires_setup: true; setupUrl: string }
  | { requires_setup: false };

/**
 * Decision 7 — cascade-consumer dispatch error routing.
 *
 * The CascadeConsumer wrapper around `triggerWorkspaceSignal` catches every
 * error thrown by the dispatch. For `WorkspaceSetupRequiredError`, what we
 * do next depends on whether a synchronous caller is waiting:
 *
 *  - HTTP path (envelope carries `correlationId`): rethrow so the
 *    cascade-stream's runCascade catch publishes the fail envelope on
 *    `signals.responses.<id>`. The route handler is already awaiting that
 *    subject; the rethrow is load-bearing for the 409 surface.
 *  - Cron / fs-watch (no `correlationId`): no subscriber, so the rethrow
 *    only produces a WARN log every tick. Per the plan, we log info-level
 *    in the gate and return cleanly here — the cascade settles as a
 *    no-session skip without polluting cascade-failure telemetry.
 *
 * Non-setup-required errors are passed through (`null` return) so the
 * caller keeps its existing SessionFailedError / infra-error handling.
 *
 * Pulled out as a pure function so the routing decision is unit-testable
 * without standing up the full daemon + JetStream stack.
 */
export function classifyCascadeSetupError(
  err: unknown,
  envelope: { correlationId?: string },
): { action: "skip" } | { action: "rethrow" } | null {
  if (!(err instanceof WorkspaceSetupRequiredError)) return null;
  return envelope.correlationId ? { action: "rethrow" } : { action: "skip" };
}

/**
 * Context-free setup-state derivation for call sites that don't have a Hono
 * request (cascade worker, communicator inbound handler). Returns `null` when
 * the workspace doesn't exist — the caller has nothing to gate.
 */
export async function evaluateWorkspaceSetupGate(
  manager: WorkspaceManager,
  workspaceId: string,
): Promise<SetupGateResult | null> {
  const entry = await manager.find({ id: workspaceId });
  if (!entry) return null;
  const merged = await manager.getWorkspaceConfig(workspaceId);
  if (!merged) return null;

  const envSnapshot = loadWorkspaceEnv(entry.path);
  const linkCredentials = await assembleLinkCredentialState(merged.workspace);
  const result = resolveWorkspaceSetupRequirements(merged.workspace, envSnapshot, linkCredentials, {
    allowStaleIdRecovery: true,
  });
  if (!result.requires_setup) return { requires_setup: false };
  return { requires_setup: true, setupUrl: buildWorkspaceSetupUrl(workspaceId) };
}
