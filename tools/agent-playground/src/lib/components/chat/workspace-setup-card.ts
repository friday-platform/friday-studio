/**
 * Pure helpers for `workspace-setup-card.svelte`. Split out so the
 * validate + coerce + payload-build path is unit-testable without spinning
 * up a Svelte component.
 *
 * Validation + payload coercion now live in
 * `$lib/workspace-variables/validate.ts` — the Settings → Variables surface
 * shares the same implementation.
 */
import type { SetupRequirement } from "@atlas/core/elicitations/model";

export {
  allFieldsValid,
  buildSetupAnswerValue,
  validateField,
  type CredentialRequirement,
  type VariableRequirement,
  type VariableValidationResult,
} from "../../workspace-variables/validate.ts";

import {
  type CredentialRequirement,
  type VariableRequirement,
} from "../../workspace-variables/validate.ts";

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
