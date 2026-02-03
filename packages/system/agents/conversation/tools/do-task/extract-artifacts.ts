import { type ArtifactRef, ArtifactRefSchema } from "@atlas/agent-sdk";
import { logger } from "@atlas/logger";
import { z } from "zod";

const OutputWithArtifactsSchema = z.looseObject({
  artifactRef: ArtifactRefSchema.optional(),
  artifactRefs: z.array(ArtifactRefSchema).optional(),
});

const ResultWrapperSchema = z.object({ ok: z.literal(true), data: OutputWithArtifactsSchema });

const SanitizableDataSchema = z.looseObject({
  response: z.string().optional(),
  summary: z.string().optional(),
  content: z.string().optional(),
  artifactRef: z.unknown().optional(),
  artifactRefs: z.unknown().optional(),
});

const SanitizableWrapperSchema = z.object({
  ok: z.boolean(),
  data: SanitizableDataSchema.optional(),
  error: z.unknown().optional(),
});

/**
 * Extract artifact references from heterogeneous agent outputs.
 *
 * Handles:
 * - Result wrapper: { ok: true, data: { artifactRef | artifactRefs } }
 * - Direct object: { artifactRef | artifactRefs }
 * - Singular vs plural forms
 *
 * Returns deduplicated array by artifact ID.
 */
export function extractArtifactsFromOutput(output: unknown): ArtifactRef[] {
  if (!output || typeof output !== "object") return [];

  const wrapperParse = ResultWrapperSchema.safeParse(output);
  const data = wrapperParse.success ? wrapperParse.data.data : output;

  const parse = OutputWithArtifactsSchema.safeParse(data);
  if (!parse.success) return [];

  const { artifactRef, artifactRefs = [] } = parse.data;
  const all = artifactRef ? [artifactRef, ...artifactRefs] : artifactRefs;

  const seen = new Set<string>();
  return all.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
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

/** Artifact/tool metadata keys to strip before fallback serialization — not domain data. */
const FALLBACK_STRIP_KEYS = new Set([
  "artifactRef",
  "artifactRefs",
  "ok",
  "toolCalls",
  "toolResults",
]);

/** Try to JSON-serialize an object, stripping noise keys. Returns undefined if empty or on error. */
function trySerializeFallback(obj: Record<string, unknown>): string | undefined {
  const filtered: Record<string, unknown> = {};
  let hasKeys = false;
  for (const [key, value] of Object.entries(obj)) {
    if (!FALLBACK_STRIP_KEYS.has(key)) {
      filtered[key] = value;
      hasKeys = true;
    }
  }
  if (!hasKeys) return undefined;
  try {
    return JSON.stringify(filtered, null, 2);
  } catch (err) {
    logger.warn("Failed to serialize fallback agent output", {
      error: err,
      keys: Object.keys(obj),
    });
    return undefined;
  }
}

/**
 * Sanitize agent output: strip artifact refs, normalize text field.
 * Caps response length — full content is already persisted as artifacts.
 * Handles Result wrapper and direct object patterns.
 *
 * When a parse succeeds but yields no text field, and the data contains
 * other meaningful keys, JSON-serializes them as a fallback response.
 * This prevents silent data loss for structured outputs (e.g. spreadsheet lists).
 */
export function sanitizeAgentOutput(
  output: unknown,
): { ok: boolean; data?: { response?: string }; error?: unknown } | undefined {
  if (!output || typeof output !== "object") return undefined;

  const outputKeys = Object.keys(output);

  // Try Result wrapper first
  const wrapperParse = SanitizableWrapperSchema.safeParse(output);
  if (wrapperParse.success) {
    const { ok, data, error } = wrapperParse.data;
    const textField = data?.response
      ? "response"
      : data?.summary
        ? "summary"
        : data?.content
          ? "content"
          : undefined;
    const text = textField ? data?.[textField] : undefined;

    if (text) {
      logger.debug("sanitizeAgentOutput: wrapper text field", {
        path: "wrapper",
        textField,
        outputKeys,
        charCount: text.length,
      });
      return { ok, data: { response: capResponse(text) }, error };
    }

    // Fallback: serialize remaining meaningful fields from wrapper data
    if (data) {
      const fallback = trySerializeFallback(data);
      if (fallback) {
        logger.debug("sanitizeAgentOutput: wrapper fallback serialization", {
          path: "wrapper-fallback",
          outputKeys,
          dataKeys: Object.keys(data),
          charCount: fallback.length,
        });
        return { ok, data: { response: capResponse(fallback) }, error };
      }
    }
    logger.debug("sanitizeAgentOutput: wrapper dropped", {
      path: "wrapper-dropped",
      outputKeys,
      hasData: !!data,
    });
    return { ok, data: undefined, error };
  }

  // Try direct object
  const directParse = SanitizableDataSchema.safeParse(output);
  if (directParse.success) {
    const textField = directParse.data.response
      ? "response"
      : directParse.data.summary
        ? "summary"
        : directParse.data.content
          ? "content"
          : undefined;
    const text = textField ? directParse.data[textField] : undefined;

    if (text) {
      logger.debug("sanitizeAgentOutput: direct text field", {
        path: "direct",
        textField,
        outputKeys,
        charCount: text.length,
      });
      return { ok: true, data: { response: capResponse(text) } };
    }

    // Fallback: serialize remaining meaningful fields
    const fallback = trySerializeFallback(directParse.data);
    if (fallback) {
      logger.debug("sanitizeAgentOutput: direct fallback serialization", {
        path: "direct-fallback",
        outputKeys,
        charCount: fallback.length,
      });
      return { ok: true, data: { response: capResponse(fallback) } };
    }
    logger.debug("sanitizeAgentOutput: direct dropped", { path: "direct-dropped", outputKeys });
    return { ok: true, data: undefined };
  }

  logger.debug("sanitizeAgentOutput: unparseable", { path: "unparseable", outputKeys });
  return undefined;
}
