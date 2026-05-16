import { VariableSchemaSchema, type VariableDeclaration } from "@atlas/config";
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

export type VariableValidationResult =
  | { ok: true }
  | { ok: false; reason: "type" | "schema"; message: string };

/**
 * Coerce a raw `.env` string into the declared variable's type, then validate
 * against the schema. The proposed value rides on `env_set`'s `vars` payload
 * as a string (env files are stringly-typed), so coercion mirrors
 * `coerceFromString` in `@atlas/workspace`'s `variable-interpolation.ts`.
 */
export function validateProposedValue(
  declaration: VariableDeclaration,
  rawValue: string,
): VariableValidationResult {
  const coerced = coerceFromString(declaration.schema.type, rawValue);
  if (coerced === undefined) {
    return { ok: false, reason: "type", message: typeMismatchMessage(declaration.schema.type) };
  }
  const zodSchema = z.fromJSONSchema(VariableSchemaSchema.parse(declaration.schema));
  const parsed = zodSchema.safeParse(coerced);
  if (parsed.success) return { ok: true };
  const first = parsed.error.issues[0];
  return {
    ok: false,
    reason: "schema",
    message: first?.message ?? "Value does not match the declared schema.",
  };
}

type VariableType = "string" | "number" | "integer" | "boolean";

function coerceFromString(type: VariableType, raw: string): string | number | boolean | undefined {
  switch (type) {
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
    default:
      return assertExhaustive(type);
  }
}

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
