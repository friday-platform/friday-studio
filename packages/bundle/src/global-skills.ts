// Global skills bundle — carries `~/.atlas/skills.db` (local skill library
// published via `skills.sh` or authored in-platform) between instances.
//
// Design trade-off: we byte-copy the SQLite file verbatim. Import is
// non-destructive — if a skills.db already exists at the target path, we
// report `status: "skipped-existing"` and leave both files alone rather than
// attempt an automatic row-level merge. A later phase can add a proper
// row-by-row merger (the schema lives in packages/skills/src/local-adapter.ts)
// if cross-instance merging becomes a common workflow.

import { access, readFile, stat, writeFile } from "node:fs/promises";
import JSZip from "jszip";
import { z } from "zod";

const GlobalSkillsManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("global-skills"),
  source: z.object({
    filename: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    sha256: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }),
});
export type GlobalSkillsManifest = z.infer<typeof GlobalSkillsManifestSchema>;

export interface ExportGlobalSkillsOptions {
  skillsDbPath: string;
}

export interface ExportGlobalSkillsResult {
  /** Raw bytes of the global-skills zip. `null` when the source DB doesn't exist. */
  bytes: Uint8Array | null;
  /** Present when bytes is non-null. */
  manifest?: GlobalSkillsManifest;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function exportGlobalSkills(
  opts: ExportGlobalSkillsOptions,
): Promise<ExportGlobalSkillsResult> {
  try {
    await access(opts.skillsDbPath);
  } catch {
    return { bytes: null };
  }
  const bytes = await readFile(opts.skillsDbPath);
  const src = new Uint8Array(bytes);

  const manifest: GlobalSkillsManifest = {
    schemaVersion: 1,
    kind: "global-skills",
    source: {
      filename: "skills.db",
      byteSize: src.byteLength,
      sha256: `sha256:${await sha256Hex(src)}`,
    },
  };

  const zip = new JSZip();
  zip.file("manifest.yml", await buildManifestYaml(manifest));
  zip.file("skills.db", src);
  const out = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return { bytes: out, manifest };
}

export interface ImportGlobalSkillsOptions {
  zipBytes: Uint8Array;
  skillsDbPath: string;
}

export type ImportGlobalSkillsStatus =
  | { kind: "imported"; bytesWritten: number }
  | { kind: "skipped-existing"; targetPath: string; sideloadedAs: string }
  | { kind: "integrity-failed"; expected: string; actual: string };

export interface ImportGlobalSkillsResult {
  manifest: GlobalSkillsManifest;
  status: ImportGlobalSkillsStatus;
}

export async function importGlobalSkills(
  opts: ImportGlobalSkillsOptions,
): Promise<ImportGlobalSkillsResult> {
  const zip = await JSZip.loadAsync(opts.zipBytes);

  const manifestFile = zip.file("manifest.yml");
  if (!manifestFile) throw new Error("importGlobalSkills: missing manifest.yml");
  const manifestYaml = await manifestFile.async("string");
  const { parse } = await import("@std/yaml");
  const manifest = GlobalSkillsManifestSchema.parse(parse(manifestYaml));

  const dbFile = zip.file("skills.db");
  if (!dbFile) throw new Error("importGlobalSkills: missing skills.db");
  const dbBytes = await dbFile.async("uint8array");

  const actual = `sha256:${await sha256Hex(dbBytes)}`;
  if (actual !== manifest.source.sha256) {
    return {
      manifest,
      status: { kind: "integrity-failed", expected: manifest.source.sha256, actual },
    };
  }

  let targetExists = false;
  try {
    const s = await stat(opts.skillsDbPath);
    targetExists = s.isFile();
  } catch {
    targetExists = false;
  }

  if (targetExists) {
    // Non-destructive: write the imported DB alongside and let the user merge manually.
    const sideloadedAs = `${opts.skillsDbPath}.imported-${Date.now()}`;
    await writeFile(sideloadedAs, dbBytes);
    return {
      manifest,
      status: { kind: "skipped-existing", targetPath: opts.skillsDbPath, sideloadedAs },
    };
  }

  await writeFile(opts.skillsDbPath, dbBytes);
  return { manifest, status: { kind: "imported", bytesWritten: dbBytes.byteLength } };
}

async function buildManifestYaml(manifest: GlobalSkillsManifest): Promise<string> {
  const { stringify } = await import("@std/yaml");
  const safe = JSON.parse(JSON.stringify(GlobalSkillsManifestSchema.parse(manifest))) as Record<
    string,
    unknown
  >;
  return stringify(safe, { lineWidth: 100 });
}
