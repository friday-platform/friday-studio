// Global skills bundle — carries the user's published skill library between
// instances. Sourced from the JetStream `SKILLS` KV bucket + `SKILL_ARCHIVES`
// Object Store via a `SkillStorageAdapter`. The adapter is constructed by the
// daemon and passed in, so this package stays free of the nats transitive cone.
//
// Layout inside the zip (schema v2):
//   manifest.yml
//   skills-history.jsonl                      — one JSON row per (skillId, version), grouped by skillId, version ASC
//   archives/<skillId>__<version>.tar.gz      — skill archive bytes (only when row.archive.kind === "bytes")
//
// Schema v1 archives use `skills.jsonl` (one row per skillId, latest version only).
// Both schemas are accepted on import; v2 is what `exportGlobalSkills` produces.
//
// The manifest carries a sha256 over the assembled JSONL bytes for integrity;
// each row that owns archive bytes carries a per-archive sha256.

import type { SkillRecord, SkillReplayer, SkillStorageAdapter } from "@atlas/skills";
import { SYSTEM_USER_ID } from "@atlas/skills/constants";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import JSZip from "jszip";
import { z } from "zod";

export const GlobalSkillsManifestSchema = z.object({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  kind: z.literal("global-skills"),
  source: z.object({
    filename: z.enum(["skills.db", "skills.jsonl", "skills-history.jsonl"]),
    skillCount: z.number().int().nonnegative().optional(),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
});
export type GlobalSkillsManifest = z.infer<typeof GlobalSkillsManifestSchema>;

/** v1 row schema — one entry per skillId at latest version. Read-only on import. */
export const SkillRowV1Schema = z.object({
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
export type SkillRowV1 = z.infer<typeof SkillRowV1Schema>;

/** v2 row schema — one entry per (skillId, version), discriminated archive union. */
export const SkillRowV2Schema = z.object({
  skillId: z.string(),
  namespace: z.string(),
  name: z.string(),
  version: z.number().int().positive(),
  id: z.string(),
  createdAt: z.string(),
  createdBy: z.string(),
  description: z.string(),
  descriptionManual: z.boolean(),
  disabled: z.boolean(),
  frontmatter: z.record(z.string(), z.unknown()),
  instructions: z.string(),
  archive: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("bytes"),
      path: z.string(),
      sha256: z.string(),
      byteSize: z.number().int().nonnegative(),
    }),
    z.object({ kind: z.literal("absent") }),
    z.object({ kind: z.literal("inherited") }),
  ]),
});
export type SkillRowV2 = z.infer<typeof SkillRowV2Schema>;

/** @deprecated kept as an alias for the v1 row shape for backwards compatibility. */
export const SkillRowSchema = SkillRowV1Schema;
export type SkillRow = SkillRowV1;

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

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
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
  const rows: SkillRowV2[] = [];

  for (const summary of summaries.data) {
    // Drafts (created via `create()` but never published) carry `name: null`
    // and aren't part of the user's published library — silent-drop is correct.
    if (summary.name === null) continue;

    // System skills (`createdBy === SYSTEM_USER_ID`) are auto-loaded from
    // `packages/system/skills/` on every daemon start; their source-of-truth
    // lives in the package, not the KV. Probe the latest version via
    // `getBySkillId` to read `createdBy` (SkillSummary doesn't carry it).
    const latest = await adapter.getBySkillId(summary.skillId);
    if (!latest.ok) {
      throw new Error(
        `exportGlobalSkills: getBySkillId(${summary.skillId}) failed: ${latest.error}`,
      );
    }
    if (!latest.data) continue;
    if (latest.data.createdBy === SYSTEM_USER_ID) continue;

    const versionsResult = await adapter.listVersions(summary.namespace, summary.name);
    if (!versionsResult.ok) {
      throw new Error(
        `exportGlobalSkills: listVersions(${summary.namespace}, ${summary.name}) failed: ${versionsResult.error}`,
      );
    }
    const versionsAsc = [...versionsResult.data].sort((a, b) => a.version - b.version);

    let priorArchiveBytes: Uint8Array | null = null;
    let priorHadArchive = false;

    for (const v of versionsAsc) {
      const skillResult = await adapter.get(summary.namespace, summary.name, v.version);
      if (!skillResult.ok) {
        throw new Error(
          `exportGlobalSkills: get(${summary.namespace}, ${summary.name}, ${v.version}) failed: ${skillResult.error}`,
        );
      }
      const skill = skillResult.data;
      // The version chain might have entries where get() returns null (e.g.
      // race with deleteVersion). Skip silently rather than emit half-rows.
      if (!skill) continue;
      if (skill.name === null) continue;

      let archive: SkillRowV2["archive"];
      if (!skill.archive) {
        archive = { kind: "absent" };
        priorArchiveBytes = null;
        priorHadArchive = false;
      } else if (
        priorHadArchive &&
        priorArchiveBytes &&
        bytesEqual(skill.archive, priorArchiveBytes)
      ) {
        archive = { kind: "inherited" };
        // priorArchiveBytes stays — successive inherits keep referencing the
        // same upstream bytes.
      } else {
        const path = archivePath(skill.skillId, skill.version);
        zip.file(path, skill.archive);
        archive = {
          kind: "bytes",
          path,
          sha256: `sha256:${await sha256Hex(skill.archive)}`,
          byteSize: skill.archive.byteLength,
        };
        priorArchiveBytes = skill.archive;
        priorHadArchive = true;
      }

      rows.push({
        skillId: skill.skillId,
        namespace: skill.namespace,
        name: skill.name,
        version: skill.version,
        id: skill.id,
        createdAt: skill.createdAt.toISOString(),
        createdBy: skill.createdBy,
        description: skill.description,
        descriptionManual: skill.descriptionManual,
        disabled: skill.disabled,
        frontmatter: skill.frontmatter,
        instructions: skill.instructions,
        archive,
      });
    }
  }

  if (rows.length === 0) {
    return { bytes: null };
  }

  const jsonl = rows.map((r) => JSON.stringify(r)).join("\n");
  const jsonlBytes = new TextEncoder().encode(jsonl);

  const manifest: GlobalSkillsManifest = {
    schemaVersion: 2,
    kind: "global-skills",
    source: {
      filename: "skills-history.jsonl",
      skillCount: rows.length,
      sha256: `sha256:${await sha256Hex(jsonlBytes)}`,
    },
  };

  zip.file("manifest.yml", buildManifestYaml(manifest));
  zip.file("skills-history.jsonl", jsonlBytes);
  const bytes = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes, manifest };
}

