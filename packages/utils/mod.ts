import { z } from "zod/v4";

/**
 * @atlas/utils - Shared utility functions for Atlas
 */

/**
 * Converts an error to a human-readable string.
 */
export function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Helper function for formatting Zod errors
 */
export function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}

export type Result<T, U> = { ok: true; data: T } | { ok: false; error: U };

/**
 * Mimics the Result type from Rust/Effect.ts, because it's often
 * better to have errors as values rather than exceptions.
 *
 * @example
 * ```typescript
 * function mayThrow(val: number): number {
 *   if (val < 0) {
 *     throw new Error('Value must be non-negative');
 *   }
 *   return Math.sqrt(val);
 * }
 *
 * const safeSqrt = resultOf(mayThrow);
 *
 * const result1 = safeSqrt(16);
 * if (result1.ok) {
 *   console.log(result1.data); // 4
 * }
 *
 * const result2 = safeSqrt(-1);
 * if (!result2.ok) {
 *   console.log(result2.error); // Error: Value must be non-negative
 * }
 * ```
 *
 * @see https://doc.rust-lang.org/std/result/
 * @see https://hamy.xyz/blog/2025-07_typescript-result-types
 * @see https://imhoff.blog/posts/using-results-in-typescript
 * @see https://x.com/mattpocockuk/status/1633064377518628866
 */
export function resultOf<TArgs extends unknown[], TReturn>(
  func: (...args: TArgs) => TReturn,
): (...args: TArgs) => Result<TReturn, unknown> {
  return (...args: TArgs): Result<TReturn, unknown> => {
    try {
      const data = func(...args);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error };
    }
  };
}

/**
 * Creates a successful Result.
 */
export function success<T>(data: T): Result<T, never> {
  return { ok: true, data };
}

/**
 * Creates a failed Result.
 */
export function fail<U>(error: U): Result<never, U> {
  return { ok: false, error };
}
