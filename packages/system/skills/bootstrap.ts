/**
 * System-skill bootstrap.
 *
 * At daemon start, walks `packages/system/skills/<name>/` for every
 * directory that contains a `SKILL.md` and publishes it under
 * `@atlas/<name>` via `SkillStorage.publish()` — directly, with no
 * HTTP round-trip, so we don't have to fake a user session.
 *
 * The loader is idempotent: it computes a canonical `source-hash`
 * (`computeSkillHash`) and only republishes when the stored skill's
 * frontmatter hash differs from the bundled one. That keeps the
 * DB free of version churn across daemon restarts.
 *
 * HTTP write routes reject non-`SYSTEM_USER_ID` callers targeting the
 * `atlas` namespace — see `apps/atlasd/routes/skills.ts`.
 *
 * @module
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@atlas/logger";
import { computeSkillHash, packSkillArchive, parseSkillMd, SkillStorage } from "@atlas/skills";

const logger = createLogger({ name: "system-skill-bootstrap" });

/**
 * Sentinel user id stamped on the `createdBy` column for every bundled
 * skill. The HTTP write routes use this to enforce that the `atlas`
 * namespace stays immutable for interactive callers.
 */
export const SYSTEM_USER_ID = "system" as const;

/**
 * Namespace every bundled skill lives under. User-facing surfaces
 * (skill picker, Context tab, chat) should never refer to "atlas" —
 * the product is "Friday", "atlas" is the internal monorepo name.
 */
export const SYSTEM_SKILL_NAMESPACE = "friday" as const;

const __dirname = dirname(fileURLToPath(import.meta.url));

async function findSkillDirs(root: string): Promise<string[]> {
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = join(root, entry.name);
    try {
      await stat(join(candidate, "SKILL.md"));
      dirs.push(candidate);
    } catch {
      // no SKILL.md — skip
    }
  }
  return dirs;
}

/**
 * Provision every bundled skill in `packages/system/skills/`. Safe to
 * call repeatedly — republishes only on content-hash mismatch.
 */
export async function ensureSystemSkills(): Promise<void> {
  const root = __dirname;
  const dirs = await findSkillDirs(root);
  if (dirs.length === 0) {
    logger.debug("no bundled system skills found", { root });
    return;
  }

  for (const dir of dirs) {
    try {
      await publishOne(dir);
    } catch (err) {
      logger.error("failed to bootstrap system skill", {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function publishOne(dir: string): Promise<void> {
  const skillMdPath = join(dir, "SKILL.md");
  const content = await readFile(skillMdPath, "utf-8");
  const parsed = parseSkillMd(content);
  if (!parsed.ok) {
    logger.error("failed to parse bundled SKILL.md", { dir, error: parsed.error });
    return;
  }
  const { frontmatter, instructions } = parsed.data;

  const name =
    typeof frontmatter.name === "string" && frontmatter.name.length > 0
      ? frontmatter.name
      : (dir.split("/").pop() ?? "unnamed");

  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

  const sourceHash = await computeSkillHash(dir);

  // Shortcut: if the stored version already has this hash, don't touch.
  const existing = await SkillStorage.get(SYSTEM_SKILL_NAMESPACE, name);
  if (existing.ok && existing.data) {
    const storedHash = existing.data.frontmatter["source-hash"];
    if (typeof storedHash === "string" && storedHash === sourceHash) {
      logger.debug("bundled skill up to date", { name, hash: sourceHash.slice(0, 12) });
      return;
    }
  }

  // Pack archive if the directory has anything besides SKILL.md.
  const hasBundle = await hasSupportFiles(dir);
  const archive = hasBundle ? new Uint8Array(await packSkillArchive(dir)) : undefined;

  const result = await SkillStorage.publish(SYSTEM_SKILL_NAMESPACE, name, SYSTEM_USER_ID, {
    description,
    instructions,
    frontmatter: { ...frontmatter, "source-hash": sourceHash },
    archive,
  });

  if (!result.ok) {
    logger.error("publish failed", { name, error: result.error });
    return;
  }
  logger.info("bootstrapped system skill", {
    name: `@${SYSTEM_SKILL_NAMESPACE}/${name}`,
    version: result.data.version,
    hash: sourceHash.slice(0, 12),
  });
}

async function hasSupportFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue;
    if (entry.isFile() || entry.isDirectory()) return true;
  }
  return false;
}
