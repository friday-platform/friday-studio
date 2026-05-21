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
import type { VariableDeclaration } from "@atlas/config";
import type { SetupRequirement, WorkspaceSetupAnswerValue } from "@atlas/core/elicitations/model";
import {
  validateProposedValue,
  type VariableValidationResult,
} from "./env-write-variable-awareness.ts";

export type VariableRequirement = Extract<SetupRequirement, { kind: "variable" }>;
export type CredentialRequirement = Extract<SetupRequirement, { kind: "credential" }>;

export function isVariableRequirement(req: SetupRequirement): req is VariableRequirement {
  return req.kind === "variable";
}

export function isCredentialRequirement(req: SetupRequirement): req is CredentialRequirement {
  return req.kind === "credential";
}

export function variableRequirements(reqs: readonly SetupRequirement[]): VariableRequirement[] {
  return reqs.filter(isVariableRequirement);
}

/**
 * Human-facing label for a variable requirement. Authors can declare a
 * friendly `display_name` (e.g. "Email Recipient") in `workspace.yml`; when
 * omitted the env key serves as both label and identifier so unlabelled
 * variables still render readably.
 */
export function labelFor(req: VariableRequirement): string {
  return req.display_name ?? req.name;
}

export function credentialRequirements(reqs: readonly SetupRequirement[]): CredentialRequirement[] {
  return reqs.filter(isCredentialRequirement);
}

/**
 * Distinct providers across all credential requirements. The form renders one
 * picker per provider — multiple requirements pointing at the same provider
 * share a single choice.
 */
export function credentialProviders(reqs: readonly SetupRequirement[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const req of credentialRequirements(reqs)) {
    if (seen.has(req.provider)) continue;
    seen.add(req.provider);
    out.push(req.provider);
  }
  return out;
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
 * Build the answer payload for `POST /api/elicitations/:id/answer`. Variable
 * `values` are keyed by requirement name; credential `choices` are keyed by
 * provider id and map to a Link credential id. Missing variable keys → empty
 * string (caller's disabled-submit guard prevents that, but we tolerate it
 * cleanly). Credential providers without a choice are omitted — the
 * submit-disabled gate guards against that.
 */
export function buildSetupAnswerValue(
  variables: readonly VariableRequirement[],
  values: Readonly<Record<string, string>>,
  credentialProviderIds: readonly string[],
  choices: Readonly<Record<string, string>>,
): WorkspaceSetupAnswerValue {
  const variableValues: Record<string, CoercedPrimitive> = {};
  for (const req of variables) {
    const raw = values[req.name] ?? "";
    const coerced = coerceForPayload(req, raw);
    if (coerced !== undefined) variableValues[req.name] = coerced;
  }
  const credentialChoices: Record<string, string> = {};
  for (const provider of credentialProviderIds) {
    const credentialId = choices[provider];
    if (credentialId !== undefined && credentialId.length > 0) {
      credentialChoices[provider] = credentialId;
    }
  }
  return { variableValues, credentialChoices };
}

/**
 * True when every variable requirement has a non-empty value that passes its
 * declared schema AND every credential provider has a selected credential id.
 * Drives the Submit button's disabled state.
 */
export function allFieldsValid(
  variables: readonly VariableRequirement[],
  values: Readonly<Record<string, string>>,
  credentialProviderIds: readonly string[],
  choices: Readonly<Record<string, string>>,
): boolean {
  for (const req of variables) {
    const raw = values[req.name] ?? "";
    if (raw.length === 0) return false;
    const result = validateField(req, raw);
    if (!result.ok) return false;
  }
  for (const provider of credentialProviderIds) {
    const credentialId = choices[provider];
    if (!credentialId || credentialId.length === 0) return false;
  }
  return true;
}