function buildManifestYaml(manifest: GlobalSkillsManifest): string {
  return stringifyYaml(GlobalSkillsManifestSchema.parse(manifest), { lineWidth: 100 });
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
  adapter: SkillStorageAdapter & SkillReplayer;
}

export interface ImportGlobalSkillsResult {
  manifest: GlobalSkillsManifest;
  status: ImportStatus;
}

/**
 * Apply a global-skills bundle to the target adapter.
 *
 * **v2 archives** (current export format): each `(skillId, version)` row is
 * replayed verbatim through `adapter.replayVersion()` — id, createdAt,
 * disabled, frontmatter all honored as recorded. Idempotency is presence-based
 * via `listVersions(namespace, name)`: rows whose `(skillId, version)` already
 * exists at the target are skipped without reading archive bytes. Mirrors the
 * May-3 SQLite→JetStream migration; both share `replayVersion`.
 *
 * **v1 archives** (legacy): one row per skillId at the latest version. Falls
 * back to `adapter.publish()` + `adapter.setDisabled()`. Skip predicate is
 * presence-only — any pre-existing skill at the same `skillId` is left alone.
 *
 * Integrity is verified twice: outer sha256 over the JSONL bytes, and a
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

  const jsonlEntry = zip.file(manifest.source.filename);
  if (!jsonlEntry) {
    throw new Error(`importGlobalSkills: ${manifest.source.filename} missing from archive`);
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

  if (manifest.schemaVersion === 1) {
    const status = await importV1Rows(zip, jsonlBytes, adapter);
    return { manifest, status };
  }
  const status = await importV2Rows(zip, jsonlBytes, adapter);
  return { manifest, status };
}

async function importV1Rows(
  zip: JSZip,
  jsonlBytes: Uint8Array,
  adapter: SkillStorageAdapter,
): Promise<ImportStatus> {
  const jsonlText = new TextDecoder().decode(jsonlBytes);
  const rows: SkillRowV1[] = jsonlText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => SkillRowV1Schema.parse(JSON.parse(line)));

  let skillsPublished = 0;
  let skillsSkipped = 0;

  for (const row of rows) {
    const existing = await adapter.getBySkillId(row.skillId);
    if (!existing.ok) {
      throw new Error(`importGlobalSkills: getBySkillId(${row.skillId}) failed: ${existing.error}`);
    }
    if (existing.data) {
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
          kind: "integrity-failed",
          expected: row.archive.sha256,
          actual: actualArchiveSha,
          row: row.skillId,
        };
      }
      archiveBytes = toArrayBufferBacked(bytes);
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

  return { kind: "imported", skillsPublished, skillsSkipped };
}

async function importV2Rows(
  zip: JSZip,
  jsonlBytes: Uint8Array,
  adapter: SkillStorageAdapter & SkillReplayer,
): Promise<ImportStatus> {
  const jsonlText = new TextDecoder().decode(jsonlBytes);
  const rows: SkillRowV2[] = jsonlText
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => SkillRowV2Schema.parse(JSON.parse(line)));

  // Per-skillId map of version → archive bytes from rows already processed in
  // THIS bundle. Used to resolve `inherited` rows by reaching back through the
  // same archive. Same-bundle resolution is the contract; an `inherited` row
  // pointing at a version that's neither here nor at the target is a hard
  // error, surfaced loudly below.
  const archivesBySkill = new Map<string, Map<number, Uint8Array<ArrayBuffer>>>();
  // Cache version-presence checks per skillId so each row's listVersions call
  // doesn't re-walk the KV bucket for the same skill.
  const presenceCache = new Map<string, Set<number>>();

  let skillsPublished = 0;
  let skillsSkipped = 0;

  for (const row of rows) {
    let presentVersions = presenceCache.get(row.skillId);
    if (!presentVersions) {
      const versionsResult = await adapter.listVersions(row.namespace, row.name);
      if (!versionsResult.ok) {
        throw new Error(
          `importGlobalSkills: listVersions(${row.namespace}, ${row.name}) failed for skill ${row.skillId}: ${versionsResult.error}`,
        );
      }
      presentVersions = new Set(versionsResult.data.map((v) => v.version));
      presenceCache.set(row.skillId, presentVersions);
    }

    if (presentVersions.has(row.version)) {
      skillsSkipped++;
      continue;
    }

    let archiveBytes: Uint8Array<ArrayBuffer> | undefined;
    if (row.archive.kind === "bytes") {
      const archiveEntry = zip.file(row.archive.path);
      if (!archiveEntry) {
        throw new Error(
          `importGlobalSkills: archive entry missing at ${row.archive.path} for skill ${row.skillId} version ${row.version}`,
        );
      }
      const bytes = await archiveEntry.async("uint8array");
      const actualArchiveSha = `sha256:${await sha256Hex(bytes)}`;
      if (actualArchiveSha !== row.archive.sha256) {
        return {
          kind: "integrity-failed",
          expected: row.archive.sha256,
          actual: actualArchiveSha,
          row: `${row.skillId}@${row.version}`,
        };
      }
      archiveBytes = toArrayBufferBacked(bytes);
      let perSkill = archivesBySkill.get(row.skillId);
      if (!perSkill) {
        perSkill = new Map();
        archivesBySkill.set(row.skillId, perSkill);
      }
      perSkill.set(row.version, archiveBytes);
    } else if (row.archive.kind === "inherited") {
      const perSkill = archivesBySkill.get(row.skillId);
      // The exporter writes archives onto the version that introduced them
      // and marks every successive same-bytes version `inherited`. The most
      // recent recorded archive in this bundle is the inheritor's source.
      let inherited: Uint8Array<ArrayBuffer> | undefined;
      if (perSkill) {
        let bestVersion = -1;
        for (const recordedVersion of perSkill.keys()) {
          if (recordedVersion < row.version && recordedVersion > bestVersion) {
            bestVersion = recordedVersion;
          }
        }
        if (bestVersion >= 0) {
          inherited = perSkill.get(bestVersion);
        }
      }
      if (!inherited) {
        throw new Error(
          `importGlobalSkills: inherited archive for skill ${row.skillId} version ${row.version} ` +
            `references no prior version with bytes in this bundle`,
        );
      }
      archiveBytes = inherited;
      let perSkillMut = archivesBySkill.get(row.skillId);
      if (!perSkillMut) {
        perSkillMut = new Map();
        archivesBySkill.set(row.skillId, perSkillMut);
      }
      perSkillMut.set(row.version, archiveBytes);
    }
    // archive.kind === "absent" → archiveBytes stays undefined.

    const record: SkillRecord = {
      id: row.id,
      skillId: row.skillId,
      namespace: row.namespace,
      name: row.name,
      version: row.version,
      description: row.description,
      descriptionManual: row.descriptionManual,
      disabled: row.disabled,
      frontmatter: row.frontmatter,
      instructions: row.instructions,
      hasArchive: archiveBytes !== undefined,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    };
    const replayResult = await adapter.replayVersion(record, archiveBytes);
    if (!replayResult.ok) {
      throw new Error(
        `importGlobalSkills: replayVersion failed for ${row.skillId}@${row.version}: ${replayResult.error}`,
      );
    }
    presentVersions.add(row.version);
    skillsPublished++;
  }

  return { kind: "imported", skillsPublished, skillsSkipped };
}

/**
 * Repack JSZip-returned bytes (`Uint8Array<ArrayBufferLike>`) into an
 * `ArrayBuffer`-backed buffer to satisfy `PublishSkillInput.archive` and
 * `replayVersion`'s archive parameter. JSZip uses the wider variant; the
 * skill schemas insist on the narrower one.
 */
function toArrayBufferBacked(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const buf = new ArrayBuffer(bytes.byteLength);
  const out = new Uint8Array(buf);
  out.set(bytes);
  return out;
}
