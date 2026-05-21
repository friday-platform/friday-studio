/**
 * Re-setup status block for the workspace-chat system prompt.
 *
 * Decision 4: re-setup post-import is agent-driven. When a configured
 * workspace acquires new gaps (variable unset, credential disconnected,
 * default credential cleared), the agent needs to know what's missing
 * and which tools close the gap so it surfaces them conversationally
 * instead of attempting failing actions.
 *
 * Inject criteria — both must hold:
 *   - `requires_setup === true` (live derivation surfaces gaps)
 *   - `active_setup_session_id === null` (no initial-setup bootstrap pending)
 *
 * Initial setup (pointer non-null) uses the redirect-to-bootstrap-session
 * flow + pre-seeded elicitation; injecting a prompt block then would
 * duplicate the form-driven surface and confuse the agent. Fully-configured
 * workspaces get no block at all.
 *
 * Template is contract — the conversational-tools clause is what the model
 * was trained against in the design's evaluation set. Match verbatim.
 */

import { client, parseResult } from "@atlas/client/v2";
import type { VariableSchema } from "@atlas/config";
import type { SetupRequirement } from "@atlas/core/elicitations";
import { SetupRequirementSchema } from "@atlas/core/elicitations";
import type { Logger } from "@atlas/logger";
import { z } from "zod";

const WorkspaceSetupStatusResponseSchema = z.object({
  requires_setup: z.boolean(),
  setup_requirements: z.array(SetupRequirementSchema),
  metadata: z.object({ active_setup_session_id: z.string().nullable().optional() }).optional(),
});

export interface WorkspaceSetupStatus {
  /** True when both gate conditions hold and the prompt should carry the block. */
  shouldInject: boolean;
  /** Snapshot at fetch time — formatter consumes when `shouldInject` is true. */
  setupRequirements: SetupRequirement[];
}

const NO_INJECT: WorkspaceSetupStatus = { shouldInject: false, setupRequirements: [] };

/**
 * Per-turn fetch of the workspace's setup state. Re-setup gaps shift on
 * env writes / credential disconnects mid-conversation, so this is NOT
 * memoized — every prompt composition reads the live derivation from the
 * daemon GET endpoint.
 *
 * On failure (network blip, shape mismatch) the function returns
 * `shouldInject: false`. A transient hiccup must not falsely accuse the
 * workspace of being broken — the agent stays silent rather than
 * fabricating a setup state.
 */
export async function fetchWorkspaceSetupStatus(
  workspaceId: string,
  logger: Logger,
): Promise<WorkspaceSetupStatus> {
  const wsResult = await parseResult(
    client.workspace[":workspaceId"].$get({ param: { workspaceId } }),
  );
  if (!wsResult.ok) {
    logger.warn("fetchWorkspaceSetupStatus: workspace fetch failed", {
      workspaceId,
      error: wsResult.error,
    });
    return NO_INJECT;
  }

  const parsed = WorkspaceSetupStatusResponseSchema.safeParse(wsResult.data);
  if (!parsed.success) {
    logger.warn("fetchWorkspaceSetupStatus: response shape unexpected", {
      workspaceId,
      issues: parsed.error.issues,
    });
    return NO_INJECT;
  }

  if (!parsed.data.requires_setup) return NO_INJECT;

  const pointer = parsed.data.metadata?.active_setup_session_id;
  if (typeof pointer === "string" && pointer.length > 0) {
    return NO_INJECT;
  }

  return { shouldInject: true, setupRequirements: parsed.data.setup_requirements };
}

/**
 * Human-readable summary of a variable's JSON-Schema constraints. Compact —
 * type plus any of (enum, min/max, length, pattern) the declaration carries.
 * Drives the `Required: <schema summary>` tail on each variable bullet.
 */
export function formatVariableSchemaSummary(schema: VariableSchema): string {
  const parts: string[] = [schema.type];

  switch (schema.type) {
    case "string": {
      if (schema.enum) parts.push(`enum: ${schema.enum.join("|")}`);
      if (schema.format) parts.push(`format: ${schema.format}`);
      if (schema.pattern) parts.push(`pattern: ${schema.pattern}`);
      if (schema.minLength !== undefined) parts.push(`minLength: ${schema.minLength}`);
      if (schema.maxLength !== undefined) parts.push(`maxLength: ${schema.maxLength}`);
      break;
    }
    case "number":
    case "integer": {
      if (schema.enum) parts.push(`enum: ${schema.enum.join("|")}`);
      if (schema.minimum !== undefined) parts.push(`min: ${schema.minimum}`);
      if (schema.maximum !== undefined) parts.push(`max: ${schema.maximum}`);
      break;
    }
    case "boolean": {
      if (schema.enum) parts.push(`enum: ${schema.enum.join("|")}`);
      break;
    }
  }

  return parts.join(", ");
}

function formatCredentialReason(reason: "no_default" | "stale_id"): string {
  if (reason === "no_default") return "no default credential selected";
  return "previously-linked credential no longer resolves";
}

function formatVariableBullet(req: Extract<SetupRequirement, { kind: "variable" }>): string {
  const description = req.description ?? "(no description provided)";
  return `- Variable \`${req.name}\`: ${description}. Required: ${formatVariableSchemaSummary(
    req.schema,
  )}.`;
}

function formatCredentialBullet(req: Extract<SetupRequirement, { kind: "credential" }>): string {
  return `- Credential: ${req.provider} (${formatCredentialReason(req.reason)}).`;
}

/**
 * Render the `[WORKSPACE SETUP STATUS]` block exactly per design §
 * Module — Re-setup surface. The tools clause is byte-identical to the
 * design template so the conversational-tools paragraph matches the
 * evaluation set the chat agent was trained against.
 *
 * Returns the empty string when there are no requirements — callers
 * should only reach this when `shouldInject === true`, but the empty
 * guard keeps the formatter safe in isolation.
 */
export function formatSetupStatusBlock(setupRequirements: SetupRequirement[]): string {
  if (setupRequirements.length === 0) return "";

  const bullets = setupRequirements.map((req) =>
    req.kind === "variable" ? formatVariableBullet(req) : formatCredentialBullet(req),
  );

  return [
    "[WORKSPACE SETUP STATUS]",
    "This workspace currently has unfilled configuration:",
    ...bullets,
    "",
    "Do not attempt actions that depend on these. Surface the gap conversationally. Tools:",
    "- env_set(key, value) — fill a single variable. Confirmation card renders.",
    "- connect_service(provider) — open OAuth for a single credential.",
    "- request_workspace_setup() — show the full setup form. Use when multiple gaps OR the user prefers a form to a conversation.",
  ].join("\n");
}
