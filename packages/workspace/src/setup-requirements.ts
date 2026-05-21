/**
 * Live derivation of a workspace's setup state.
 *
 * `requires_setup` is computed per request from `(parsedConfig, envSnapshot,
 * linkCredentials)`. There is no stored flag — see Decision 3 in
 * docs/plans/2026-05-15-workspace-setup-design.md.
 *
 * A workspace needs setup if any declared variable is unfilled OR any
 * `from: link` credential reference is unresolved. "Filled" is defined by the
 * declared schema; "resolved" follows the rules in Decision 5 and the
 * Credential glossary entry.
 */

import {
  type VariableDeclaration,
  VariableSchemaSchema,
  type WorkspaceConfig,
} from "@atlas/config";
import { extractCredentials } from "@atlas/config/mutations";
import { z } from "zod";
import { variableEnvKey } from "./variable-interpolation.ts";

/**
 * A single unfilled blank surfaced inside a Workspace Setup form.
 *
 * Discriminated on `kind` — variables and credentials are two distinct
 * mutation paths (env write vs `updateCredential`) and the form renders them
 * with different field types.
 *
 * `credential` deliberately omits the per-provider credentials list. The
 * form's credential picker fetches it via its own TanStack Query so OAuth
 * popup completion refetches cleanly without lifting state.
 */
export type SetupRequirement =
  | {
      kind: "variable";
      name: string;
      display_name?: string;
      description?: string;
      schema: VariableDeclaration["schema"];
    }
  | {
      kind: "credential";
      provider: string;
      path: string;
      key: string;
      reason: "no_default" | "stale_id";
    };

/**
 * Caller-provided snapshot of Link credential state for one workspace's refs.
 *
 * The helper is pure — the caller fetches this via Link client calls (e.g.
 * `resolveCredentialsByProvider` + a per-id existence check) and hands the
 * snapshot in. Three orthogonal fields:
 *
 * - `defaultByProvider`: per-provider default credential id, or `null` when
 *   the provider has credentials but none is marked default, or `undefined`
 *   when the provider has no credentials at all. The helper distinguishes
 *   "default unset" (requirement) from "errored" (see `providerErrors`).
 * - `resolvedIds`: set of pinned credential ids that currently resolve
 *   against Link. Pinned ids not in this set are stale.
 * - `providerErrors`: set of providers whose default lookup failed
 *   transiently. Decision 3 / AC #5: a transient Link hiccup must not flip
 *   `requires_setup` true — treat the provider as "previously-resolved still
 *   resolved" for the duration of this derivation.
 */
export interface LinkCredentialState {
  defaultByProvider: Record<string, string | null | undefined>;
  resolvedIds: Set<string>;
  providerErrors: Set<string>;
}

/**
 * Thrown when a credential reference carries a pinned id that does not
 * resolve AND the caller is in the import code path
 * (`options.allowStaleIdRecovery === false`). An imported bundle that came
 * with a credential id the user has never owned is a hard creation error —
 * the user has no way to "reconnect" a credential they never had.
 */
export class StaleCredentialIdAtImportError extends Error {
  readonly credentialId: string;
  readonly provider: string | undefined;
  readonly path: string;
  constructor(args: { credentialId: string; provider?: string; path: string }) {
    super(
      `Imported workspace references credential '${args.credentialId}' (provider: ${
        args.provider ?? "<unknown>"
      }) which does not exist in Link.`,
    );
    this.name = "StaleCredentialIdAtImportError";
    this.credentialId = args.credentialId;
    this.provider = args.provider;
    this.path = args.path;
  }
}

export interface ResolveSetupRequirementsOptions {
  /**
   * When `true`, an unresolved pinned credential id becomes a recoverable
   * setup requirement (Decision 5 — user disconnected a credential
   * post-import). When `false` (import code path), the same condition throws
   * `StaleCredentialIdAtImportError`.
   */
  allowStaleIdRecovery: boolean;
}

export interface SetupRequirementsResult {
  requires_setup: boolean;
  setup_requirements: SetupRequirement[];
}

/**
 * Live-derives the workspace's setup state from parsed config + env overlay +
 * Link credential snapshot.
 *
 * Pure function. Throws `StaleCredentialIdAtImportError` only when
 * `options.allowStaleIdRecovery === false` and a pinned id is stale.
 */
export function resolveWorkspaceSetupRequirements(
  parsedConfig: WorkspaceConfig,
  envSnapshot: Record<string, string>,
  linkCredentials: LinkCredentialState,
  options: ResolveSetupRequirementsOptions,
): SetupRequirementsResult {
  const setup_requirements: SetupRequirement[] = [];

  const declarations = parsedConfig.variables ?? {};
  for (const [name, decl] of Object.entries(declarations)) {
    if (!isVariableFilled(decl, envSnapshot[variableEnvKey(name)])) {
      const requirement: SetupRequirement = { kind: "variable", name, schema: decl.schema };
      if (decl.display_name !== undefined) requirement.display_name = decl.display_name;
      if (decl.description !== undefined) requirement.description = decl.description;
      setup_requirements.push(requirement);
    }
  }

  for (const usage of extractCredentials(parsedConfig)) {
    if (usage.credentialId) {
      if (linkCredentials.resolvedIds.has(usage.credentialId)) continue;
      if (!options.allowStaleIdRecovery) {
        throw new StaleCredentialIdAtImportError({
          credentialId: usage.credentialId,
          provider: usage.provider,
          path: usage.path,
        });
      }
      if (!usage.provider) continue;
      setup_requirements.push({
        kind: "credential",
        provider: usage.provider,
        path: usage.path,
        key: usage.key,
        reason: "stale_id",
      });
      continue;
    }

    if (!usage.provider) continue;

    if (linkCredentials.providerErrors.has(usage.provider)) continue;

    const defaultId = linkCredentials.defaultByProvider[usage.provider];
    if (typeof defaultId === "string" && defaultId.length > 0) continue;

    setup_requirements.push({
      kind: "credential",
      provider: usage.provider,
      path: usage.path,
      key: usage.key,
      reason: "no_default",
    });
  }

  return { requires_setup: setup_requirements.length > 0, setup_requirements };
}

function isVariableFilled(decl: VariableDeclaration, raw: string | undefined): boolean {
  const zodSchema = z.fromJSONSchema(VariableSchemaSchema.parse(decl.schema));
  if (raw !== undefined) {
    const coerced = coerceFromString(decl.schema.type, raw);
    if (coerced !== undefined && zodSchema.safeParse(coerced).success) return true;
  }
  const fallback = decl.schema.default;
  if (fallback === undefined) return false;
  return zodSchema.safeParse(fallback).success;
}

function coerceFromString(
  type: VariableDeclaration["schema"]["type"],
  raw: string,
): unknown | undefined {
  switch (type) {
    case "string":
      return raw;
    case "boolean": {
      if (raw === "true") return true;
      if (raw === "false") return false;
      return undefined;
    }
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
