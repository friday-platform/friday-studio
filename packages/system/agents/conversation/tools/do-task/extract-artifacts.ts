import { AgentResultSchema, type ArtifactRef, ArtifactRefSchema } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import { z } from "zod";

/**
 * Minimal schema for flattened FSM output (no envelope metadata).
 * FSM document storage strips agentId/timestamp/durationMs, leaving domain data + artifactRefs.
 *
 * @see docs/plans/2026-02-03-unified-agent-envelope-design.md
 * TODO: Remove after FSM storage migration stores full envelope
 */
const FlattenedOutputSchema = z
  .object({
    response: z.string().optional(),
    artifactRefs: z.array(ArtifactRefSchema).optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

/**
 * Extract artifact references from agent execution output.
 *
 * Handles two shapes (until FSM stores full envelope):
 * - Envelope: { ok, data, artifactRefs } — parsed via AgentResultSchema
 * - Flattened: { response, ...fields, artifactRefs } — parsed via FlattenedOutputSchema
 *
 * @see docs/plans/2026-02-03-unified-agent-envelope-design.md
 * TODO: Simplify after FSM storage migration stores full envelope
 */
export function extractArtifactsFromOutput(output: unknown): ArtifactRef[] {
  // Try envelope first
  const envelope = AgentResultSchema.safeParse(output);
  if (envelope.success && envelope.data.ok) {
    return dedupeArtifacts(envelope.data.artifactRefs);
  }

  // Fall back to flattened shape
  const flattened = FlattenedOutputSchema.safeParse(output);
  if (flattened.success) {
    return dedupeArtifacts(flattened.data.artifactRefs);
  }

  return [];
}

/** Deduplicate artifacts by ID, preserving order */
function dedupeArtifacts(refs: ArtifactRef[] | undefined): ArtifactRef[] {
  if (!refs) return [];
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.id)) return false;
    seen.add(ref.id);
    return true;
  });
}

const MAX_RESPONSE_CHARS = 12_000;

function capResponse(text: string): string {
  if (text.length <= MAX_RESPONSE_CHARS) return text;
  return (
    text.slice(0, MAX_RESPONSE_CHARS) +
    "\n\n[Content truncated — full output stored in artifacts. Use display_artifact to show.]"
  );
}

/** Keys to strip when serializing fallback output. */
const STRIP_KEYS = new Set([
  "agentId",
  "timestamp",
  "input",
  "ok",
  "error",
  "reasoning",
  "toolCalls",
  "toolResults",
  "artifactRefs",
  "outlineRefs",
  "durationMs",
]);

/**
 * Schema for envelope shape (has `ok` discriminant).
 * Looser than AgentResultSchema — accepts partial envelopes missing metadata fields.
 * This handles both full envelopes and test fixtures with minimal fields.
 */
const EnvelopeSchema = z.object({
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.unknown().optional(),
});

/**
 * Schema for data field that may contain a response string.
 * Passthrough allows additional domain-specific fields for fallback serialization.
 */
const DataWithResponseSchema = z.object({ response: z.string().optional() }).passthrough();

/**
 * Sanitize agent output: extract text response, strip metadata.
 *
 * Handles two shapes (until FSM stores full envelope):
 * - Envelope: { ok, data: { response }, error }
 * - Flattened: { response, ...fields }
 *
 * @see docs/plans/2026-02-03-unified-agent-envelope-design.md
 * TODO: Simplify after FSM storage migration stores full envelope
 */
export function sanitizeAgentOutput(
  output: unknown,
): { ok: boolean; data?: { response?: string }; error?: unknown } | undefined {
  // Try envelope shape first (has `ok` discriminant)
  const envelope = EnvelopeSchema.safeParse(output);
  if (envelope.success) {
    if (envelope.data.ok) {
      const dataParsed = DataWithResponseSchema.safeParse(envelope.data.data);
      const dataObj = dataParsed.success ? dataParsed.data : undefined;
      const response = dataObj?.response ?? serializeFallback(dataObj);
      return { ok: true, data: response ? { response: capResponse(response) } : undefined };
    } else {
      return { ok: false, error: envelope.data.error };
    }
  }

  // Fall back to flattened shape (no `ok` field)
  const flattened = FlattenedOutputSchema.safeParse(output);
  if (flattened.success) {
    const hasError = flattened.data.error !== undefined && flattened.data.error !== null;
    const response = flattened.data.response ?? serializeFallback(flattened.data);
    return {
      ok: !hasError,
      data: response ? { response: capResponse(response) } : undefined,
      error: hasError ? flattened.data.error : undefined,
    };
  }

  return undefined;
}

/**
 * Serialize non-metadata fields as JSON fallback when no response string exists.
 * Strips envelope metadata keys to produce clean domain data.
 */
function serializeFallback(obj: Record<string, unknown> | undefined): string | undefined {
  if (!obj) return undefined;

  const filtered: Record<string, unknown> = {};
  let hasKeys = false;
  for (const [key, value] of Object.entries(obj)) {
    if (!STRIP_KEYS.has(key)) {
      filtered[key] = value;
      hasKeys = true;
    }
  }
  if (!hasKeys) return undefined;

  try {
    return JSON.stringify(filtered, null, 2);
  } catch (err) {
    logger.warn("Failed to serialize fallback agent output", { error: err });
    return undefined;
  }
}
