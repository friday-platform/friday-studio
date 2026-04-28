import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type Issue,
  JobSpecificationSchema,
  type Registry,
  type ValidationReport,
  validateWorkspace,
  WorkspaceAgentConfigSchema,
  type WorkspaceConfig,
  WorkspaceConfigSchema,
  WorkspaceSignalConfigSchema,
} from "@atlas/config";
import {
  type ApplyMutationOptions,
  applyMutation,
  type MutationResult,
} from "@atlas/config/mutations";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";

const logger = createLogger({ component: "draft-helpers" });

export const DRAFT_FILE_NAME = "workspace.yml.draft" as const;
export const LIVE_FILE_NAME = "workspace.yml" as const;

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };

export type DraftItemKind = "agent" | "signal" | "job";

export interface FieldDiff {
  [field: string]: { from?: unknown; to?: unknown } | { added?: unknown[]; removed?: unknown[] };
}

export interface DraftItemResult {
  ok: boolean;
  diff: FieldDiff;
  structuralIssues: Issue[] | null;
}

export type PublishDraftResult =
  | { ok: true; value: { livePath: string } }
  | { ok: false; error: string; report?: ValidationReport };

export type RemoveLiveItemResult =
  | { ok: true; livePath: string }
  | { ok: false; reason: "error"; error: string }
  | { ok: false; reason: "referenced"; dependents: string[] };

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the live config path (workspace.yml or eph_workspace.yml).
 */
export async function resolveLiveConfigPath(workspacePath: string): Promise<string> {
  const persistent = join(workspacePath, LIVE_FILE_NAME);
  const ephemeral = join(workspacePath, "eph_workspace.yml");
  if (await fileExists(persistent)) return persistent;
  if (await fileExists(ephemeral)) return ephemeral;
  throw new Error(`No live config found in ${workspacePath}`);
}

function draftPath(workspacePath: string): string {
  return join(workspacePath, DRAFT_FILE_NAME);
}

/**
 * Begin a draft by copying the live workspace.yml to workspace.yml.draft.
 * Idempotent: if a draft already exists, returns success without overwriting.
 */
export async function beginDraft(
  workspacePath: string,
): Promise<DraftResult<{ draftPath: string }>> {
  const livePath = await resolveLiveConfigPath(workspacePath);
  const draftFilePath = draftPath(workspacePath);

  if (await fileExists(draftFilePath)) {
    logger.debug("Draft already exists, returning idempotent success", { workspacePath });
    return { ok: true, value: { draftPath: draftFilePath } };
  }

  try {
    const content = await readFile(livePath, "utf-8");
    await writeFile(draftFilePath, content, "utf-8");
    logger.info("Draft created", { workspacePath, livePath, draftPath: draftFilePath });
    return { ok: true, value: { draftPath: draftFilePath } };
  } catch (error) {
    const message = stringifyError(error);
    logger.error("Failed to begin draft", { workspacePath, error: message });
    return { ok: false, error: `Failed to begin draft: ${message}` };
  }
}

/**
 * Read the current draft file as parsed YAML.
 */
export async function readDraft(workspacePath: string): Promise<DraftResult<WorkspaceConfig>> {
  const draftFilePath = draftPath(workspacePath);

  if (!(await fileExists(draftFilePath))) {
    return { ok: false, error: "No draft exists" };
  }

  try {
    const content = await readFile(draftFilePath, "utf-8");
    const parsed: unknown = parseYaml(content);
    const validation = WorkspaceConfigSchema.safeParse(parsed);
    if (!validation.success) {
      return { ok: false, error: `Draft validation failed: ${validation.error.message}` };
    }
    return { ok: true, value: validation.data };
  } catch (error) {
    const message = stringifyError(error);
    return { ok: false, error: `Failed to read draft: ${message}` };
  }
}

/**
 * Read the current live config file as parsed YAML.
 */
export async function readLiveConfig(workspacePath: string): Promise<DraftResult<WorkspaceConfig>> {
  try {
    const livePath = await resolveLiveConfigPath(workspacePath);
    const content = await readFile(livePath, "utf-8");
    const parsed: unknown = parseYaml(content);
    const validation = WorkspaceConfigSchema.safeParse(parsed);
    if (!validation.success) {
      return { ok: false, error: `Live config validation failed: ${validation.error.message}` };
    }
    return { ok: true, value: validation.data };
  } catch (error) {
    const message = stringifyError(error);
    return { ok: false, error: `Failed to read live config: ${message}` };
  }
}

