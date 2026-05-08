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
//
// The matching import path lands in a follow-up task; this commit covers
// export only.

import type { SkillStorageAdapter } from "@atlas/skills";
import { SYSTEM_USER_ID } from "@atlas/skills";
import { stringify as stringifyYaml } from "@std/yaml";
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
