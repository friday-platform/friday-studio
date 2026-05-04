/**
 * Migration: ~/.atlas/skills.db (SQLite) → JetStream KV `SKILLS` +
 * Object Store `SKILL_ARCHIVES`.
 *
 * Walks every row in the legacy `skills` and `skill_assignments`
 * tables and republishes through the same `JetStreamSkillAdapter`
 * instances the runtime uses, so the on-disk and in-stream layouts
 * stay in sync. Bundled `friday/*` skills (loaded from
 * `packages/system/skills/<name>/` at every daemon start via
 * `ensureSystemSkills()`) are SKIPPED — their source-of-truth lives
 * in the package, not the database. This migration only covers
 * skills published interactively through `atlas skill publish` /
 * `POST /api/skills/.../upload` (the "skills.sh" path the user
 * cares about).
 *
 * Idempotent — checks the JetStream `SKILLS` bucket for an entry
 * already keyed by `skill/<skillId>/<version>` before publishing.
 * The legacy `skills.db` file is left in place for rollback.
 *
 * No-op if `~/.atlas/skills.db` doesn't exist.
 */

import { join } from "node:path";
import { JetStreamSkillAdapter } from "@atlas/skills";
import { stringifyError } from "@atlas/utils";
import { getFridayHome } from "@atlas/utils/paths.server";
import { Database } from "@db/sqlite";
import type { Migration } from "jetstream";
import { z } from "zod";

const SYSTEM_USER_ID = "system";

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
    "rows whose source-of-truth is packages/system/skills/) and republish " +
    "every (skillId, version) into the SKILLS KV bucket via " +
    "JetStreamSkillAdapter.publish(). Archive bytes go to the " +
    "SKILL_ARCHIVES Object Store. Also copies skill_assignments " +
    "(workspace + job-level). Idempotent — skips rows whose JetStream " +
    "entry already exists. Legacy SQLite file left in place.",
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
      // Skills: pull every (skill_id, version) pair, oldest version first
      // so each publish() lands at the correct version number (the adapter
      // increments from max(version)).
      const rowsStmt = db.prepare(
        "SELECT * FROM skills WHERE created_by != ? ORDER BY skill_id, version ASC",
      );
      const rows = z.array(SkillRow).parse(rowsStmt.all(SYSTEM_USER_ID));
      rowsStmt.finalize();

      let migrated = 0;
      let skipped = 0;
      let failed = 0;

      for (const row of rows) {
        // Idempotency: if this skillId/version is already in JetStream, skip.
        const existing = await adapter.getBySkillId(row.skill_id);
        if (
          existing.ok &&
          existing.data &&
          existing.data.version >= row.version &&
          existing.data.namespace === row.namespace
        ) {
          skipped++;
          continue;
        }

        if (!row.name) {
          // Draft row — replay via create() then leave at version 1.
          // Most drafts get superseded by a later publish, but copy the
          // shell so getById() still resolves.
          const result = await adapter.create(row.namespace, row.created_by);
          if (!result.ok) {
            logger.warn("Failed to migrate skill draft", { id: row.id, error: result.error });
            failed++;
            continue;
          }
          migrated++;
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

        const result = await adapter.publish(row.namespace, row.name, row.created_by, {
          description: row.description,
          descriptionManual: row.description_manual !== 0,
          instructions: row.instructions,
          frontmatter,
          archive: row.archive ?? undefined,
          skillId: row.skill_id,
        });
        if (!result.ok) {
          logger.warn("Failed to migrate skill row", {
            namespace: row.namespace,
            name: row.name,
            version: row.version,
            error: result.error,
          });
          failed++;
          continue;
        }

        // Mirror disabled state (publish always lands enabled — flip if
        // the SQLite row was disabled).
        if (row.disabled !== 0) {
          await adapter.setDisabled(row.skill_id, true);
        }

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