/**
 * Write a workspace config to the live file.
 */
export async function writeLiveConfig(
  workspacePath: string,
  config: WorkspaceConfig,
): Promise<DraftResult<void>> {
  try {
    const livePath = await resolveLiveConfigPath(workspacePath);
    const yaml = stringifyYaml(config);
    await writeFile(livePath, yaml, "utf-8");
    return { ok: true, value: undefined };
  } catch (error) {
    const message = stringifyError(error);
    logger.error("Failed to write live config", { workspacePath, error: message });
    return { ok: false, error: `Failed to write live config: ${message}` };
  }
}

/**
 * Get the config that should be used for editing: draft if it exists, live otherwise.
 */
export async function getEditableConfig(
  workspacePath: string,
): Promise<DraftResult<WorkspaceConfig>> {
  const draftResult = await readDraft(workspacePath);
  if (draftResult.ok) return draftResult;
  return readLiveConfig(workspacePath);
}

/**
 * Apply a mutation to draft if it exists, or to live config via applyMutation.
 * Returns the mutation result and whether the write went to draft.
 */
export async function applyDraftAwareMutation(
  workspacePath: string,
  mutationFn: (config: WorkspaceConfig) => MutationResult<WorkspaceConfig>,
  options: ApplyMutationOptions = {},
): Promise<{ result: MutationResult<WorkspaceConfig>; wroteToDraft: boolean }> {
  const draftResult = await readDraft(workspacePath);
  if (draftResult.ok) {
    const mutationResult = mutationFn(draftResult.value);
    if (!mutationResult.ok) {
      return { result: mutationResult, wroteToDraft: true };
    }

    const validation = WorkspaceConfigSchema.safeParse(mutationResult.value);
    if (!validation.success) {
      return {
        result: {
          ok: false,
          error: {
            type: "validation",
            message: "Mutated config failed validation",
            issues: validation.error.issues,
          },
        },
        wroteToDraft: true,
      };
    }

    const writeResult = await writeDraft(workspacePath, validation.data);
    if (!writeResult.ok) {
      return {
        result: { ok: false, error: { type: "write", message: writeResult.error } },
        wroteToDraft: true,
      };
    }

    return { result: { ok: true, value: validation.data }, wroteToDraft: true };
  }

  const result = await applyMutation(workspacePath, mutationFn, options);
  return { result, wroteToDraft: false };
}

/**
 * Publish the draft by validating it and then atomically renaming it over the live file.
 */
