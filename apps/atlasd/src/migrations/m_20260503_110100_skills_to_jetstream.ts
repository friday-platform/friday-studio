/**
 * Migration: ~/.atlas/skills.db (SQLite) → JetStream KV `SKILLS` +
 * Object Store `SKILL_ARCHIVES`.
 *
 * Walks every row in the legacy `skills` and `skill_assignments`
 * tables and replays each `(skillId, version)` verbatim into the
 * JetStream `SKILLS` bucket via `JetStreamSkillAdapter.replayVersion()`.
 * Source `id`, `version`, `createdAt`, and `disabled` are preserved
 * exactly — the older `publish()`-based path silently lost these
 * because publish lands at `max(version)+1` regardless of caller
 * intent. Bundled `friday/*` skills (loaded from
 * `packages/system/skills/<name>/` at every daemon start via
 * `ensureSystemSkills()`) are SKIPPED — their source-of-truth lives
 * in the package, not the database. This migration only covers
 * skills published interactively through `atlas skill publish` /
 * `POST /api/skills/.../upload`.
 *
 * Idempotent — pre-filters per skill via `listVersions()` and skips
 * `(skillId, version)` pairs already present in JetStream, so a
 * re-run after a partial failure is a no-op (no duplicate rows, no
 * duplicate-rejection errors). Drafts (rows with `name IS NULL`)
 * still flow through `adapter.create()` since `replayVersion` is
 * for restoring published-version history, not draft shells. The
 * legacy `skills.db` file is left in place for rollback.
 *
 * No-op if `~/.atlas/skills.db` doesn't exist.
 */

import { join } from "node:path";
import { JetStreamSkillAdapter, type SkillRecord } from "@atlas/skills";
import { SYSTEM_USER_ID } from "@atlas/skills/constants";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import type { Migration } from "jetstream";
import { z } from "zod";

const SkillRow = z.object({
  id: z.string(),
  skill_id: z.string(),
  namespace: z.string(),
  name: z.string().nullable(),
  version: z.number().int().positive(),
  description: z.string(),
  description_manual: z.number(),
  disabled: z.number(),
  frontmatter: z.string(),
  instructions: z.string(),
  archive: z.instanceof(Uint8Array).nullable(),
  created_by: z.string(),
  created_at: z.string(),
});

const AssignmentRow = z.object({
  skill_id: z.string(),
  workspace_id: z.string(),
  job_name: z.string().nullable(),
});

