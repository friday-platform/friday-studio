/**
 * Validates that a revised WorkspaceBlueprint stays within the allowed
 * improvement scope: only prompt text, step configs, schemas, and prepare
 * mappings may differ. Structural elements (IDs, DAG edges, signal/agent
 * topology) must remain identical.
 *
 * Pure function — no I/O, no side effects.
 */

import type { CredentialBinding, WorkspaceBlueprint } from "./types.ts";

export interface RevisionScopeResult {
  ok: boolean;
  violations: string[];
}

/**
 * Compare two blueprints and ensure the revision only touches tunable fields.
 *
 * Structural (must be identical):
 * - Signal IDs, names, types, payload schemas, configs
 * - Agent IDs, names, bundledIds, mcpServer bindings, configuration
 * - Job IDs, names, trigger signals
 * - Step IDs, agentIds, depends_on edges, executionType, executionRef
 * - Document contract identity (producerStepId, documentId, documentType)
 * - Prepare mapping identity (consumerStepId, documentId, documentType)
 * - Conditional structure (stepId, field, branch conditions/targets)
 * - Credential bindings (all structural fields)
 * - Resource identity (type, slug) and external refs
 *
 * Tunable (may differ):
 * - workspace.purpose, workspace.details
 * - Signal title, description, displayLabel
 * - Agent description, capabilities
 * - Job title
 * - Step description, tools
 * - Document contract schemas
 * - Prepare mapping sources and constants
 * - Resource name, description, schema
 * - Credential binding labels
 */
