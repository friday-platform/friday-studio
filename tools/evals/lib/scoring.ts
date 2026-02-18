/**
 * Score type and helpers for eval scoring.
 *
 * Scores are numeric assessments of agent output quality, normalized to 0-1.
 * They're stored in eval output JSON for trend analysis and qualitative review.
 */

/** Numeric assessment of agent output quality. */
export interface Score {
  name: string;
  /** Normalized score value, 0-1 inclusive. */
  value: number;
  /** Human-readable explanation of the score. */
  reason?: string;
  /** Arbitrary metadata for downstream consumers. */
  metadata?: Record<string, unknown>;
}

/**
 * Creates a Score with validation that value is in [0, 1].
 *
 * @param name - Score identifier (e.g., "accuracy", "token-budget")
 * @param value - Normalized score, 0-1 inclusive
 * @param reason - Optional human-readable explanation
 * @throws {RangeError} If value is outside [0, 1] or NaN
 */
export function createScore(name: string, value: number, reason?: string): Score {
  if (!(value >= 0 && value <= 1)) {
    throw new RangeError(`Score value must be between 0 and 1, got ${value}`);
  }
  const score: Score = { name, value };
  if (reason !== undefined) {
    score.reason = reason;
  }
  return score;
}

/**
 * Returns the arithmetic mean of score values.
 *
 * @returns Mean value, or 0 for an empty array
 */
export function aggregateScores(scores: Score[]): number {
  if (scores.length === 0) return 0;
  const sum = scores.reduce((acc, s) => acc + s.value, 0);
  return sum / scores.length;
}
