/**
 * Pure helpers backing the Settings → Workspace Details page's combined
 * identity + variables form.
 *
 * Extracted so the page (which depends on `$app/state` and `$effect`) can
 * stay thin and we can unit-test the trickier transitions: re-seed guards,
 * dirty derivation, edits→payload split, and per-field error merging.
 *
 * The page owns the runes; this module owns the data shapes those runes
 * compute over.
 */
import type { WorkspaceIdentityPatch } from "@atlas/config/mutations";
import type { VariableState } from "@atlas/workspace";

/**
 * Identity inputs as currently bound in the form. Strings are taken
 * verbatim from the inputs; trimming happens at patch-build time so
 * dirty derivation matches what the user sees.
 */
export interface IdentityInputs {
  name: string;
  description: string;
  progressTimeout: string;
  maxTotalTimeout: string;
}

/**
 * Identity values currently persisted on the server, in the same shape as
 * {@link IdentityInputs}. Missing fields collapse to empty strings so the
 * dirty comparison is symmetric.
 */
export interface IdentitySeed {
  name: string;
  description: string;
  progressTimeout: string;
  maxTotalTimeout: string;
}

/** Seed identity inputs from a config's `workspace:` block. */
export function seedIdentityFromConfig(
  identity: {
    name?: string;
    description?: string;
    timeout?: { progressTimeout?: string; maxTotalTimeout?: string };
  } | null,
): IdentitySeed {
  return {
    name: identity?.name ?? "",
    description: identity?.description ?? "",
    progressTimeout: identity?.timeout?.progressTimeout ?? "",
    maxTotalTimeout: identity?.timeout?.maxTotalTimeout ?? "",
  };
}

export function identityDirty(inputs: IdentityInputs, seed: IdentitySeed): boolean {
  return (
    inputs.name !== seed.name ||
    inputs.description !== seed.description ||
    inputs.progressTimeout !== seed.progressTimeout ||
    inputs.maxTotalTimeout !== seed.maxTotalTimeout
  );
}

/**
 * Build the identity patch the composite mutation accepts. Returns
 * `undefined` when no identity field has changed — the mutation skips the
 * identity PUT entirely in that case. Mirrors the server schema: only
 * fields that actually changed are present; timeout is sent as the whole
 * block when any timeout sub-field differs.
 *
 * Returns `{ kind: "error", message }` for invalid input the caller must
 * surface as a toast (name empty, partial timeouts). Returns
 * `{ kind: "ok", patch }` otherwise.
 */
export type IdentityPatchResult =
  | { kind: "ok"; patch: WorkspaceIdentityPatch | undefined }
  | { kind: "error"; message: string };

export function buildIdentityPatch(
  inputs: IdentityInputs,
  seed: IdentitySeed,
): IdentityPatchResult {
  if (!identityDirty(inputs, seed)) return { kind: "ok", patch: undefined };

  const trimmedName = inputs.name.trim();
  if (trimmedName.length === 0) {
    return { kind: "error", message: "Name is required" };
  }

  const patch: WorkspaceIdentityPatch = {};
  if (inputs.name !== seed.name) patch.name = trimmedName;
  if (inputs.description !== seed.description) patch.description = inputs.description;

  const progress = inputs.progressTimeout.trim();
  const maxTotal = inputs.maxTotalTimeout.trim();
  const timeoutChanged =
    progress !== seed.progressTimeout || maxTotal !== seed.maxTotalTimeout;
  if (timeoutChanged) {
    if (progress.length === 0 || maxTotal.length === 0) {
      return {
        kind: "error",
        message: "Both timeout fields are required to change timeouts",
      };
    }
    patch.timeout = { progressTimeout: progress, maxTotalTimeout: maxTotal };
  }

  return { kind: "ok", patch };
}

/**
 * The edits map is keyed by variable name. A string means the user typed
 * a value; `null` means the user clicked "Reset to default" and the env
 * key should be deleted. Variables the user hasn't touched are absent.
 */
export type VariableEdits = Record<string, string | null>;

/**
 * Variables map is dirty when any entry differs from the server-side
 * `effective_value` (after coercing the seeded effective value to the
 * empty-string baseline the input renders). Reset (`null`) is dirty iff
 * the row currently resolves to something other than its schema default —
 * if the row is already showing the default, clicking Reset is a no-op
 * for save purposes.
 */
export function variablesDirty(
  edits: VariableEdits,
  variables: readonly VariableState[],
): boolean {
  if (variables.length === 0) return false;
  const byName = new Map(variables.map((v) => [v.name, v]));
  for (const [name, edit] of Object.entries(edits)) {
    const state = byName.get(name);
    if (!state) continue;
    if (edit === null) {
      if (state.source !== "default") return true;
      continue;
    }
    if (edit !== (state.effective_value ?? "")) return true;
  }
  return false;
}

/** Split the edits map into the two arrays the composite mutation wants. */
export function splitVariableEdits(edits: VariableEdits): {
  variableSets: Record<string, string>;
  variableDeletes: string[];
} {
  const variableSets: Record<string, string> = {};
  const variableDeletes: string[] = [];
  for (const [name, edit] of Object.entries(edits)) {
    if (edit === null) variableDeletes.push(name);
    else variableSets[name] = edit;
  }
  return { variableSets, variableDeletes };
}

/**
 * After a partial-failure response, drop edits that did land so the user
 * isn't shown them as dirty on retry, but keep the failed ones so they
 * can edit + retry without retyping.
 *
 * `commitResults` keys are env keys (e.g. `THRESHOLD`), but we always know
 * which variable name maps to which env key — we built the writes from
 * `edits` and the mutation derives the env key via `variableEnvKey`. The
 * caller passes a `nameToEnvKey` resolver so this module stays free of
 * the env-key helper (which lives in `@atlas/workspace`).
 *
 * The identity-row commit result (`key: "identity"`) is ignored here.
 */
export function pruneLandedEdits(
  edits: VariableEdits,
  commitResults: ReadonlyArray<{ key: string; status: "ok" | "error" }>,
  nameToEnvKey: (name: string) => string,
): VariableEdits {
  const landed = new Set<string>();
  for (const result of commitResults) {
    if (result.status === "ok" && result.key !== "identity") landed.add(result.key);
  }
  if (landed.size === 0) return edits;
  const next: VariableEdits = {};
  for (const [name, edit] of Object.entries(edits)) {
    if (!landed.has(nameToEnvKey(name))) next[name] = edit;
  }
  return next;
}

/**
 * Render the per-key summary that goes into a toast description when a
 * partial-failure response carries `commitResults`. Identity is not a
 * variable so it's reported separately.
 */
export function summarizeCommitResults(
  commitResults: ReadonlyArray<{ key: string; status: "ok" | "error"; error?: string }>,
): string {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const result of commitResults) {
    if (result.status === "ok") ok.push(result.key);
    else failed.push(result.key);
  }
  const parts: string[] = [];
  if (ok.length > 0) parts.push(`Saved: ${ok.join(", ")}`);
  if (failed.length > 0) parts.push(`Failed: ${failed.join(", ")}`);
  return parts.join(" — ");
}