export function validateRevisionScope(
  original: WorkspaceBlueprint,
  revised: WorkspaceBlueprint,
): RevisionScopeResult {
  const violations: string[] = [];

  // Workspace identity
  if (original.workspace.name !== revised.workspace.name) {
    violations.push(
      `workspace.name changed: "${original.workspace.name}" → "${revised.workspace.name}"`,
    );
  }

  // Signals
  compareById(
    original.signals,
    revised.signals,
    "signal",
    (a, b) => {
      if (a.signalType !== b.signalType) {
        violations.push(
          `signal "${a.id}": signalType changed: "${a.signalType}" → "${b.signalType}"`,
        );
      }
      if (!jsonEqual(a.payloadSchema, b.payloadSchema)) {
        violations.push(`signal "${a.id}": payloadSchema changed`);
      }
      if (!jsonEqual(a.signalConfig, b.signalConfig)) {
        violations.push(`signal "${a.id}": signalConfig changed`);
      }
    },
    violations,
  );

  // Agents
  compareById(
    original.agents,
    revised.agents,
    "agent",
    (a, b) => {
      if (a.bundledId !== b.bundledId) {
        violations.push(`agent "${a.id}": bundledId changed: "${a.bundledId}" → "${b.bundledId}"`);
      }
      if (!jsonEqual(a.configuration, b.configuration)) {
        violations.push(`agent "${a.id}": configuration changed`);
      }
      if (!jsonEqual(sortedServerIds(a), sortedServerIds(b))) {
        violations.push(`agent "${a.id}": mcpServers changed`);
      }
    },
    violations,
  );

  // Jobs
  compareById(
    original.jobs,
    revised.jobs,
    "job",
    (origJob, revJob) => {
      if (origJob.triggerSignalId !== revJob.triggerSignalId) {
        violations.push(
          `job "${origJob.id}": triggerSignalId changed: "${origJob.triggerSignalId}" → "${revJob.triggerSignalId}"`,
        );
      }

      // Steps within each job
      compareById(
        origJob.steps,
        revJob.steps,
        `job "${origJob.id}" step`,
        (a, b) => {
          if (a.agentId !== b.agentId) {
            violations.push(
              `job "${origJob.id}" step "${a.id}": agentId changed: "${a.agentId}" → "${b.agentId}"`,
            );
          }
          if (!jsonEqual(sorted(a.depends_on), sorted(b.depends_on))) {
            violations.push(`job "${origJob.id}" step "${a.id}": depends_on changed`);
          }
          if (a.executionType !== b.executionType) {
            violations.push(
              `job "${origJob.id}" step "${a.id}": executionType changed: "${a.executionType}" → "${b.executionType}"`,
            );
          }
          if (a.executionRef !== b.executionRef) {
            violations.push(
              `job "${origJob.id}" step "${a.id}": executionRef changed: "${a.executionRef}" → "${b.executionRef}"`,
            );
          }
        },
        violations,
      );

      // Document contracts — structural identity only (schema may change)
      compareByCompositeKey(
        origJob.documentContracts,
        revJob.documentContracts,
        (dc) => `${dc.producerStepId}::${dc.documentId}`,
        `job "${origJob.id}" documentContract`,
        (a, b) => {
          if (a.documentType !== b.documentType) {
            violations.push(
              `job "${origJob.id}" documentContract "${a.documentId}": documentType changed`,
            );
          }
        },
        violations,
      );

      // Prepare mappings — structural identity only (sources/constants may change)
      compareByCompositeKey(
        origJob.prepareMappings,
        revJob.prepareMappings,
        (pm) => `${pm.consumerStepId}::${pm.documentId}`,
        `job "${origJob.id}" prepareMapping`,
        (a, b) => {
          if (a.documentType !== b.documentType) {
            violations.push(
              `job "${origJob.id}" prepareMapping "${a.consumerStepId}←${a.documentId}": documentType changed`,
            );
          }
        },
        violations,
      );

      // Conditionals
      const origConditionals = origJob.conditionals ?? [];
      const revConditionals = revJob.conditionals ?? [];
      compareByCompositeKey(
        origConditionals,
        revConditionals,
        (c) => c.stepId,
        `job "${origJob.id}" conditional`,
        (a, b) => {
          if (a.field !== b.field) {
            violations.push(`job "${origJob.id}" conditional "${a.stepId}": field changed`);
          }
          if (!jsonEqual(a.branches, b.branches)) {
            violations.push(`job "${origJob.id}" conditional "${a.stepId}": branches changed`);
          }
        },
        violations,
      );
    },
    violations,
  );

  // Credential bindings
  const origBindings = original.credentialBindings ?? [];
  const revBindings = revised.credentialBindings ?? [];
  compareByCompositeKey(
    origBindings,
    revBindings,
    credentialBindingKey,
    "credentialBinding",
    () => {
      // All structural fields are in the key — nothing else to check
    },
    violations,
  );

  // Resources — structural identity (type + slug)
  const origResources = original.resources ?? [];
  const revResources = revised.resources ?? [];
  compareByCompositeKey(
    origResources,
    revResources,
    (r) => `${r.type}::${r.slug}`,
    "resource",
    (a, b) => {
      if (a.type !== b.type) {
        violations.push(`resource "${a.slug}": type changed`);
      }
      // For external refs, check provider and ref are unchanged
      if (a.type === "external_ref" && b.type === "external_ref") {
        if (a.provider !== b.provider) {
          violations.push(`resource "${a.slug}": provider changed`);
        }
        if (a.ref !== b.ref) {
          violations.push(`resource "${a.slug}": ref changed`);
        }
      }
      // For artifact refs, check artifactId is unchanged
      if (a.type === "artifact_ref" && b.type === "artifact_ref") {
        if (a.artifactId !== b.artifactId) {
          violations.push(`resource "${a.slug}": artifactId changed`);
        }
      }
    },
    violations,
  );

  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sorted(arr: string[]): string[] {
  return [...arr].sort();
}

function sortedServerIds(agent: { mcpServers?: Array<{ serverId: string }> }): string[] {
  return (agent.mcpServers ?? []).map((s) => s.serverId).sort();
}

function credentialBindingKey(cb: CredentialBinding): string {
  return `${cb.targetType}::${cb.targetId}::${cb.field}::${cb.credentialId}::${cb.provider}::${cb.key}`;
}

/**
 * Compare two arrays of items that have an `id` field.
 * Reports additions, removals, and runs `compareFn` on matched pairs.
 */
function compareById<T extends { id: string }>(
  original: T[],
  revised: T[],
  label: string,
  compareFn: (a: T, b: T) => void,
  violations: string[],
): void {
  const origMap = new Map(original.map((item) => [item.id, item]));
  const revMap = new Map(revised.map((item) => [item.id, item]));

  for (const id of origMap.keys()) {
    if (!revMap.has(id)) {
      violations.push(`${label} "${id}" removed`);
    }
  }
  for (const id of revMap.keys()) {
    if (!origMap.has(id)) {
      violations.push(`${label} "${id}" added`);
    }
  }

  for (const [id, origItem] of origMap) {
    const revItem = revMap.get(id);
    if (revItem) {
      compareFn(origItem, revItem);
    }
  }
}

/**
 * Compare two arrays using a composite key function.
 * Reports additions, removals, and runs `compareFn` on matched pairs.
 */
function compareByCompositeKey<T>(
  original: T[],
  revised: T[],
  keyFn: (item: T) => string,
  label: string,
  compareFn: (a: T, b: T) => void,
  violations: string[],
): void {
  const origMap = new Map(original.map((item) => [keyFn(item), item]));
  const revMap = new Map(revised.map((item) => [keyFn(item), item]));

  for (const key of origMap.keys()) {
    if (!revMap.has(key)) {
      violations.push(`${label} "${key}" removed`);
    }
  }
  for (const key of revMap.keys()) {
    if (!origMap.has(key)) {
      violations.push(`${label} "${key}" added`);
    }
  }

  for (const [key, origItem] of origMap) {
    const revItem = revMap.get(key);
    if (revItem) {
      compareFn(origItem, revItem);
    }
  }
}
