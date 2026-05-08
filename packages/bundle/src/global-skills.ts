// Global skills bundle — carries the user's published skill library between
// instances. Sourced from the JetStream `SKILLS` KV bucket + `SKILL_ARCHIVES`
// Object Store via a `SkillStorageAdapter`. The adapter is constructed by the
// daemon and passed in, so this package stays free of the nats transitive cone.
//
// Layout inside the zip:
//   manifest.yml
//   skills.jsonl                              — one JSON row per skill (sans archive bytes)
//   archives/<skillId>__<version>.tar.gz      — skill archive bytes (when present)
//
// The manifest carries a sha256 over the assembled `skills.jsonl` bytes for
// integrity. Each row that owns archive bytes carries a per-archive sha256.
//
// Latest-version semantics: the export pulls one row per skill — whatever
// `adapter.list()` returns (latest-version-per-skillId today).

import type { SkillStorageAdapter } from "@atlas/skills";
import { SYSTEM_USER_ID } from "@atlas/skills";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import JSZip from "jszip";
import { z } from "zod";

export const GlobalSkillsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("global-skills"),
  source: z.object({
    filename: z.enum(["skills.db", "skills.jsonl"]),
    skillCount: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
});
export type GlobalSkillsManifest = z.infer<typeof GlobalSkillsManifestSchema>;

export const SkillRowSchema = z.object({
  skillId: z.string(),
  namespace: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  description: z.string(),
  descriptionManual: z.boolean(),
  disabled: z.boolean(),
  frontmatter: z.record(z.string(), z.unknown()),
  instructions: z.string(),
  createdBy: z.string(),
  createdAt: z.string(),
  archive: z
    .object({ path: z.string(), sha256: z.string(), byteSize: z.number().int().nonnegative() })
    .nullable(),
});
export type SkillRow = z.infer<typeof SkillRowSchema>;

export interface ExportGlobalSkillsOptions {
  adapter: SkillStorageAdapter;
}

export interface ExportGlobalSkillsResult {
  /** Raw bytes of the global-skills zip. `null` when zero non-system skills. */
  bytes: Uint8Array | null;
  /** Present when bytes is non-null. */
  manifest?: GlobalSkillsManifest;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `Uint8Array<ArrayBufferLike>` (TS 5+ default) is not assignable to
  // BufferSource's `ArrayBufferView<ArrayBuffer>`. Slice to produce a fresh
  // Uint8Array backed by ArrayBuffer.
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function archivePath(skillId: string, version: number): string {
  return `archives/${skillId}__${version}.tar.gz`;
}

export async function exportGlobalSkills(
  opts: ExportGlobalSkillsOptions,
): Promise<ExportGlobalSkillsResult> {
  const { adapter } = opts;
  const summaries = await adapter.list(undefined, undefined, true);
  if (!summaries.ok) {
    throw new Error(`exportGlobalSkills: list failed: ${summaries.error}`);
  }

  const zip = new JSZip();
  const rows: SkillRow[] = [];

  for (const summary of summaries.data) {
    const skillResult = await adapter.getById(summary.id);
    if (!skillResult.ok) {
      throw new Error(`exportGlobalSkills: getById(${summary.id}) failed: ${skillResult.error}`);
    }
    const skill = skillResult.data;
    if (!skill) continue;
    if (skill.createdBy === SYSTEM_USER_ID) continue;
    if (skill.name === null) continue;

    let archive: SkillRow["archive"] = null;
    if (skill.archive) {
      const path = archivePath(skill.skillId, skill.version);
      zip.file(path, skill.archive);
      archive = {
        path,
        sha256: `sha256:${await sha256Hex(skill.archive)}`,
        byteSize: skill.archive.byteLength,
      };
    }

    rows.push(
      SkillRowSchema.parse({
        skillId: skill.skillId,
        namespace: skill.namespace,
        name: skill.name,
        version: skill.version,
        description: skill.description,
        descriptionManual: skill.descriptionManual,
        disabled: skill.disabled,
        frontmatter: skill.frontmatter,
        instructions: skill.instructions,
        createdBy: skill.createdBy,
        createdAt: skill.createdAt.toISOString(),
        archive,
      }),
    );
  }

  if (rows.length === 0) {
    return { bytes: null };
  }

  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  const jsonlBytes = new TextEncoder().encode(jsonl);

  const manifest: GlobalSkillsManifest = {
    schemaVersion: 1,
    kind: "global-skills",
    source: {
      filename: "skills.jsonl",
      skillCount: rows.length,
      sha256: `sha256:${await sha256Hex(jsonlBytes)}`,
    },
  };

  zip.file("manifest.yml", buildManifestYaml(manifest));
  zip.file("skills.jsonl", jsonlBytes);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, manifest };
}

function buildManifestYaml(manifest: GlobalSkillsManifest): string {
  // Round-trip through JSON to drop any stray `undefined` values that @std/yaml
  // can't serialize.
  const safe = JSON.parse(JSON.stringify(GlobalSkillsManifestSchema.parse(manifest))) as Record<
    string,
    unknown
  >;
  return stringifyYaml(safe, { lineWidth: 100 });
}

// ──────────────────────────────────────────────────────────────────────────────
// Import
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Thrown when an archive's manifest declares `source.filename === "skills.db"`.
 * Pre-May-3 daemons exported the SQLite blob directly; that path is gone after
 * the JetStream migration. The user must re-export from a current daemon to
 * produce a JSONL-shaped archive.
 */