export const migration: Migration = {
  id: "20260503_110100_skills_to_jetstream",
  name: "user-published skills (skills.db) → JetStream KV + Object Store",
  description:
    "Walk ~/.atlas/skills.db `skills` rows (excluding bundled friday/* " +
    "rows whose source-of-truth is packages/system/skills/) and replay " +
    "every (skillId, version) verbatim into the SKILLS KV bucket via " +
    "JetStreamSkillAdapter.replayVersion(). Source id, version, createdAt " +
    "and disabled are preserved. Archive bytes go to the SKILL_ARCHIVES " +
    "Object Store. Also copies skill_assignments (workspace + job-level). " +
    "Idempotent — pre-filters versions already in JetStream. Legacy SQLite " +
    "file left in place.",
  async run({ nc, logger }) {
    const dbPath = join(getFridayHome(), "skills.db");

    try {
      await Deno.stat(dbPath);
    } catch {
      logger.debug("Legacy skills.db not present — nothing to migrate", { path: dbPath });
      return;
    }

    const adapter = new JetStreamSkillAdapter(nc);
    const db = new Database(dbPath, { readonly: true });

    try {
      // Skills: pull every (skill_id, version) pair, oldest version first.
      // `replayVersion` honors the source version, so version order isn't
      // load-bearing for that — but for renamed-across-versions skills it
      // still matters: each replay overwrites `by_name[ns,name] -> skillId`,
      // so walking ASC means the latest name wins (matches `publish` semantics).
      const rowsStmt = db.prepare(
        "SELECT * FROM skills WHERE created_by != ? ORDER BY skill_id, version ASC",
      );
      const rows = z.array(SkillRow).parse(rowsStmt.all(SYSTEM_USER_ID));
      rowsStmt.finalize();

      let migrated = 0;
      let skipped = 0;
      let failed = 0;

      // Cache of versions already in JetStream per (namespace, name). Built
      // lazily on first row per skill via `listVersions()` so re-runs after
      // a partial failure don't trip `replayVersion`'s duplicate guard.
      const seenVersions = new Map<string, Set<number>>();

      for (const row of rows) {
        if (!row.name) {
          // Draft row — replay via create() then leave at version 1.
          // Most drafts get superseded by a later publish, but copy the
          // shell so getById() still resolves. `replayVersion` is for
          // published-version history; drafts have no history to replay.
          const result = await adapter.create(row.namespace, row.created_by);
          if (!result.ok) {
            logger.warn("Failed to migrate skill draft", { id: row.id, error: result.error });
            failed++;
            continue;
          }
          migrated++;
          continue;
        }

        const cacheKey = `${row.namespace}\x00${row.name}`;
        let existingVersions = seenVersions.get(cacheKey);
        if (!existingVersions) {
          const versionsResult = await adapter.listVersions(row.namespace, row.name);
          if (!versionsResult.ok) {
            logger.warn("Failed to list existing versions for skill", {
              namespace: row.namespace,
              name: row.name,
              error: versionsResult.error,
            });
            failed++;
            continue;
          }
          existingVersions = new Set(versionsResult.data.map((v) => v.version));
          seenVersions.set(cacheKey, existingVersions);
        }

        if (existingVersions.has(row.version)) {
          logger.debug("Skipping skill version already present in JetStream", {
            skillId: row.skill_id,
            namespace: row.namespace,
            name: row.name,
            version: row.version,
          });
          skipped++;
          continue;
        }

        let frontmatter: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(row.frontmatter);
          if (parsed && typeof parsed === "object") {
            frontmatter = parsed as Record<string, unknown>;
          }
        } catch {
          // bad JSON — ship empty frontmatter rather than skipping the row
        }

        const record: SkillRecord = {
          id: row.id,
          skillId: row.skill_id,
          namespace: row.namespace,
          name: row.name,
          version: row.version,
          description: row.description,
          descriptionManual: row.description_manual !== 0,
          disabled: row.disabled !== 0,
          frontmatter,
          instructions: row.instructions,
          hasArchive: row.archive !== null,
          createdBy: row.created_by,
          createdAt: row.created_at,
        };

        const result = await adapter.replayVersion(record, row.archive ?? undefined);
        if (!result.ok) {
          logger.warn("Failed to replay skill row", {
            namespace: row.namespace,
            name: row.name,
            version: row.version,
            error: result.error,
          });
          failed++;
          continue;
        }
        existingVersions.add(row.version);
        migrated++;
      }

      // Skill assignments — workspace-level + job-level.
      let assignMigrated = 0;
      try {
        const aStmt = db.prepare("SELECT skill_id, workspace_id, job_name FROM skill_assignments");
        const assignments = z.array(AssignmentRow).parse(aStmt.all());
        aStmt.finalize();

        for (const a of assignments) {
          try {
            if (a.job_name) {
              await adapter.assignToJob(a.skill_id, a.workspace_id, a.job_name);
            } else {
              await adapter.assignSkill(a.skill_id, a.workspace_id);
            }
            assignMigrated++;
          } catch (err) {
            logger.warn("Failed to migrate skill assignment", {
              skillId: a.skill_id,
              workspaceId: a.workspace_id,
              jobName: a.job_name,
              error: stringifyError(err),
            });
          }
        }
      } catch (err) {
        // skill_assignments may not exist on a very old DB — log + continue.
        logger.warn("skill_assignments table missing or unreadable", {
          error: stringifyError(err),
        });
      }

      logger.info("Skills migration complete", {
        skillRowsMigrated: migrated,
        skillRowsSkipped: skipped,
        skillRowsFailed: failed,
        assignmentsMigrated: assignMigrated,
      });
    } finally {
      db.close();
    }
  },
};
