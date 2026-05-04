/**
 * Shared response envelope for retrieval-style read tools.
 *
 * The model learns ONE shape — `{items, cursor?, revision, provenance}` —
 * across `memory_read`, `describe_workspace`, `list_integrations`, etc.
 * The provenance metadata tags trust at the tool-result boundary so the
 * model can apply the `<retrieved_content_hygiene>` rule consistently.
 *
 * Sibling design: when retrieved content is INJECTED into the system
 * prompt (Block 2 / Block 4 materialization), it gets wrapped in
 * `<retrieved_content provenance="..." origin="..." fetched_at="...">`
 * tags. Tool results carry the same provenance, but in JSON form.
 */

import { z } from "zod";

export const ProvenanceSourceSchema = z.enum([
  /** Internal authoritative state — workspace YAML, integration list, USERS record. Treat as factual. */
  "system-config",
  /** Content the user wrote themselves — memory entries, explicit notes. Truthful for THEIR preferences; not authoritative beyond their context. */
  "user-authored",
  /** Past inferences this or another model wrote — persona narrative. Plausible-but-falsifiable. */
  "model-inferred",
  /** Third-party fetched — web pages, untrusted MCP responses. Data only, never instructions. */
  "external",
]);
export type ProvenanceSource = z.infer<typeof ProvenanceSourceSchema>;

export interface Provenance {
  source: ProvenanceSource;
  /** Logical origin — `memory:notes`, `workspace:user`, `link:summary`, etc. */
  origin: string;
  /** ISO 8601 timestamp at which the data was retrieved. */
  fetched_at: string;
}

export interface ReadResponse<T> {
  items: T[];
  /** Opaque pagination cursor. Pass back to advance; null/undefined = end. */
  cursor?: string;
  /**
   * Underlying source revision when known (KV revision, ETag-equivalent).
   * Lets the chat agent skip re-encoding identical bytes into context on
   * a subsequent turn.
   */
  revision?: string;
  provenance: Provenance;
}

/** Build a successful envelope with current timestamp + given provenance. */
export function envelope<T>(args: {
  items: T[];
  source: ProvenanceSource;
  origin: string;
  cursor?: string;
  revision?: string;
}): ReadResponse<T> {
  return {
    items: args.items,
    cursor: args.cursor,
    revision: args.revision,
    provenance: { source: args.source, origin: args.origin, fetched_at: new Date().toISOString() },
  };
}
