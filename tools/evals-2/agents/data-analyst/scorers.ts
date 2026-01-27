/**
 * Deterministic scorers for data-analyst evaluation.
 *
 * These scorers validate structured output properties without LLM calls,
 * providing fast, reproducible results for row counts and failure cases.
 */

/**
 * Extended input type with optional scoring fields for deterministic validation.
 */
export type DataAnalystInput = {
  prompt: string;
  artifactIds: string[];
  /** Expected row count for grouped queries - when set, RowCountScorer validates this */
  expectedRowCount?: number;
  /** Whether this test case should result in an error - when true, FailureScorer expects error output */
  shouldFail?: boolean;
};

/**
 * Output structure from the data analyst agent.
 */
export type DataAnalystOutput = { summary: string; rowCount?: number };

/**
 * Row count validation for grouped queries.
 * Returns 1 if row count matches expected, 0 otherwise.
 * Skips validation (returns 1) if expectedRowCount is not set.
 */
export const RowCountScorer = {
  name: "Row Count Matches",
  scorer: ({ output, input }: { output: DataAnalystOutput; input: DataAnalystInput }): number => {
    // Only score if expectedRowCount is set
    if (input.expectedRowCount === undefined) return 1;
    return output.rowCount === input.expectedRowCount ? 1 : 0;
  },
};

/**
 * Failure case validation.
 * Returns 1 if failure expectation matches reality:
 * - shouldFail=true: output should start with "Error:"
 * - shouldFail=false/undefined: output should NOT start with "Error:"
 */
export const FailureScorer = {
  name: "Expected Failure",
  scorer: ({ output, input }: { output: DataAnalystOutput; input: DataAnalystInput }): number => {
    const hasError = output.summary.startsWith("Error:");

    if (input.shouldFail) {
      // Should have failed with error prefix
      return hasError ? 1 : 0;
    }
    // Should NOT have failed
    return hasError ? 0 : 1;
  },
};
