/**
 * Shared model variants for cross-model eval coverage.
 *
 * Today the eval harness only tests one or two models per suite. Listing the
 * standard tiers in one place lets a suite opt into the full matrix with a
 * single import — and lets us swap models (Haiku 4.5 → 5, Groq Llama → next)
 * in exactly one place instead of N eval files.
 *
 * The IDs match `@atlas/llm`'s `registry.languageModel(...)` form. Suites
 * that use `smallLLM()` (currently small-llm.eval.ts) keep their own
 * provider-specific dispatch — once `smallLLM` adopts the registry path,
 * variants become the single source of truth.
 */

export type ModelTier = "sm" | "md" | "lg";

export interface ModelVariant {
  /** Display label used in eval names — kept short. */
  name: string;
  /** Tier slot in the matrix: sm = cheap/fast, md = balanced, lg = quality. */
  tier: ModelTier;
  /** ID for `registry.languageModel(...)`. */
  modelId: string;
  /** Whether this variant runs in PR CI (cheap tier) or only nightly. */
  pr: boolean;
}

/**
 * Standard model matrix.
 *
 * Tier discipline: the "balanced" slot stays at the level that prod uses for
 * agent calls today; "quality" is the upgrade we'd ship if regression-free;
 * "cheap" is the floor we expect to clear basic format compliance.
 *
 * Keep this list <= 4 entries — every eval multiplies its case count by the
 * matrix size, and CI minutes are not free.
 */
export const STANDARD_MODELS: readonly ModelVariant[] = [
  { name: "Groq", tier: "sm", modelId: "groq:llama-3.1-8b-instant", pr: true },
  { name: "Haiku", tier: "md", modelId: "anthropic:claude-haiku-4-5", pr: true },
  { name: "Sonnet", tier: "lg", modelId: "anthropic:claude-sonnet-4-6", pr: false },
] as const;

/** Subset used in PR CI — drops the quality tier to keep wall-clock + spend bounded. */
export const PR_MODELS: readonly ModelVariant[] = STANDARD_MODELS.filter((m) => m.pr);

/**
 * Resolve the active variant set from `EVAL_MATRIX` env var.
 *
 * - `EVAL_MATRIX=pr`        → cheap two (default in CI)
 * - `EVAL_MATRIX=full`      → all three
 * - `EVAL_MATRIX=Haiku`     → single named variant (case-sensitive)
 * - unset (local dev)       → all three (`STANDARD_MODELS`)
 */
export function resolveVariants(env: Record<string, string | undefined>): readonly ModelVariant[] {
  const raw = env.EVAL_MATRIX;
  if (!raw) return STANDARD_MODELS;
  if (raw === "pr") return PR_MODELS;
  if (raw === "full") return STANDARD_MODELS;

  const byName = STANDARD_MODELS.find((m) => m.name === raw);
  if (byName) return [byName];

  throw new Error(
    `Unknown EVAL_MATRIX="${raw}". Expected "pr", "full", or a model name (one of: ${STANDARD_MODELS.map((m) => m.name).join(", ")})`,
  );
}
