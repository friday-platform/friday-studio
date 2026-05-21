/**
 * Elicitation domain model.
 *
 * An **elicitation** is a Human-In-The-Loop pause-and-ask event raised
 * by a supervisor (chat or FSM/session) when it needs user input mid-
 * execution. Surfaced in the UI as the **Activity** feature page; the
 * code primitive is named `elicitation` to match the MCP spelling.
 *
 * Trigger kinds:
 *
 *  - **`tool-allowlist`** — an agent requests access to a tool outside
 *    the current allowlist. Runtime asks: allow once / allow always / deny.
 *  - **`auth-refresh`** — MCP server returned 401 / token-expired.
 *  - **`confirm-action`** — author-declared `confirm_before: true` on a
 *    destructive tool.
 *  - **`open-question`** — agents call the `request_human_input`
 *    platform tool when they need a judgment call.
 *  - **`env-write`** — the `env_set` tool wants to write a value to a
 *    workspace (or global) `.env`. The user reviews the key + value
 *    (masked when secret-bearing) and confirms or denies before the write
 *    lands. `pendingTool` carries `{ name: "env_set", args: { scope, key,
 *    value, ... } }`.
 *  - **`workspace-setup`** — a workspace requires setup before it can run
 *    (unfilled declared variables and/or unresolved credential refs). The
 *    request payload carries `setupRequirements: SetupRequirement[]` (see
 *    `SetupRequirementSchema`) — a snapshot of the unfilled blanks at spawn
 *    time, captured for the form's initial render. The answer `value` is
 *    the structured object `{ variableValues, credentialChoices }` rather
 *    than a string option. Exempt from the 30-minute expiry sweep — setup
 *    may sit unfinished for days.
 *
 * Storage layout lives in `jetstream-adapter.ts`. This file is the shared
 * Zod schema + TypeScript type boundary used by daemon routes, MCP tools,
 * and runtime wait/resume code.
 */

import { VariableSchemaSchema } from "@atlas/config";
import { z } from "zod";

/** What triggered the elicitation. Drives UI rendering + answer plumbing. */
export const ElicitationKindSchema = z.enum([
  "tool-allowlist",
  "auth-refresh",
  "confirm-action",
  "open-question",
  "env-write",
  "workspace-setup",
]);
export type ElicitationKind = z.infer<typeof ElicitationKindSchema>;

/** Lifecycle state. `pending → answered | declined | expired`. */
export const ElicitationStatusSchema = z.enum(["pending", "answered", "declined", "expired"]);
export type ElicitationStatus = z.infer<typeof ElicitationStatusSchema>;

/**
 * A single selectable option presented to the user (e.g. "Allow once" /
 * "Allow always" / "Deny" for tool-allowlist denials). Optional —
 * `open-question` elicitations may take free-form text.
 */
export const ElicitationOptionSchema = z.object({ label: z.string(), value: z.string() });
export type ElicitationOption = z.infer<typeof ElicitationOptionSchema>;

/**
 * One unfilled blank carried inside a `workspace-setup` elicitation's
 * `setupRequirements` payload. Structurally matches `SetupRequirement` from
 * `@atlas/workspace`; redeclared here because `@atlas/core` cannot import
 * `@atlas/workspace` (would cycle).
 */
export const SetupRequirementSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("variable"),
    name: z.string(),
    /** Author-supplied friendly label; falls back to `name` in the UI. */
    display_name: z.string().optional(),
    description: z.string().optional(),
    schema: VariableSchemaSchema,
  }),
  z.object({
    kind: z.literal("credential"),
    provider: z.string(),
    path: z.string(),
    key: z.string(),
    reason: z.enum(["no_default", "stale_id"]),
  }),
]);
export type SetupRequirement = z.infer<typeof SetupRequirementSchema>;

/**
 * Answer payload for `workspace-setup`. The envelope stays flat
 * (`{ value, note? }`) — only the shape of `value` changes vs the
 * string-valued kinds.
 *
 * - `variableValues`: keyed by declared variable name, value typed
 *   against the variable's declared schema (validated at dispatch time,
 *   not here).
 * - `credentialChoices`: keyed by provider, value is the chosen Link
 *   credential id.
 */
export const WorkspaceSetupAnswerValueSchema = z.object({
  variableValues: z.record(z.string(), z.unknown()),
  credentialChoices: z.record(z.string(), z.string()),
});
export type WorkspaceSetupAnswerValue = z.infer<typeof WorkspaceSetupAnswerValueSchema>;

/**
 * The user's response. For string-valued kinds (`tool-allowlist`,
 * `auth-refresh`, `confirm-action`, `open-question`, `env-write`) the
 * `value` is the chosen option's `value` or free-form text. For
 * `workspace-setup` the `value` is the structured
 * {@link WorkspaceSetupAnswerValueSchema} object. `note` is optional
 * context (e.g. "answered from web client").
 */
export const ElicitationAnswerSchema = z.object({
  value: z.union([z.string(), WorkspaceSetupAnswerValueSchema]),
  note: z.string().optional(),
  answeredBy: z.string().optional(),
  answeredAt: z.iso.datetime(),
});
export type ElicitationAnswer = z.infer<typeof ElicitationAnswerSchema>;

/** Pending tool-call snapshot for `tool-allowlist` denials. */
export const ElicitationPendingToolSchema = z.object({
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});
export type ElicitationPendingTool = z.infer<typeof ElicitationPendingToolSchema>;

/** Full elicitation entity. Persisted as one JSON message per elicitation. */
export const ElicitationSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  sessionId: z.string(),
  /** FSM state/action where it was raised. Optional (chat-supervisor case). */
  actionId: z.string().optional(),
  kind: ElicitationKindSchema,
  question: z.string(),
  options: z.array(ElicitationOptionSchema).optional(),
  /** Populated for `tool-allowlist`: the tool that was denied + its args. */
  pendingTool: ElicitationPendingToolSchema.optional(),
  /**
   * Populated for `workspace-setup`: the live-derived list of unfilled
   * variables and unresolved credentials the form should render. Captured at
   * spawn time; the answer dispatcher re-derives from current config for
   * validation rather than trusting this snapshot.
   */
  setupRequirements: z.array(SetupRequirementSchema).optional(),
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  status: ElicitationStatusSchema,
  answer: ElicitationAnswerSchema.optional(),
});
export type Elicitation = z.infer<typeof ElicitationSchema>;

/**
 * Input shape for `ElicitationStorage.create`. The adapter fills in
 * `id`, `status`, and `createdAt`; everything else the caller provides.
 */
export const CreateElicitationSchema = ElicitationSchema.omit({
  id: true,
  status: true,
  createdAt: true,
  answer: true,
});
export type CreateElicitationInput = z.infer<typeof CreateElicitationSchema>;
