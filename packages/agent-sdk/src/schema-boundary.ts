/**
 * Schema Boundary
 *
 * Parse-before-commit pattern: validate input with a Zod schema, then call
 * the commit function, then optionally call onCommit. ZodError propagates
 * naturally on parse failure — no state mutation occurs before a successful parse.
 */

import type { output, ZodType } from "zod";

export interface SchemaBoundaryConfig<TSchema extends ZodType, TCommit> {
  /** Zod v4 schema used to validate `input`. */
  schema: TSchema;
  /** Pure function that writes/commits the validated value and returns TCommit. */
  commit(parsed: output<TSchema>): Promise<TCommit>;
  /** Optional post-commit hook called with the committed result. */
  onCommit?: (result: TCommit) => void | Promise<void>;
}

/**
 * Parse `input` with the provided Zod schema, then call `commit`, then call
 * the optional `onCommit` hook.  Throws `ZodError` on parse failure — no
 * state mutation occurs before a successful parse.
 */
export async function withSchemaBoundary<TSchema extends ZodType, TCommit>(
  config: SchemaBoundaryConfig<TSchema, TCommit>,
  input: unknown,
): Promise<TCommit> {
  const parsed = config.schema.parse(input);
  const result = await config.commit(parsed);
  if (config.onCommit) {
    await config.onCommit(result);
  }
  return result;
}
