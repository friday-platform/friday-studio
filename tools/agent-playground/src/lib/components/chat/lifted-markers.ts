/**
 * Detect `[attachment lifted to artifact <id> ...]` markers inside a tool
 * result. Markers are emitted by the artifact scrubber
 * (`packages/core/src/artifacts/scrubber.ts`) when an MCP tool returns a
 * payload above the lift threshold (~4 KB binary, ~8 KB text). The bytes
 * are uploaded to the artifact Object Store and the original string is
 * replaced with a short reference so the LLM never sees the raw bytes.
 *
 * Without UI handling, a user opening the tool-call card sees only the
 * opaque marker text. This module surfaces the artifact IDs so the card
 * can render the actual artifact (image / PDF / JSON / text preview) via
 * the existing `ArtifactCard` component.
 *
 * The marker shape produced by `refMarker` is:
 *   `[attachment lifted to artifact <id> (<kb> KB, <mime>, from <server>/<tool>) — use display_artifact or artifacts_get to read]`
 *
 * The id is the first whitespace-delimited token after `artifact `.
 */

/** Regex that matches the full marker and captures the artifact id. */
const MARKER_RE = /\[attachment lifted to artifact ([^\s\]]+)[^\]]*\]/g;

export interface LiftedArtifactRef {
  artifactId: string;
}

/**
 * Recursively scan an arbitrary tool-result value and collect every artifact
 * id referenced by a lifted-marker. Walks strings, arrays, and plain objects.
 * Order matches a depth-first, in-order traversal of the source value so the
 * UI can render previews in the same order they appear in the result.
 *
 * Duplicates are dropped (first-occurrence wins). The same artifact id often
 * shows up in more than one field of a single tool result — e.g. once in the
 * top-level summary string and again under `aiSummary.keyDetails[].url` —
 * and downstream callers render one card per artifact, so emitting the same
 * id twice both wastes a card and breaks the keyed `{#each}` in
 * `tool-call-card.svelte` (`each_key_duplicate`).
 */
export function extractLiftedArtifactIds(value: unknown): LiftedArtifactRef[] {
  const seen = new Set<string>();
  const refs: LiftedArtifactRef[] = [];
  walk(value, refs, seen, 0);
  return refs;
}

function walk(
  value: unknown,
  refs: LiftedArtifactRef[],
  seen: Set<string>,
  depth: number,
): void {
  // Cap recursion to match the scrubber's MAX_DEPTH; tool results are
  // shallow JSON in practice, this is a defensive stop for cyclic shapes.
  if (depth > 16) return;
  if (typeof value === "string") {
    // Reset lastIndex defensively — the regex is module-scoped with /g.
    MARKER_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = MARKER_RE.exec(value)) !== null) {
      const artifactId = m[1];
      if (artifactId && !seen.has(artifactId)) {
        seen.add(artifactId);
        refs.push({ artifactId });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) walk(v, refs, seen, depth + 1);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) walk(v, refs, seen, depth + 1);
  }
}
