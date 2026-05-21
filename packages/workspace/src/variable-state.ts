/**
 * Per-variable resolution — the single source of truth for "what is the
 * current state of this declared variable?"
 *
 * Workspace authors declare variables with labels, descriptions, and JSON
 * Schemas in `workspace.yml`. Three call sites need to ask the same question
 * of `(declaration, envValue)` and must not silently drift:
 *
 * - `resolveWorkspaceSetupRequirements` packages unfilled variables as setup
 *   blanks (see `setup-requirements.ts`).
 * - The Settings → Variables daemon endpoint surfaces every variable, filled
 *   or not, with its effective value and any validation error.
 * - The bootstrap setup card's per-field validation uses the same
 *   decode + schema pipeline.
 *
 * This module centralizes that resolution. `value` / `effective_value` carry
 * `string | null` rather than `string | undefined` because these cross the
 * wire to the client as JSON — `null` round-trips, `undefined` doesn't.
 */

import {
  decodeFromEnv,
  type VariableDeclaration,
  VariableSchemaSchema,
} from "@atlas/config";
import { z } from "zod";

export type VariableSource = "env" | "default" | "unset";

export interface VariableState {
  name: string;
  declaration: VariableDeclaration;
  /** Raw env value as it sits in `.env`, or `null` when the key is absent. */
  value: string | null;
  /**
   * Stringified coerced value — env value when it passes, otherwise the
   * schema default when that passes. `null` when `source === "unset"`.
   */
  effective_value: string | null;
  source: VariableSource;
  is_filled: boolean;
  /**
   * Set only when the raw env value is present but fails decode or schema.
   * Absent when env is missing or when env passes. Even with a recoverable
   * schema default, the env-side failure is still surfaced so the UI can
   * show the inline error on the env-backed row.
   */
  validation_error?: string;
}

/**
 * Resolve one variable's state from its declaration and the raw env value
 * looked up at `variableEnvKey(name)`. Caller-side env-key derivation
 * intentionally stays out of this helper — it's a pure
 * `(decl, raw) -> state` mapping.
 */
export function resolveVariableState(
  name: string,
  declaration: VariableDeclaration,
  envValue: string | undefined,
): VariableState {
  const zodSchema = z.fromJSONSchema(VariableSchemaSchema.parse(declaration.schema));
  const value = envValue ?? null;

  if (envValue !== undefined) {
    const decoded = decodeFromEnv(envValue, declaration);
    if (decoded === undefined) {
      return withDefaultFallback({
        name,
        declaration,
        value,
        validation_error: typeMismatchMessage(declaration.schema.type),
        zodSchema,
      });
    }
    const parsed = zodSchema.safeParse(decoded);
    if (parsed.success) {
      return {
        name,
        declaration,
        value,
        effective_value: String(parsed.data),
        source: "env",
        is_filled: true,
      };
    }
    return withDefaultFallback({
      name,
      declaration,
      value,
      validation_error: parsed.error.issues[0]?.message ?? "Value does not match the declared schema.",
      zodSchema,
    });
  }

  return withDefaultFallback({ name, declaration, value, zodSchema });
}

interface FallbackArgs {
  name: string;
  declaration: VariableDeclaration;
  value: string | null;
  validation_error?: string;
  zodSchema: z.ZodType;
}

function withDefaultFallback(args: FallbackArgs): VariableState {
  const { name, declaration, value, validation_error, zodSchema } = args;
  const fallback = declaration.schema.default;
  if (fallback !== undefined) {
    const parsed = zodSchema.safeParse(fallback);
    if (parsed.success) {
      const state: VariableState = {
        name,
        declaration,
        value,
        effective_value: String(parsed.data),
        source: "default",
        is_filled: true,
      };
      if (validation_error !== undefined) state.validation_error = validation_error;
      return state;
    }
  }
  const state: VariableState = {
    name,
    declaration,
    value,
    effective_value: null,
    source: "unset",
    is_filled: false,
  };
  if (validation_error !== undefined) state.validation_error = validation_error;
  return state;
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
  }
}
