import { decodeFromEnv, VariableSchemaSchema, type VariableDeclaration } from "@atlas/config";
import { z } from "zod";

/**
 * Source of truth: `variableEnvKey(name)` in `@atlas/workspace`
 * (`packages/workspace/src/variable-interpolation.ts`) — keep this in lockstep.
 */
function variableEnvKey(name: string): string {
  return name.toUpperCase();
}

export interface DeclaredVariableMatch {
  name: string;
  declaration: VariableDeclaration;
}

/**
 * Reverse-derive a declared variable from a proposed env key. Returns the
 * first declaration whose auto-derived key matches; `null` when the key does
 * not belong to any declared variable (caller falls back to raw rendering).
 */
export function findDeclaredVariableForKey(
  declarations: Record<string, VariableDeclaration> | undefined,
  key: string,
): DeclaredVariableMatch | null {
  if (!declarations) return null;
  for (const [name, declaration] of Object.entries(declarations)) {
    if (variableEnvKey(name) === key) return { name, declaration };
  }
  return null;
}

/**
 * Friendly label for an env-write row when the key matches a declared
 * variable that supplies a `display_name`. Returns `null` for unmatched
 * keys and for declarations that omit `display_name` — callers fall back
 * to the raw env key (which is also the agent's proposal target, so it
 * stays visible on the row regardless).
 */
export function displayNameForKey(
  declarations: Record<string, VariableDeclaration> | undefined,
  key: string,
): string | null {
  const match = findDeclaredVariableForKey(declarations, key);
  return match?.declaration.display_name ?? null;
}

export type VariableValidationResult =
  | { ok: true }
  | { ok: false; reason: "type" | "schema"; message: string };

/**
 * Coerce a raw `.env` string into the declared variable's type, then validate
 * against the schema. The proposed value rides on `env_set`'s `vars` payload
 * as a string (env files are stringly-typed), so decoding goes through the
 * shared `decodeFromEnv` codec in `@atlas/config` to stay in lockstep with
 * the answer-handler's encode side.
 */
export function validateProposedValue(
  declaration: VariableDeclaration,
  rawValue: string,
): VariableValidationResult {
  const decoded = decodeFromEnv(rawValue, declaration);
  if (decoded === undefined) {
    return { ok: false, reason: "type", message: typeMismatchMessage(declaration.schema.type) };
  }
  const zodSchema = z.fromJSONSchema(VariableSchemaSchema.parse(declaration.schema));
  const parsed = zodSchema.safeParse(decoded);
  if (parsed.success) return { ok: true };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    reason: "schema",
    message: first?.message ?? "Value does not match the declared schema.",
  };
}

type VariableType = VariableDeclaration["schema"]["type"];

function typeMismatchMessage(type: VariableType): string {
  switch (type) {
    case "boolean":
      return "Expected `true` or `false`.";
    case "integer":
      return "Expected an integer.";
    case "number":
      return "Expected a number.";
    case "string":
      return "Expected a string.";
    default:
      return assertExhaustive(type);
  }
}

function assertExhaustive(value: never): never {
  throw new Error(`Unhandled variable schema type: ${String(value)}`);
}
