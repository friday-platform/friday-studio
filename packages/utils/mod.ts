import { z } from "zod";

const formatter = new Intl.DateTimeFormat("en-US", { dateStyle: "full" });

/**
 * @atlas/utils - Shared utility functions for Atlas
 */

/**
 * Converts an error to a human-readable string.
 *
 * Handles multiple error formats because different libraries and AI SDKs
 * return errors in different shapes:
 * - Standard Error instances (e.g., new Error("message"))
 * - Plain objects with message property (e.g., {type: "api_error", message: "..."})
 * - Plain objects without message (need JSON.stringify to see content)
 * - Primitive values (strings, numbers)
 *
 * Without this handling, plain object errors would display as "[object Object]"
 * which provides no useful information to users or developers.
 *
 * @example
 * stringifyError(new Error("Failed")) // => "Failed"
 * stringifyError({type: "overloaded_error", message: "Overloaded"}) // => "Overloaded"
 * stringifyError({statusCode: 500}) // => '{"statusCode":500}'
 * stringifyError("simple error") // => "simple error"
 */
export function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  // Handle plain objects with message or type properties
  // Common in AI SDK errors: {type: "api_error", message: "Internal server error"}
  if (typeof error === "object" && error !== null) {
    const obj = error as Record<string, unknown>;
    if ("message" in obj && typeof obj.message === "string") {
      return obj.message;
    }
    // Try to stringify meaningfully - better than "[object Object]"
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  return String(error);
}

/**
 * Helper function for formatting Zod errors
 */
export function formatZodError(error: z.ZodError): string {
  return z.prettifyError(error);
}

/**
 * Returns today's date in a human-(or robot)-readable format.
 * @example Monday, 22 September 2025
 */
export function getTodaysDate() {
  return formatter.format(new Date());
}

/**
 * Returns a human readable date string based on the given date.
 * @example Monday, 22 September 2025
 */
export function formatDate(d: Date): string {
  return formatter.format(d);
}

export type Result<T, U = undefined> = { ok: true; data: T } | { ok: false; error: U };

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

/**
 * Like Object.keys, but unsound in exchange for more convenience.
 *
 * Casts the result of Object.keys to the known keys of an object type,
 * even though JavaScript objects may contain additional keys.
 *
 * Only use this function when you know/control the provenance of the object
 * you're iterating, and can verify it contains exactly the keys declared
 * to the type system.
 *
 * Example:
 * ```
 * const o = {x: "ok", y: 10}
 * o["z"] = "UNTRACKED_KEY"
 * const safeKeys = Object.keys(o)
 * const unsafeKeys = objectKeys(o)
 * ```
 * => const safeKeys: string[]
 * => const unsafeKeys: ("x" | "y")[] // Missing "z"
 */
export const objectKeys = Object.keys as <T>(obj: T) => Array<keyof T>;

/**
 * The type of a single item in `Object.entries<T>(value: T)`.
 *
 * Example:
 * ```
 * interface T {x: string; y: number}
 * type T2 = ObjectEntry<T>
 * ```
 * => type T2 = ["x", string] | ["y", number]
 */
type ObjectEntry<T> = {
  // Without Exclude<keyof T, undefined>, this type produces `ExpectedEntries | undefined`
  // if T has any optional keys.
  [K in Exclude<keyof T, undefined>]: [K, T[K]];
}[Exclude<keyof T, undefined>];

/**
 * Like Object.entries, but returns a more specific type which can be less safe.
 *
 * Example:
 * ```
 * const o = {x: "ok", y: 10}
 * const unsafeEntries = Object.entries(o)
 * const safeEntries = objectEntries(o)
 * ```
 * => const unsafeEntries: [string, string | number][]
 * => const safeEntries: ObjectEntry<{
 *   x: string;
 *   y: number;
 * }>[]
 *
 * See `ObjectEntry` above.
 *
 * Note that Object.entries collapses all possible values into a single union
 * while objectEntries results in a union of 2-tuples.
 */
export const objectEntries = Object.entries as <T>(o: T) => Array<ObjectEntry<T>>;

/**
 * zzz
 * @param ms - The number of milliseconds to sleep.
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * For types that may or may not return a Promise.
 */
export type MaybePromise<T> = Promise<T> | T;

/**
 * Returns whether `error` is a NodeJS-style exception with an error code.
 */
export function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && ("errno" in error || "code" in error);
}
