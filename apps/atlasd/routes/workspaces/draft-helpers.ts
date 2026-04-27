import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type WorkspaceConfig, WorkspaceConfigSchema, validateWorkspace } from "@atlas/config";
import { createLogger } from "@atlas/logger";
import { stringifyError } from "@atlas/utils";
import { parse as parseYaml } from "@std/yaml";

const logger = createLogger({ component: "draft-helpers" });

export const DRAFT_FILE_NAME = "workspace.yml.draft" as const;
export const LIVE_FILE_NAME = "workspace.yml" as const;

export type DraftResult<T> = { ok: true; value: T } | { ok: false; error: string };

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
 * Publish the draft by validating it and then atomically renaming it over the live file.
 */
export async function publishDraft(
  workspacePath: string,
): Promise<DraftResult<{ livePath: string }>> {
  const draftFilePath = draftPath(workspacePath);

  if (!(await fileExists(draftFilePath))) {
    return { ok: false, error: "No draft to publish" };
  }

  // Validate draft content before publishing
  const readResult = await readDraft(workspacePath);
  if (!readResult.ok) {
    return readResult;
  }
  const report = validateWorkspace(readResult.value);
  if (report.status === "error") {
    return {
      ok: false,
      error: `Validation failed: ${report.errors.map((e) => `${e.path}: ${e.message}`).join("; ")}`,
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
