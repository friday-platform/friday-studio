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

import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "@atlas/logger";
import { computeSkillHash, packSkillArchive, parseSkillMd, SkillStorage } from "@atlas/skills";
import { SYSTEM_USER_ID } from "@atlas/skills/constants";
import { makeTempDir } from "@atlas/utils/temp.server";

const logger = createLogger({ name: "system-skill-bootstrap" });

/**
 * Sentinel user id stamped on the `createdBy` column for every bundled
 * skill. The HTTP write routes use this to enforce that the `atlas`
 * namespace stays immutable for interactive callers. Re-exported from
 * `@atlas/skills/constants` so existing local imports keep working.
 */
export { SYSTEM_USER_ID };

/**
 * Namespace every bundled skill lives under. User-facing surfaces
 * (skill picker, Context tab, chat) should never refer to "atlas" —
 * the product is "Friday", "atlas" is the internal monorepo name.
 */
export const SYSTEM_SKILL_NAMESPACE = "friday" as const;

const __dirname = dirname(fileURLToPath(import.meta.url));

async function findSkillDirs(root: string): Promise<string[]> {
  let entries: Dirent[];
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
 * call repeatedly — republishes only on content-hash mismatch. After
 * the publish pass, runs {@link tombstoneOrphans} to disable any
 * `@friday/*` skill in the registry that no longer has a source dir
 * on disk (the publish pass is additive — it can't unpublish a skill
 * that was deleted between daemon restarts).
 */
export async function ensureSystemSkills(): Promise<void> {
  const root = __dirname;
  const dirs = await findSkillDirs(root);
  if (dirs.length === 0) {
    logger.debug("no bundled system skills found", { root });
    return;
  }

  const liveNames = new Set<string>();
  for (const dir of dirs) {
    try {
      const name = await publishOne(dir);
      if (name) liveNames.add(name);
    } catch (err) {
      logger.error("failed to bootstrap system skill", {
        dir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await tombstoneOrphans(liveNames);
}

/**
 * Disable any `@friday/*` skill in the registry whose source dir is
 * no longer on disk. The publish pass writes new versions when sources
 * change but never tombstones a skill whose dir was deleted between
 * daemon restarts — so a skill removed in commit X stays in the registry
 * (and stays visible to `resolveVisibleSkills`) on every daemon that
 * bootstrapped it before the deletion. Disabling the orphan rather than
 * hard-deleting preserves version history; downstream readers
 * (`resolveVisibleSkills` and friends) already skip disabled rows.
 */
async function tombstoneOrphans(liveNames: Set<string>): Promise<void> {
  // `includeAll: true` surfaces disabled rows so we can avoid a
  // re-disable churn write on skills already tombstoned.
  const listed = await SkillStorage.list(SYSTEM_SKILL_NAMESPACE, undefined, true);
  if (!listed.ok) {
    logger.warn("orphan-tombstone scan: list failed", { error: listed.error });
    return;
  }
  for (const summary of listed.data) {
    if (summary.name === null) continue;
    if (liveNames.has(summary.name)) continue;
    if (summary.disabled) continue;
    const result = await SkillStorage.setDisabled(summary.skillId, true);
    if (!result.ok) {
      logger.warn("orphan-tombstone setDisabled failed", {
        name: `@${SYSTEM_SKILL_NAMESPACE}/${summary.name}`,
        skillId: summary.skillId,
        error: result.error,
      });
      continue;
    }
    logger.info("tombstoned orphan system skill", {
      name: `@${SYSTEM_SKILL_NAMESPACE}/${summary.name}`,
      skillId: summary.skillId,
    });
  }
}

/**
 * Returns the resolved skill `name` (frontmatter or dir-fallback) on
 * success so the caller can build the live-names set for the
 * tombstone pass. Returns `null` on parse / publish failure — the
 * skill won't be republished AND won't be tombstoned (it stays
 * whatever it was), preserving the previous behavior on transient
 * errors.
 */
async function publishOne(dir: string): Promise<string | null> {
  const skillMdPath = join(dir, "SKILL.md");
  const content = await readFile(skillMdPath, "utf-8");
  const parsed = parseSkillMd(content);
  if (!parsed.ok) {
    logger.error("failed to parse bundled SKILL.md", { dir, error: parsed.error });
    return null;
  }
  const { frontmatter, instructions } = parsed.data;

  const name =
    typeof frontmatter.name === "string" && frontmatter.name.length > 0
      ? frontmatter.name
      : (dir.split("/").pop() ?? "unnamed");

  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";

  const sourceHash = await computeSkillHash(dir);

  // Shortcut: if the stored version already has this hash and is enabled,
  // don't touch. Disabled rows fall through to re-publish even on a hash
  // match: a prior boot may have tombstoned the skill after a failed archive
  // pack (e.g. the VFS fd bug), leaving archive=null in the DB. Re-publishing
  // heals the null archive and re-enables the skill atomically.
  const existing = await SkillStorage.get(SYSTEM_SKILL_NAMESPACE, name);
  if (existing.ok && existing.data) {
    const storedHash = existing.data.frontmatter["source-hash"];
    if (typeof storedHash === "string" && storedHash === sourceHash && !existing.data.disabled) {
      logger.debug("bundled skill up to date", { name, hash: sourceHash.slice(0, 12) });
      return name;
    }
  }

  // Pack archive if the directory has anything besides SKILL.md.
  // `tar.create()` requests OS-level file descriptors from each source
  // file. Inside a Deno-compiled binary the skill dirs live in an
  // embedded virtual filesystem that cannot provide real OS fds, so
  // `create()` throws "Failed to get OS file descriptor from file".
  // Copying to a real temp dir first (readFile/writeFile work on VFS
  // paths) gives tar the real fds it needs.
  const hasBundle = await hasSupportFiles(dir);
  let archive: Uint8Array<ArrayBuffer> | undefined;
  if (hasBundle) {
    const realDir = await copySkillDirToReal(dir);
    try {
      archive = new Uint8Array(await packSkillArchive(realDir));
    } finally {
      await rm(realDir, { recursive: true, force: true }).catch((e) =>
        logger.debug("cleanup failed", { error: e instanceof Error ? e.message : String(e) }),
      );
    }
  }

  const result = await SkillStorage.publish(SYSTEM_SKILL_NAMESPACE, name, SYSTEM_USER_ID, {
    description,
    instructions,
    frontmatter: { ...frontmatter, "source-hash": sourceHash },
    archive,
  });

  if (!result.ok) {
    logger.error("publish failed", { name, error: result.error });
    return null;
  }
  logger.info("bootstrapped system skill", {
    name: `@${SYSTEM_SKILL_NAMESPACE}/${name}`,
    version: result.data.version,
    hash: sourceHash.slice(0, 12),
  });
  return name;
}

async function hasSupportFiles(dir: string): Promise<boolean> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "SKILL.md") continue;
    if (entry.isFile() || entry.isDirectory()) return true;
  }
  return false;
}

/**
 * Recursively copies a skill directory tree to a fresh OS temp directory
 * using only `readdir` / `readFile` / `writeFile`, which work on VFS
 * paths inside a Deno-compiled binary. The result is a real on-disk tree
 * with genuine OS file descriptors that `packSkillArchive` (via tar) can
 * open without error.
 *
 * Exported for unit testing. Callers are responsible for removing the
 * returned directory when done.
 */
export async function copySkillDirToReal(srcDir: string): Promise<string> {
  const destDir = makeTempDir({ prefix: "atlas-skill-copy-" });
  await copyEntries(srcDir, destDir);
  return destDir;
}

async function copyEntries(srcDir: string, destDir: string): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = join(srcDir, entry.name);
    const dest = join(destDir, entry.name);
    if (entry.isDirectory()) {
      await mkdir(dest, { recursive: true });
      await copyEntries(src, dest);
    } else if (entry.isFile()) {
      await writeFile(dest, await readFile(src));
    }
  }
}
