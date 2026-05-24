/**
 * Setup-status block for the workspace-chat system prompt.
 *
 * Decision 4: gap bullets fire in both initial setup AND re-setup —
 * symmetric grounding for the moments the agent is most likely to be
 * asked "why do you need this?". The trailing tools clause varies by
 * whether the bootstrap form is visible in *this* chat: bootstrap-chat
 * tells the agent the form is right there and forbids a second
 * request_workspace_setup call; everywhere else (off-bootstrap during
 * initial setup, or re-setup) names the full env_set / connect_service
 * / request_workspace_setup toolkit so the agent can offer the form on
 * demand without nagging.
 *
 * Inject criterion (single):
 *   - `requires_setup === true` — live derivation surfaces gaps.
 *
 * `isBootstrapChat` is true only when the daemon's
 * `active_setup_session_id` pointer equals the current chat session id.
 * A non-null pointer in a *different* chat means the form lives
 * elsewhere; from this chat's perspective there is no visible form.
 * Fully-configured workspaces get no block at all.
 *
 * Templates are contract — both tools clauses are what the model was
 * trained against in the design's evaluation set. Match verbatim.
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
  /** True when `requires_setup === true`. */
  shouldInject: boolean;
  /** Snapshot at fetch time — formatter consumes when `shouldInject` is true. */
  setupRequirements: SetupRequirement[];
  /**
   * True only when the bootstrap form is visible in *this* chat — i.e.
   * the daemon's `active_setup_session_id` equals the current session
   * id. A non-null pointer in a different chat means the form lives
   * elsewhere and the agent should treat this chat as form-less.
   * Drives the variant tools clause in `formatSetupStatusBlock`.
   */
  isBootstrapChat: boolean;
}

const NO_INJECT: WorkspaceSetupStatus = {
  shouldInject: false,
  setupRequirements: [],
  isBootstrapChat: false,
};

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
  currentSessionId: string | null,
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
  const isBootstrapChat =
    typeof pointer === "string" && pointer.length > 0 && pointer === currentSessionId;

  return { shouldInject: true, setupRequirements: parsed.data.setup_requirements, isBootstrapChat };
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
 * Off-bootstrap tools clause — no form is visible in this chat (either
 * re-setup, or initial setup but the user is in a non-bootstrap
 * session). The agent has all three escape hatches available and is
 * told to surface the gap conversationally rather than push.
 */
const OFF_BOOTSTRAP_TOOLS_CLAUSE = [
  "Do not attempt actions that depend on these. Surface the gap conversationally. Tools:",
  "- env_set(key, value) — fill a single variable. Confirmation card renders.",
  "- connect_service(provider) — open OAuth for a single credential.",
  "- request_workspace_setup() — show the full setup form. Use when multiple gaps OR the user prefers a form to a conversation.",
];

/**
 * Bootstrap-chat tools clause — the bootstrap form is already visible
 * above the chat input. Forbids a duplicate `request_workspace_setup`
 * call, points the agent at `<welcome>` / `<variables>` for grounding,
 * and surfaces `describe_job` as the discovery path for "where is this
 * variable used?" questions.
 */
const BOOTSTRAP_CHAT_TOOLS_CLAUSE = [
  "The setup form is already visible in this chat (above your turn). Your job:",
  "- Greet the user. Use <welcome> and <variables> to ground them in what this workspace does and what each value is for.",
  "- For each gap, explain *why* this workspace needs that value — quote or paraphrase the variable's description.",
  "- If the user asks how a variable is used in this workspace, call describe_job(name) on workspace jobs and search for `{{variables.<name>}}` references; the returned prompt field preserves raw refs.",
  "- Do NOT call request_workspace_setup — the form is already there.",
  "- If the user explicitly asks you to fill a single value rather than typing into the form, use env_set. Otherwise leave the form to do its job.",
];

/**
 * Render the `[WORKSPACE SETUP STATUS]` block exactly per design §
 * Decision 4. Header, intro, and gap bullets are byte-identical across
 * both variants; only the trailing tools clause varies based on
 * `isBootstrapChat`. Both clauses are byte-identical to the design
 * template so the conversational-tools paragraph matches the
 * evaluation set the chat agent was trained against.
 *
 * Returns the empty string when there are no requirements — callers
 * should only reach this when `shouldInject === true`, but the empty
 * guard keeps the formatter safe in isolation.
 */
export function formatSetupStatusBlock(
  setupRequirements: SetupRequirement[],
  options: { isBootstrapChat: boolean },
): string {
  if (setupRequirements.length === 0) return "";

  const bullets = setupRequirements.map((req) =>
    req.kind === "variable" ? formatVariableBullet(req) : formatCredentialBullet(req),
  );

  const toolsClause = options.isBootstrapChat
    ? BOOTSTRAP_CHAT_TOOLS_CLAUSE
    : OFF_BOOTSTRAP_TOOLS_CLAUSE;

  return [
    "[WORKSPACE SETUP STATUS]",
    "This workspace currently has unfilled configuration:",
    ...bullets,
    "",
    ...toolsClause,
  ].join("\n");
}
