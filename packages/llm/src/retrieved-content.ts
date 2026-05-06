/**
 * Retrieved-content envelope for prompt-string injection.
 *
 * Sibling to `packages/system/agents/workspace-chat/tools/envelope.ts`
 * which carries the JSON form returned from read tools. This module
 * builds the prompt-string form: text wrapped in
 * `<retrieved_content provenance="..." origin="..." fetched_at="...">`
 * tags so the model's `<retrieved_content_hygiene>` rule can apply.
 *
 * Used at every boundary where untrusted or external content enters a
 * prompt — FSM agent inputs, prepare results, document payloads, signal
 * data — so the model treats them as data, not commands.
 */

/**
 * Provenance source — the trust tier of a retrieved value.
 *
 * Mirrored verbatim from
 * `packages/system/agents/workspace-chat/tools/envelope.ts:ProvenanceSource`
 * intentionally; both forms (JSON tool response + prompt-string envelope)
 * use the same vocabulary so the model learns one rule. Folding into a
 * shared module would require pulling `@atlas/llm` into the workspace-chat
 * tools package or vice versa; the duplication is small and stable enough
 * that copies-with-comment is the right tradeoff.
 */
export type ProvenanceSource =
  /** Internal authoritative state — workspace YAML, USERS record. Treat as factual. */
  | "system-config"
  /** Content the user wrote themselves — memory entries, chat messages. */
  | "user-authored"
  /** Past inferences this or another model wrote — persona narrative. */
  | "model-inferred"
  /** Third-party fetched — web pages, HTTP webhook payloads, untrusted MCP responses. */
  | "external";

/**
 * Wrap a string body in a `<retrieved_content>` envelope. Outputs:
 *
 * ```
 * <retrieved_content provenance="<source>" origin="<id>" fetched_at="<ISO>">
 * <body>
 * </retrieved_content>
 * ```
 *
 * The model's `<retrieved_content_hygiene>` rule (in workspace-chat
 * `prompt.txt`) treats anything inside these tags as data, never as
 * instructions — so a malicious webhook payload that says "ignore
 * previous instructions" is data, not a command.
 */
export function wrapRetrieved(args: {
  source: ProvenanceSource;
  origin: string;
  body: string;
  /** Override the timestamp (rare; for tests). Defaults to now(). */
  fetched_at?: string;
}): string {
  const fetched_at = args.fetched_at ?? new Date().toISOString();
  return `<retrieved_content provenance="${args.source}" origin="${args.origin}" fetched_at="${fetched_at}">\n${args.body}\n</retrieved_content>`;
}

/**
 * Map signal provider → default provenance.
 *
 * Called at the FSM/agent boundary so signal payloads are tagged with
 * the right trust tier:
 *
 * | Provider             | Provenance      | Why |
 * |----------------------|-----------------|-----|
 * | `http`               | `external`      | Webhook caller-controlled |
 * | `fs-watch`           | `external`      | File contents may be anything |
 * | `slack`/`telegram`/  | `user-authored` | The user typed it |
 * | `discord`/`whatsapp`/| `user-authored` | (chat communicators) |
 * | `teams`              | `user-authored` | |
 * | `schedule`           | `system-config` | Internal cron trigger |
 * | `system`             | `system-config` | Internal trigger |
 *
 * Unknown / undefined provider falls back to `external` (most cautious —
 * a future provider type that adds untrusted input shouldn't silently
 * inherit `system-config`).
 */
export function provenanceForSignalProvider(provider: string | undefined): ProvenanceSource {
  switch (provider) {
    case "schedule":
    case "system":
      return "system-config";
    case "slack":
    case "telegram":
    case "discord":
    case "whatsapp":
    case "teams":
      return "user-authored";
    case "http":
    case "fs-watch":
      return "external";
    default:
      return "external";
  }
}
