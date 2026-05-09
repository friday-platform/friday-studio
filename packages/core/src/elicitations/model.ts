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
 *
 * Storage layout lives in `jetstream-adapter.ts`. This file is the shared
 * Zod schema + TypeScript type boundary used by daemon routes, MCP tools,
 * and runtime wait/resume code.
 */

import { z } from "zod";

/** What triggered the elicitation. Drives UI rendering + answer plumbing. */
export const ElicitationKindSchema = z.enum([
  "tool-allowlist",
  "auth-refresh",
  "confirm-action",
  "open-question",
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
 * The user's response. `value` is the chosen option's `value` (or a
 * free-form string for `open-question`); `note` is optional context
 * (e.g. "answered from web client").
 */
export const ElicitationAnswerSchema = z.object({
  value: z.string(),
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
  createdAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  status: ElicitationStatusSchema,
  answer: ElicitationAnswerSchema.optional(),
});
export type Elicitation = z.infer<typeof ElicitationSchema>;

/**
 * Safe live-update shape for global UI surfaces. Deliberately excludes
 * question text, selectable options, pending tool arguments, and answers so a
 * global stream can drive counts/cache invalidation without leaking HITL
 * content across workspaces.
 */
export const ElicitationSummarySchema = ElicitationSchema.pick({
  id: true,
  workspaceId: true,
  sessionId: true,
  actionId: true,
  kind: true,
  createdAt: true,
  expiresAt: true,
  status: true,
});
export type ElicitationSummary = z.infer<typeof ElicitationSummarySchema>;

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
