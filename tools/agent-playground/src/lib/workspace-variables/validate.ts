/**
 * Shared validation + payload coercion for workspace variable inputs.
 *
 * Single source of truth consumed by the bootstrap Workspace Setup card and
 * the Settings → Variables surface. Variable validation delegates to
 * {@link validateProposedValue} from `env-write-variable-awareness.ts`, the
 * same string→typed→schema pipeline used by the env-write card (#17).
 */
import type { VariableDeclaration } from "@atlas/config";
import type { SetupRequirement, WorkspaceSetupAnswerValue } from "@atlas/core/elicitations/model";
import {
  validateProposedValue,
  type VariableValidationResult,
} from "../components/chat/env-write-variable-awareness.ts";

export type { VariableValidationResult };

export type VariableRequirement = Extract<SetupRequirement, { kind: "variable" }>;
export type CredentialRequirement = Extract<SetupRequirement, { kind: "credential" }>;

/**
 * Key-name heuristic — kept in sync with the env tools' `shared.ts` and the
 * agent-environment settings section's `SECRET_KEY_RE`. Used by the settings
 * Variables surface to decide whether to render a variable's input as
 * `type="password"`.
 */
const SECRET_KEY_RE = /password|secret|token|key|credential/i;
export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/**
 * Mirror of `variableEnvKey` from `@atlas/workspace` — duplicated here so the
 * client doesn't import the workspace package's barrel (which transitively
 * pulls `node:fs` via `variable-interpolation.ts` and breaks the browser
 * bundle). Keep this function byte-identical to the canonical implementation.
 */
export function variableEnvKey(name: string): string {
  return name.toUpperCase();
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