export async function publishDraft(
  workspacePath: string,
  registry?: Registry,
): Promise<PublishDraftResult> {
  const draftFilePath = draftPath(workspacePath);

  if (!(await fileExists(draftFilePath))) {
    return { ok: false, error: "No draft to publish" };
  }

  // Validate draft content before publishing
  const readResult = await readDraft(workspacePath);
  if (!readResult.ok) {
    return { ok: false, error: readResult.error };
  }
  const report = validateWorkspace(readResult.value, registry);
  if (report.status === "error") {
    return {
      ok: false,
      error: `Validation failed: ${report.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
      report,
    };
  }

  try {
    const livePath = await resolveLiveConfigPath(workspacePath);
    const backupPath = `${livePath}.backup-${Date.now()}`;

    // Backup existing live file
    try {
      const existingContent = await readFile(livePath, "utf-8");
      await writeFile(backupPath, existingContent, "utf-8");
    } catch {
      // If live file doesn't exist, no backup needed
    }

    // Atomic rename: draft → live
    await rename(draftFilePath, livePath);
    logger.info("Draft published", { workspacePath, livePath });
    return { ok: true, value: { livePath } };
  } catch (error) {
    const message = stringifyError(error);
    logger.error("Failed to publish draft", { workspacePath, error: message });
    return { ok: false, error: `Failed to publish draft: ${message}` };
  }
}

/**
 * Discard the draft file without publishing.
 */
export async function discardDraft(workspacePath: string): Promise<DraftResult<void>> {
  const draftFilePath = draftPath(workspacePath);

  if (!(await fileExists(draftFilePath))) {
    return { ok: false, error: "No draft to discard" };
  }

  try {
    await unlink(draftFilePath);
    logger.info("Draft discarded", { workspacePath });
    return { ok: true, value: undefined };
  } catch (error) {
    const message = stringifyError(error);
    logger.error("Failed to discard draft", { workspacePath, error: message });
    return { ok: false, error: `Failed to discard draft: ${message}` };
  }
}

// ==============================================================================
// DIFF HELPERS
// ==============================================================================

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Compute a flat field-level diff between two objects.
 * Nested keys use dot notation (e.g. "config.provider").
 * Array fields show added/removed elements.
 */
function computeFlatDiff(
  oldObj: Record<string, unknown>,
  newObj: Record<string, unknown>,
  prefix = "",
): FieldDiff {
  const diff: FieldDiff = {};
  const allKeys = new Set([...Object.keys(oldObj), ...Object.keys(newObj)]);

  for (const key of allKeys) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const hasOld = Object.hasOwn(oldObj, key);
    const hasNew = Object.hasOwn(newObj, key);
    const oldVal = oldObj[key];
    const newVal = newObj[key];

    if (!hasOld && hasNew) {
      diff[fullKey] = { to: newVal };
    } else if (hasOld && !hasNew) {
      diff[fullKey] = { from: oldVal };
    } else if (!valuesEqual(oldVal, newVal)) {
      if (Array.isArray(oldVal) && Array.isArray(newVal)) {
        const removed = oldVal.filter((x) => !newVal.some((y) => valuesEqual(x, y)));
        const added = newVal.filter((x) => !oldVal.some((y) => valuesEqual(x, y)));
        if (removed.length > 0 || added.length > 0) {
          diff[fullKey] = { added, removed };
        }
      } else if (isPlainObject(oldVal) && isPlainObject(newVal)) {
        const nested = computeFlatDiff(oldVal, newVal, fullKey);
        Object.assign(diff, nested);
      } else {
        diff[fullKey] = { from: oldVal, to: newVal };
      }
    }
  }

  return diff;
}

// ==============================================================================
// DRAFT ITEM MUTATIONS
// ==============================================================================

function entitySchemaForKind(kind: DraftItemKind) {
  switch (kind) {
    case "agent":
      return WorkspaceAgentConfigSchema;
    case "signal":
      return WorkspaceSignalConfigSchema;
    case "job":
      return JobSpecificationSchema;
  }
}

function configKeyForKind(kind: DraftItemKind): keyof WorkspaceConfig {
  switch (kind) {
    case "agent":
      return "agents";
    case "signal":
      return "signals";
    case "job":
      return "jobs";
  }
}

/**
 * Write a workspace config to the draft file.
 */
export async function writeDraft(
  workspacePath: string,
  config: WorkspaceConfig,
): Promise<DraftResult<void>> {
  const draftFilePath = draftPath(workspacePath);
  try {
    const yaml = stringifyYaml(config);
    await writeFile(draftFilePath, yaml, "utf-8");
    return { ok: true, value: undefined };
  } catch (error) {
    const message = stringifyError(error);
    logger.error("Failed to write draft", { workspacePath, error: message });
    return { ok: false, error: `Failed to write draft: ${message}` };
  }
}

/**
 * Upsert an entity (agent/signal/job) into the draft config.
 * Validates the entity config against the appropriate schema before writing.
 * Returns field-level diff and any structural issues from validateWorkspace.
 */
export async function upsertDraftItem(
  workspacePath: string,
  kind: DraftItemKind,
  id: string,
  config: unknown,
): Promise<DraftResult<DraftItemResult>> {
  const readResult = await readDraft(workspacePath);
  if (!readResult.ok) {
    return { ok: false, error: readResult.error };
  }

  const schema = entitySchemaForKind(kind);
  const parseResult = schema.safeParse(config);
  if (!parseResult.success) {
    return { ok: false, error: `Invalid ${kind} config: ${parseResult.error.message}` };
  }

  const key = configKeyForKind(kind);
  const oldCollection = (readResult.value[key] as Record<string, unknown> | undefined) ?? {};
  const oldValue = (oldCollection[id] as Record<string, unknown> | undefined) ?? {};

  const updated = { ...readResult.value, [key]: { ...oldCollection, [id]: parseResult.data } };

  const validation = WorkspaceConfigSchema.safeParse(updated);
  if (!validation.success) {
    return {
      ok: false,
      error: `Draft validation failed after upsert: ${validation.error.message}`,
    };
  }

  const writeResult = await writeDraft(workspacePath, validation.data);
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error };
  }

  const report = validateWorkspace(validation.data);
  const structuralIssues = report.status === "error" ? report.errors : null;

  const diff = computeFlatDiff(oldValue, parseResult.data as Record<string, unknown>);

  return { ok: true, value: { ok: true, diff, structuralIssues } };
}

/**
 * Upsert an entity (agent/signal/job) into the live config.
 * Validates the entity config and the full workspace. If structural errors
 * exist, the write is refused and issues are returned. Otherwise writes
 * to the live workspace.yml and returns the diff.
 */
export async function upsertLiveItem(
  workspacePath: string,
  kind: DraftItemKind,
  id: string,
  config: unknown,
): Promise<DraftResult<DraftItemResult>> {
  const readResult = await readLiveConfig(workspacePath);
  if (!readResult.ok) {
    return { ok: false, error: readResult.error };
  }

  const schema = entitySchemaForKind(kind);
  const parseResult = schema.safeParse(config);
  if (!parseResult.success) {
    return { ok: false, error: `Invalid ${kind} config: ${parseResult.error.message}` };
  }

  const key = configKeyForKind(kind);
  const oldCollection = (readResult.value[key] as Record<string, unknown> | undefined) ?? {};
  const oldValue = (oldCollection[id] as Record<string, unknown> | undefined) ?? {};

  const updated = { ...readResult.value, [key]: { ...oldCollection, [id]: parseResult.data } };

  const validation = WorkspaceConfigSchema.safeParse(updated);
  if (!validation.success) {
    return {
      ok: false,
      error: `Live config validation failed after upsert: ${validation.error.message}`,
    };
  }

  const report = validateWorkspace(validation.data);
  if (report.status === "error") {
    const diff = computeFlatDiff(oldValue, parseResult.data as Record<string, unknown>);
    return { ok: true, value: { ok: false, diff, structuralIssues: report.errors } };
  }

  const writeResult = await writeLiveConfig(workspacePath, validation.data);
  if (!writeResult.ok) {
    return { ok: false, error: writeResult.error };
  }

  const diff = computeFlatDiff(oldValue, parseResult.data as Record<string, unknown>);

  return { ok: true, value: { ok: true, diff, structuralIssues: null } };
}

/**
 * Delete an entity (agent/signal/job) from the draft config.
 * Draft mode is permissive — does NOT check for broken references.
 * Returns the old entity value and any structural issues in the remaining draft.
 */
export async function deleteDraftItem(
  workspacePath: string,
  kind: DraftItemKind,
  id: string,
): Promise<DraftResult<{ oldValue: unknown; report: ValidationReport }>> {
  const readResult = await readDraft(workspacePath);
  if (!readResult.ok) {
    return readResult;
  }

  const key = configKeyForKind(kind);
  const collection = (readResult.value[key] as Record<string, unknown> | undefined) ?? {};
  if (!(id in collection)) {
    return { ok: false, error: `${kind} '${id}' not found in draft` };
  }

  const oldValue = collection[id];
  const updatedCollection = { ...collection };
  delete updatedCollection[id];

  const updated: WorkspaceConfig = { ...readResult.value };
  if (Object.keys(updatedCollection).length === 0) {
    delete (updated as Record<string, unknown>)[key];
  } else {
    (updated as Record<string, unknown>)[key] = updatedCollection;
  }

  const validation = WorkspaceConfigSchema.safeParse(updated);
  if (!validation.success) {
    return {
      ok: false,
      error: `Draft validation failed after delete: ${validation.error.message}`,
    };
  }

  await writeDraft(workspacePath, validation.data);
  const report = validateWorkspace(validation.data);
  return { ok: true, value: { oldValue, report } };
}

// ==============================================================================
// REFERENCE HELPERS
// ==============================================================================

const FSMStateSchema = z.object({ entry: z.array(z.unknown()).optional() });

const FSMAgentActionSchema = z.object({ type: z.literal("agent"), agentId: z.string() });

function findDependents(config: WorkspaceConfig, kind: DraftItemKind, id: string): string[] {
  const dependents: string[] = [];

  if (kind === "agent") {
    for (const [jobId, rawJob] of Object.entries(config.jobs ?? {})) {
      const jobResult = JobSpecificationSchema.safeParse(rawJob);
      if (!jobResult.success) continue;
      const job = jobResult.data;

      // Check FSM entries
      if (job.fsm?.states) {
        for (const rawState of Object.values(job.fsm.states)) {
          const stateResult = FSMStateSchema.safeParse(rawState);
          if (!stateResult.success) continue;
          for (const action of stateResult.data.entry ?? []) {
            const actionResult = FSMAgentActionSchema.safeParse(action);
            if (actionResult.success && actionResult.data.agentId === id) {
              if (!dependents.includes(jobId)) dependents.push(jobId);
              break;
            }
          }
          if (dependents.includes(jobId)) break;
        }
      }

      // Check execution.agents
      if (job.execution?.agents) {
        for (const spec of job.execution.agents) {
          let agentId: string | undefined;
          if (typeof spec === "string") {
            agentId = spec;
          } else if (
            typeof spec === "object" &&
            spec !== null &&
            "id" in spec &&
            typeof spec.id === "string"
          ) {
            agentId = spec.id;
          }
          if (agentId === id && !dependents.includes(jobId)) {
            dependents.push(jobId);
          }
        }
      }
    }
  }

  if (kind === "signal") {
    for (const [jobId, rawJob] of Object.entries(config.jobs ?? {})) {
      const jobResult = JobSpecificationSchema.safeParse(rawJob);
      if (!jobResult.success) continue;
      const job = jobResult.data;

      for (const trigger of job.triggers ?? []) {
        if (trigger.signal === id && !dependents.includes(jobId)) {
          dependents.push(jobId);
        }
      }
    }
  }

  return dependents;
}

// ==============================================================================
// LIVE ITEM REMOVAL
// ==============================================================================

/**
 * Remove an entity (agent/signal/job) from the live config.
 * Refuses the operation if the entity is referenced by other items.
 */
export async function removeLiveItem(
  workspacePath: string,
  kind: DraftItemKind,
  id: string,
): Promise<RemoveLiveItemResult> {
  const readResult = await readLiveConfig(workspacePath);
  if (!readResult.ok) {
    return { ok: false, reason: "error", error: readResult.error };
  }

  const key = configKeyForKind(kind);
  const collectionRaw = readResult.value[key];
  const collectionResult = z.record(z.string(), z.unknown()).safeParse(collectionRaw);
  const collection = collectionResult.success ? collectionResult.data : {};
  if (!(id in collection)) {
    return { ok: false, reason: "error", error: `${kind} '${id}' not found in live config` };
  }

  const dependents = findDependents(readResult.value, kind, id);
  if (dependents.length > 0) {
    return { ok: false, reason: "referenced", dependents };
  }

  const updatedCollection = { ...collection };
  delete updatedCollection[id];

  const draft: Record<string, unknown> = { ...readResult.value };
  if (Object.keys(updatedCollection).length === 0) {
    delete draft[key];
  } else {
    draft[key] = updatedCollection;
  }

  const validation = WorkspaceConfigSchema.safeParse(draft);
  if (!validation.success) {
    return {
      ok: false,
      reason: "error",
      error: `Live config validation failed after delete: ${validation.error.message}`,
    };
  }

  const writeResult = await writeLiveConfig(workspacePath, validation.data);
  if (!writeResult.ok) {
    return { ok: false, reason: "error", error: writeResult.error };
  }

  return { ok: true, livePath: await resolveLiveConfigPath(workspacePath) };
}

/**
 * Validate the current draft config and return a report.
 */
export async function validateDraft(
  workspacePath: string,
  registry?: Registry,
): Promise<DraftResult<ValidationReport>> {
  const readResult = await readDraft(workspacePath);
  if (!readResult.ok) {
    return readResult;
  }
  return { ok: true, value: validateWorkspace(readResult.value, registry) };
}
