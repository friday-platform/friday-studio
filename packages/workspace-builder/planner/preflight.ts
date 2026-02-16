/**
 * Environment readiness / preflight checks.
 *
 * Extracted from build-blueprint.ts — pure sync logic, no pipeline coupling.
 */

import { env } from "node:process";
import type { CredentialBinding } from "@atlas/schemas/workspace";
import type { ConfigRequirement, ConfigRequirementField } from "./classify-agents.ts";

type CheckStatus = "present" | "missing" | "skipped" | "resolved";

/** Individual config field check result. */
export type FieldCheck = {
  key: string;
  description: string;
  source: "env" | "link";
  provider?: string;
  status: CheckStatus;
  credentialId?: string;
};

/** Readiness check for one agent's integration. */
export type ReadinessCheck = {
  agentId: string;
  agentName: string;
  integration: ConfigRequirement["integration"];
  checks: FieldCheck[];
};

/** Overall readiness result. */
export type ReadinessResult = {
  ready: boolean;
  checks: ReadinessCheck[];
  summary: { present: number; missing: number; skipped: number; resolved: number };
};

/**
 * Check environment readiness for all config requirements.
 */
export function checkEnvironmentReadiness(
  configRequirements: ConfigRequirement[],
  credentialBindings?: CredentialBinding[],
): ReadinessResult {
  const checks: ReadinessCheck[] = [];
  let present = 0;
  let missing = 0;
  let skipped = 0;
  let resolved = 0;

  for (const req of configRequirements) {
    const fieldChecks: FieldCheck[] = [];
    const targetId = req.integration.type === "mcp" ? req.integration.serverId : req.agentId;

    for (const field of req.requiredConfig) {
      const result = checkField(field, targetId, credentialBindings);
      fieldChecks.push({
        key: field.key,
        description: field.description,
        source: field.source,
        provider: field.provider,
        status: result.status,
        credentialId: result.credentialId,
      });

      if (result.status === "present") present++;
      else if (result.status === "missing") missing++;
      else if (result.status === "resolved") resolved++;
      else skipped++;
    }

    checks.push({
      agentId: req.agentId,
      agentName: req.agentName,
      integration: req.integration,
      checks: fieldChecks,
    });
  }

  return { ready: missing === 0, checks, summary: { present, missing, skipped, resolved } };
}

function checkField(
  field: ConfigRequirementField,
  targetId: string,
  bindings?: CredentialBinding[],
): { status: CheckStatus; credentialId?: string } {
  if (field.source === "link") {
    if (!bindings) return { status: "skipped" };
    const binding = bindings.find((b) => b.targetId === targetId && b.field === field.key);
    if (binding) return { status: "resolved", credentialId: binding.credentialId };
    return { status: "missing" };
  }
  return { status: env[field.key] !== undefined ? "present" : "missing" };
}

/**
 * Format a readiness result into human-readable output.
 */
export function formatReadinessReport(result: ReadinessResult): string {
  if (result.checks.length === 0) return "";

  const lines: string[] = ["Environment readiness check:"];

  for (const agentCheck of result.checks) {
    const hasMissing = agentCheck.checks.some((c) => c.status === "missing");
    const agentSymbol = hasMissing ? "\u2717" : "\u2713";
    const integrationLabel =
      agentCheck.integration.type === "bundled"
        ? `bundled: ${agentCheck.integration.bundledId}`
        : `mcp: ${agentCheck.integration.serverId}`;

    lines.push("");
    lines.push(`  ${agentSymbol} ${agentCheck.agentName} (${integrationLabel})`);

    for (const check of agentCheck.checks) {
      if (check.status === "present") {
        lines.push(`    \u2713 ${check.key} \u2014 present`);
      } else if (check.status === "resolved") {
        const providerSuffix = check.provider ? ` [link: ${check.provider}]` : "";
        lines.push(
          `    \u2713 ${check.key} \u2014 resolved (${check.credentialId})${providerSuffix}`,
        );
      } else if (check.status === "missing") {
        const providerSuffix = check.provider ? ` [link: ${check.provider}]` : "";
        lines.push(`    \u2717 ${check.key} \u2014 MISSING${providerSuffix}`);
      } else {
        const providerSuffix = check.provider ? ` (link: ${check.provider})` : "";
        lines.push(`    \u25CB ${check.key} \u2014 skipped${providerSuffix}`);
      }
    }
  }

  const {
    present,
    missing: missingCount,
    skipped: skippedCount,
    resolved: resolvedCount,
  } = result.summary;
  lines.push("");
  const parts = [`${present} present`, `${missingCount} missing`, `${skippedCount} skipped`];
  if (resolvedCount > 0) parts.push(`${resolvedCount} resolved`);
  lines.push(`Summary: ${parts.join(", ")}`);

  return lines.join("\n");
}
