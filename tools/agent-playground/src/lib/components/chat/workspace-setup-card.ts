/**
 * Pure helpers for `workspace-setup-card.svelte`. Split out so the
 * validate + coerce + payload-build path is unit-testable without spinning
 * up a Svelte component.
 *
 * Variable validation reuses {@link validateProposedValue} from
 * `env-write-variable-awareness.ts` — same string→typed→schema coercion
 * pipeline used by the env-write card (#17), so a value the user types here
 * passes the same gate it would as an `env_set` proposal.
 */
import type {
  SetupRequirement,
  WorkspaceSetupAnswerValue,
} from "@atlas/core/elicitations/model";
import type { VariableDeclaration } from "@atlas/config";
import {
  validateProposedValue,
  type VariableValidationResult,
} from "./env-write-variable-awareness.ts";

/** Only variable requirements are handled in v1 — credentials land in #16. */
export type VariableRequirement = Extract<SetupRequirement, { kind: "variable" }>;

export function isVariableRequirement(req: SetupRequirement): req is VariableRequirement {
  return req.kind === "variable";
}

export function variableRequirements(reqs: readonly SetupRequirement[]): VariableRequirement[] {
  return reqs.filter(isVariableRequirement);
}

/**
 * Validate one raw string field against its declaration. Reuses the
 * env-write validator so a "valid" value here is also valid for the env-write
 * confirmation flow downstream.
 */
export function validateField(req: VariableRequirement, raw: string): VariableValidationResult {
  const declaration: VariableDeclaration = {
    schema: req.schema,
    ...(req.description !== undefined ? { description: req.description } : {}),
  };
  return validateProposedValue(declaration, raw);
}

type CoercedPrimitive = string | number | boolean;

/**
 * Coerce a validated raw string into its declared primitive type. The
 * elicitation answer dispatcher re-validates against the schema (see
 * `apps/atlasd/routes/elicitations/index.ts`), so we only need to ship the
 * typed value — bare strings would fail server-side coercion for
 * `boolean`/`integer`/`number` fields.
 *
 * Returns `undefined` for any unrecognised type — caller skips that field
 * rather than shipping a malformed value.
 */
function coerceForPayload(req: VariableRequirement, raw: string): CoercedPrimitive | undefined {
  switch (req.schema.type) {
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
      return undefined;
  }
}

/**
 * Build the answer payload for `POST /api/elicitations/:id/answer`. `values`
 * is keyed by requirement name; missing keys → empty string (caller's
 * disabled-submit guard prevents that, but we tolerate it cleanly).
 *
 * Credential choices are left empty in v1 — #16 fills them in.
 */
export function buildSetupAnswerValue(
  requirements: readonly VariableRequirement[],
  values: Readonly<Record<string, string>>,
): WorkspaceSetupAnswerValue {
  const variableValues: Record<string, CoercedPrimitive> = {};
  for (const req of requirements) {
    const raw = values[req.name] ?? "";
    const coerced = coerceForPayload(req, raw);
    if (coerced !== undefined) variableValues[req.name] = coerced;
  }
  return { variableValues, credentialChoices: {} };
}

/**
 * True when every variable requirement has a non-empty value AND every
 * value passes its declared schema. Drives the Submit button's disabled
 * state.
 */
export function allFieldsValid(
  requirements: readonly VariableRequirement[],
  values: Readonly<Record<string, string>>,
): boolean {
  for (const req of requirements) {
    const raw = values[req.name] ?? "";
    if (raw.length === 0) return false;
    const result = validateField(req, raw);
    if (!result.ok) return false;
  }
  return true;
}