export class LegacyArchiveError extends Error {
  constructor() {
    super(
      "global-skills archive is from a pre-migration export (contains skills.db). " +
        "Re-export from a current daemon to produce a JSONL-shaped archive.",
    );
    this.name = "LegacyArchiveError";
  }
}

export type ImportStatus =
  | { kind: "imported"; skillsPublished: number; skillsSkipped: number }
  | { kind: "integrity-failed"; expected: string; actual: string; row?: string };

export interface ImportGlobalSkillsOptions {
  zipBytes: Uint8Array;
  adapter: SkillStorageAdapter;
}

export interface ImportGlobalSkillsResult {
  manifest: GlobalSkillsManifest;
  status: ImportStatus;
}

/**
 * Apply a global-skills bundle to the target adapter.
 *
 * Idempotency mirrors the May 3 migration (m_20260503_110100): if the target
 * already has a skill at the same `skillId` with `version >= row.version` and
 * the same namespace, the row is skipped without reading archive bytes. This
 * keeps re-imports cheap and prevents version inflation.
 *
 * Integrity is verified twice: outer sha256 over `skills.jsonl` bytes, and a
 * per-archive sha256 for each row that carries archive bytes. Either mismatch
 * surfaces as `{ kind: "integrity-failed" }` and aborts further publishing.
 */
export async function importGlobalSkills(
  opts: ImportGlobalSkillsOptions,
): Promise<ImportGlobalSkillsResult> {
  const { zipBytes, adapter } = opts;
  const zip = await JSZip.loadAsync(zipBytes);

  const manifestEntry = zip.file("manifest.yml");
  if (!manifestEntry) {
    throw new Error("importGlobalSkills: manifest.yml missing from archive");
  }
  const manifestYaml = await manifestEntry.async("string");
  const manifest = GlobalSkillsManifestSchema.parse(parseYaml(manifestYaml));

  if (manifest.source.filename === "skills.db") {
    throw new LegacyArchiveError();
  }

  const jsonlEntry = zip.file("skills.jsonl");
  if (!jsonlEntry) {
    throw new Error("importGlobalSkills: skills.jsonl missing from archive");
  }
  const jsonlBytes = await jsonlEntry.async("uint8array");
  const actualJsonlSha = `sha256:${await sha256Hex(jsonlBytes)}`;
  if (actualJsonlSha !== manifest.source.sha256) {
    return {
      manifest,
      status: {
        kind: "integrity-failed",
        expected: manifest.source.sha256,
        actual: actualJsonlSha,
      },
    };
  }

  const jsonlText = new TextDecoder().decode(jsonlBytes);
  const rows: SkillRow[] = jsonlText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => SkillRowSchema.parse(JSON.parse(line)));

  let skillsPublished = 0;
  let skillsSkipped = 0;

  for (const row of rows) {
    // Idempotency: mirrors apps/atlasd/src/migrations/m_20260503_110100_skills_to_jetstream.ts:96-104
    const existing = await adapter.getBySkillId(row.skillId);
    if (
      existing.ok &&
      existing.data &&
      existing.data.version >= row.version &&
      existing.data.namespace === row.namespace
    ) {
      skillsSkipped++;
      continue;
    }

    let archiveBytes: Uint8Array<ArrayBuffer> | undefined;
    if (row.archive) {
      const archiveEntry = zip.file(row.archive.path);
      if (!archiveEntry) {
        throw new Error(
          `importGlobalSkills: archive entry missing at ${row.archive.path} for skill ${row.skillId}`,
        );
      }
      const bytes = await archiveEntry.async("uint8array");
      const actualArchiveSha = `sha256:${await sha256Hex(bytes)}`;
      if (actualArchiveSha !== row.archive.sha256) {
        return {
          manifest,
          status: {
            kind: "integrity-failed",
            expected: row.archive.sha256,
            actual: actualArchiveSha,
            row: row.skillId,
          },
        };
      }
      // Repack into ArrayBuffer-backed Uint8Array — JSZip returns
      // `Uint8Array<ArrayBufferLike>` but `PublishSkillInput.archive` is
      // typed `Uint8Array<ArrayBuffer>`.
      const buf = new ArrayBuffer(bytes.byteLength);
      archiveBytes = new Uint8Array(buf);
      archiveBytes.set(bytes);
    }

    const publishResult = await adapter.publish(row.namespace, row.name, row.createdBy, {
      skillId: row.skillId,
      description: row.description,
      descriptionManual: row.descriptionManual,
      frontmatter: row.frontmatter,
      instructions: row.instructions,
      ...(archiveBytes ? { archive: archiveBytes } : {}),
    });
    if (!publishResult.ok) {
      throw new Error(
        `importGlobalSkills: publish failed for ${row.skillId}: ${publishResult.error}`,
      );
    }

    if (row.disabled === true) {
      const disableResult = await adapter.setDisabled(row.skillId, true);
      if (!disableResult.ok) {
        throw new Error(
          `importGlobalSkills: setDisabled failed for ${row.skillId}: ${disableResult.error}`,
        );
      }
    }

    skillsPublished++;
  }

  return { manifest, status: { kind: "imported", skillsPublished, skillsSkipped } };
}
