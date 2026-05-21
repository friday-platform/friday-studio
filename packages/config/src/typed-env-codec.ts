/**
 * Typed env codec — the single round-trip-safe bridge between the typed
 * `VariableDeclaration` world and the string-only `.env` file world.
 *
 * Workspace `.env` is text. Declared variables carry a typed JSON-Schema
 * subset (`string` | `number` | `integer` | `boolean`). Any code that writes
 * a typed value into `.env` and any code that reads a string back into its
 * declared type must agree on the same encoding, or values silently drift
 * across the boundary and the workspace re-enters setup despite a valid
 * `.env` row.
 *
 * The invariant guaranteed by this module:
 *
 *   decodeFromEnv(encodeForEnv(v, decl), decl) === v
 *
 * for every `v` that the declaration's zod schema accepts. The codec is
 * pure and stateless — callers parse the user-supplied value against the
 * declared zod schema first, then call `encodeForEnv` to write, and call
 * `decodeFromEnv` (followed by a second zod parse if they need
 * constraint-level checks) to read.
 *
 * Consolidates three byte-identical `coerceFromString` copies and one
 * `stringifyForEnv` impl that lived in `setup-requirements.ts`,
 * `variable-interpolation.ts`, and `env-write-variable-awareness.ts` —
 * see review v3 Finding #6.
 */

import type { VariableDeclaration } from "./workspace.ts";

/**
 * The runtime value a declared variable can carry — one of the four scalar
 * JSON-Schema types the workspace `variables:` block allows. The codec
 * preserves this discriminant exactly across the encode/decode round-trip.
 */
export type TypedVariableValue = string | number | boolean;

/**
 * Encode a typed variable value into the string form that `.env` will store.
 *
 * Strings pass through unchanged. Numbers and booleans go through `String()`
 * (`"3.14"`, `"true"`). The wire format is intentionally identical to the
 * pre-consolidation `stringifyForEnv` in `setup-answer-handler.ts` — no
 * existing `.env` files need to be rewritten.
 *
 * The caller is responsible for ensuring `value` already validates against
 * `declaration.schema` (e.g. by running `z.fromJSONSchema(decl.schema)`
 * parse first). `encodeForEnv` does not re-validate — it is the typed-write
 * end of the pipe, not a gate.
 */
export function encodeForEnv(value: unknown, _declaration: VariableDeclaration): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  // Defensive fallback for unexpected types. The variable schema is
  // restricted to the four scalar JSON-Schema types, so this branch
  // shouldn't fire under correct call sites — keeping it instead of
  // throwing matches the pre-consolidation behavior.
  return JSON.stringify(value);
}

/**
 * Decode a raw `.env` string back into the typed value its declaration
 * expects, or `undefined` when the string isn't a valid representation of
 * that type.
 *
 * - `string` — pass-through (any string is valid; schema-level constraints
 *   like `minLength` are the caller's zod-parse responsibility).
 * - `boolean` — only the literal strings `"true"` / `"false"` decode;
 *   everything else (including `"True"`, `"1"`, `"yes"`) is `undefined`.
 * - `integer` — must match `/^-?\d+$/`. Decimals like `"3.14"` decode to
 *   `undefined` so the answer-handler can fail-closed before write.
 * - `number` — any finite `Number(raw)`; empty / whitespace / `NaN` /
 *   `Infinity` decode to `undefined`.
 *
 * `undefined` from this function means "the string-on-disk is not a usable
 * representation of the declared type"; callers should treat that as a
 * setup requirement (live-derivation path) or a pre-write rejection
 * (env-write-aware UI path).
 */
export function decodeFromEnv(
  raw: string,
  declaration: VariableDeclaration,
): TypedVariableValue | undefined {
  switch (declaration.schema.type) {
    case "string":
      return raw;
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return undefined;
    case "integer": {
      if (!/^-?\d+$/.test(raw)) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
    case "number": {
      if (raw.trim() === "") return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    }
  }
}
