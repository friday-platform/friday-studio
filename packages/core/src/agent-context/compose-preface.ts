/**
 * Synthetic user-message preface composer.
 *
 * Lives in `@atlas/core` so both the chat supervisor and FSM `type: llm`
 * actions can consume the same implementation without crossing the chat-
 * package layering boundary (fsm-engine cannot import from workspace-chat).
 *
 * The "synthetic preface" is a string of `<retrieved_content>` envelopes
 * wrapping turn-local context (memory, artifacts, temporal facts, future
 * on-demand retrieval). The caller decides where the string lands — chat
 * prepends as a synthetic user message at position 0; FSM prepends to
 * the action prompt; future call sites may inject mid-turn.
 *
 * Why turn-local context lives here and not in the system prompt:
 *
 *   - Cache economics. The system prompt is split into byte-stable
 *     cache blocks (weeks-stable, workspace-stable, session-stable)
 *     so the provider's prefix cache hits across turns. Mixing per-turn
 *     retrieval bytes into the system prompt would invalidate that
 *     prefix on every turn.
 *
 *   - Tenancy isolation. System-prompt bytes can be cache-eligible
 *     across tenants (depending on provider scope). Turn-local
 *     retrieved content is org-private; routing it through user
 *     messages keeps the cache boundary clean.
 *
 *   - Provider-neutral. The `<retrieved_content>` envelope is
 *     understood by Claude and GPT as data, not instructions, without
 *     provider-specific markup.
 */

/**
 * One retrieval-gated entry. Becomes a single `<retrieved_content>`
 * envelope when rendered.
 *
 * Field semantics:
 *   - `source`     → `provenance` attribute. Identifies what the bytes
 *                    represent (e.g. `"artifact:abc123"`,
 *                    `"web:https://..."`, `"memory:decisions"`).
 *   - `origin`     → `origin` attribute. Identifies the host scope the
 *                    content was fetched from (e.g.
 *                    `"workspace:wsId/session:sId"`).
 *   - `body`       → envelope body. The model-facing text.
 *   - `fetched_at` → optional `fetched_at` attribute. ISO timestamp.
 *                    Omit when retrieval is conceptually "always fresh"
 *                    or freshness is not meaningful for the source.
 */
export interface PrefaceEntry {
  source: string;
  origin: string;
  body: string;
  fetched_at?: string;
}

/**
 * Render entries into joined `<retrieved_content>` envelopes. Returns
 * `""` for an empty list so callers can concatenate without conditional
 * branches.
 *
 * Positionally indifferent — caller decides whether to prepend, append,
 * or otherwise place the result. The chat path prepends as a synthetic
 * user message at position 0; the FSM `type: llm` path prepends to the
 * action's contextPrompt; a future on-demand mid-turn retrieval site
 * would call the same helper with freshly-fetched entries.
 *
 * The XML envelope is the trust signal: frontier models recognize
 * `<retrieved_content>` as data-not-instructions and resist instruction-
 * injection attempts inside the body.
 */
export function composePreface(entries: PrefaceEntry[]): string {
  if (entries.length === 0) return "";
  return entries.map(renderEnvelope).join("\n\n");
}

function renderEnvelope(e: PrefaceEntry): string {
  const fetchedAt = e.fetched_at ? ` fetched_at="${e.fetched_at}"` : "";
  // Defang `</retrieved_content>` inside the body so a payload containing
  // the literal close tag can't prematurely close the envelope and let
  // downstream bytes land outside the data frame, where the model would
  // treat them as instructions. Mirrors `wrapRetrieved` in
  // `@atlas/llm/retrieved-content.ts` — kept in lockstep intentionally
  // because folding the two into a single helper would force `@atlas/core`
  // and `@atlas/llm` into a layering tangle for a five-line render path.
  const safeBody = e.body.replace(/<\/retrieved_content\s*>/gi, "<\\/retrieved_content>");
  return `<retrieved_content provenance="${e.source}" origin="${e.origin}"${fetchedAt}>\n${safeBody}\n</retrieved_content>`;
}
