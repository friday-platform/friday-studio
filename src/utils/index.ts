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
export type ObjectEntry<T> = {
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
export const objectEntries = Object.entries as <T>(
  o: T,
) => Array<ObjectEntry<T>>;
