// Full-instance bundle: one zip containing N per-workspace bundles + a manifest.
// Each entry in `workspaces/` is a regular bundle zip produced by exportBundle,
// so per-workspace import round-trips via the existing importBundle path.
//
// Layout:
//   atlas-full-<date>.zip
//   ├── manifest.yml
//   └── workspaces/
//       ├── <source-instance-workspace-id>.zip
//       └── ...
// Reserved (not populated yet):
//   └── global/{skills,memory}.zip
//
// Workspace IDs inside the outer zip are the SOURCE instance's local IDs —
// used only as stable, non-colliding filenames. Import does NOT preserve IDs;
// each imported workspace gets a fresh auto-generated ID on the target instance.

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "@std/yaml";
import JSZip from "jszip";
import { z } from "zod";
import { type ImportResult, importBundle } from "./bundle.ts";

const WorkspaceEntrySchema = z.object({
  kind: z.literal("workspace"),
  name: z.string().min(1),
  path: z.string().min(1),
});

// `global` slots reserved for future expansion — current archives leave them null.
// Readers must tolerate unknown or non-null values for forward-compat.
const GlobalSlotsSchema = z
  .object({
    skills: z.string().nullable().default(null),
    memory: z.string().nullable().default(null),
  })
  .passthrough();

export const FullManifestSchema = z.object({
  schemaVersion: z.literal(1),
  createdAt: z.string().min(1),
  atlasVersion: z.string().min(1).optional(),
  mode: z.enum(["definition", "migration"]),
  entries: z.array(WorkspaceEntrySchema),
  reserved: z.object({ global: GlobalSlotsSchema }).default({
    global: { skills: null, memory: null },
  }),
});
export type FullManifest = z.infer<typeof FullManifestSchema>;

export interface ExportAllInputWorkspace {
  /** Source instance's workspace ID — used as the inner zip's filename. */
  id: string;
  /** Workspace display name copied into the manifest + lockfile. */
  name: string;
  /** Pre-built per-workspace bundle bytes (as produced by exportBundle). */
  bundleBytes: Uint8Array;
}

export interface ExportAllOptions {
  workspaces: ExportAllInputWorkspace[];
  mode: "definition" | "migration";
  atlasVersion?: string;
  /** Override Date.now() for deterministic tests. */
  now?: () => Date;
  /**
   * Phase 2 — global state. When `.skills` is provided the outer archive
   * gains `global/skills.zip` and the manifest's `reserved.global.skills`
   * flips from null to that path. Old readers ignore the unknown path; new
   * readers materialize it.
   */
  global?: {
    skills?: Uint8Array;
  };
}

export async function exportAll(opts: ExportAllOptions): Promise<Uint8Array> {
  const zip = new JSZip();
  const createdAt = (opts.now ? opts.now() : new Date()).toISOString();

  const entries: FullManifest["entries"] = [];
  for (const w of opts.workspaces) {
    const zipName = `workspaces/${w.id}.zip`;
    zip.file(zipName, w.bundleBytes);
    entries.push({ kind: "workspace", name: w.name, path: zipName });
  }

  let globalSkillsPath: string | null = null;
  if (opts.global?.skills) {
    globalSkillsPath = "global/skills.zip";
    zip.file(globalSkillsPath, opts.global.skills);
  }

  const manifest: FullManifest = {
    schemaVersion: 1,
    createdAt,
    ...(opts.atlasVersion ? { atlasVersion: opts.atlasVersion } : {}),
    mode: opts.mode,
    entries,
    reserved: { global: { skills: globalSkillsPath, memory: null } },
  };

  // Round-trip through JSON to drop any stray `undefined` values that @std/yaml can't serialize.
  const safeManifest = JSON.parse(JSON.stringify(FullManifestSchema.parse(manifest))) as Record<
    string,
    unknown
  >;
  const manifestYaml = stringify(safeManifest, { lineWidth: 100 });
  zip.file("manifest.yml", manifestYaml);

  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
}

export interface ImportAllOptions {
  zipBytes: Uint8Array;
  /**
   * Directory under which per-workspace dirs get materialized.
   * Typically `<atlasHome>/workspaces`.
   */
  workspacesRoot: string;
  /** Optional suffix source — default appends `-<index>` after a shared timestamp. */
  dirSuffix?: (manifestEntryIndex: number, manifestEntryName: string) => string;
}

export interface ImportAllResult {
  manifest: FullManifest;
  imported: Array<{
    /** Manifest-declared workspace name (from the source instance). */
    name: string;
    /** Absolute path of the materialized workspace directory on this host. */
    path: string;
    primitives: ImportResult["primitives"];
  }>;
  errors: Array<{ name: string; error: string }>;
  /**
   * Raw bytes of `global/skills.zip` if present. The caller is responsible
   * for handing these to `importGlobalSkills` (we keep bundle-package
   * layering clean — this package doesn't know where the local skills DB
   * lives; that's the route's concern).
   */
  globalSkillsBytes?: Uint8Array;
}

export async function importAll(opts: ImportAllOptions): Promise<ImportAllResult> {
  const outer = await JSZip.loadAsync(opts.zipBytes);

  const manifestFile = outer.file("manifest.yml");
  if (!manifestFile) {
    throw new Error("importAll: archive missing manifest.yml");
  }
  const manifestYaml = await manifestFile.async("string");
  const manifest = FullManifestSchema.parse(parse(manifestYaml));

  const sharedTs = Date.now().toString(36);
  const defaultSuffix = (i: number): string => `imported-${sharedTs}-${i}`;
  const makeSuffix = opts.dirSuffix ?? defaultSuffix;

  await mkdir(opts.workspacesRoot, { recursive: true });

  const imported: ImportAllResult["imported"] = [];
  const errors: ImportAllResult["errors"] = [];

  for (let i = 0; i < manifest.entries.length; i++) {
    const entry = manifest.entries[i];
    if (!entry) continue;
    try {
      const inner = outer.file(entry.path);
      if (!inner) {
        errors.push({ name: entry.name, error: `manifest entry path missing in archive: ${entry.path}` });
        continue;
      }
      const innerBytes = await inner.async("uint8array");
      const targetDir = join(opts.workspacesRoot, makeSuffix(i, entry.name));
      const result = await importBundle({ zipBytes: innerBytes, targetDir });
      imported.push({ name: result.lockfile.workspace.name, path: targetDir, primitives: result.primitives });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ name: entry.name, error: message });
    }
  }

  let globalSkillsBytes: Uint8Array | undefined;
  if (manifest.reserved.global.skills) {
    const entry = outer.file(manifest.reserved.global.skills);
    if (entry) {
      globalSkillsBytes = await entry.async("uint8array");
    } else {
      errors.push({
        name: "global.skills",
        error: `manifest declares ${manifest.reserved.global.skills} but entry is missing from archive`,
      });
    }
  }

  return { manifest, imported, errors, globalSkillsBytes };
}

// Smoke helper used by atlas-cli / tests — reads the manifest without materializing anything.
export async function readFullManifest(zipBytes: Uint8Array): Promise<FullManifest> {
  const zip = await JSZip.loadAsync(zipBytes);
  const mf = zip.file("manifest.yml");
  if (!mf) throw new Error("readFullManifest: archive missing manifest.yml");
  const yaml = await mf.async("string");
  return FullManifestSchema.parse(parse(yaml));
}

