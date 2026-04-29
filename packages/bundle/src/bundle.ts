import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import JSZip from "jszip";
import { hashPrimitive } from "./hasher.ts";
import { type Lockfile, readLockfile } from "./lockfile.ts";

export interface ExportOptions {
  /** Path to the workspace directory containing workspace.yml + skills/. */
  workspaceDir: string;
  /** Composed workspace.yml contents to embed, credentials already stripped. */
  workspaceYml: string;
  mode: "definition" | "migration";
  /** Workspace identity for the lockfile. */
  workspace: { name: string; version: string };
  platformDeps?: Lockfile["platformDeps"];
  /**
   * Optional path to the workspace's narrative memory dir
   * (`~/.friday/local/memory/<wid>/`). Included only in `mode: migration`.
   * Expected layout: `<memoryDir>/narrative/<name>/{MEMORY.md,entries.jsonl}`.
   * The bundle embeds it under `memory/<name>/...` and records a digest per
   * narrative in `snapshots.memory`.
   */
  memoryDir?: string;
}

export interface ImportOptions {
  zipBytes: Uint8Array;
  /** Directory to materialize the workspace into (created if missing, must be empty). */
  targetDir: string;
}

export interface ImportResult {
  lockfile: Lockfile;
  primitives: { kind: "skill" | "agent" | "memory"; name: string; path: string }[];
}

async function listPrimitiveDirs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function walkFilesRecursive(root: string, current: string, acc: string[]): Promise<void> {
  const entries = await readdir(current, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      await walkFilesRecursive(root, abs, acc);
    } else if (entry.isFile()) {
      acc.push(relative(root, abs).split(sep).join("/"));
    }
  }
}

export async function exportBundle(opts: ExportOptions): Promise<Uint8Array> {
  const zip = new JSZip();

  zip.file("workspace.yml", opts.workspaceYml);

  const skills: Record<string, { hash: string; path: string }> = {};
  const skillsDir = join(opts.workspaceDir, "skills");
  for (const name of await listPrimitiveDirs(skillsDir)) {
    const primitiveDir = join(skillsDir, name);
    const { hash } = await hashPrimitive(primitiveDir);
    skills[name] = { hash, path: `skills/${name}` };
    const files: string[] = [];
    await walkFilesRecursive(primitiveDir, primitiveDir, files);
    for (const rel of files) {
      const content = await readFile(join(primitiveDir, ...rel.split("/")));
      zip.file(`skills/${name}/${rel}`, content);
    }
  }

  const agents: Record<string, { hash: string; path: string }> = {};
  const agentsDir = join(opts.workspaceDir, "agents");
  for (const name of await listPrimitiveDirs(agentsDir)) {
    const primitiveDir = join(agentsDir, name);
    const { hash } = await hashPrimitive(primitiveDir);
    agents[name] = { hash, path: `agents/${name}` };
    const files: string[] = [];
    await walkFilesRecursive(primitiveDir, primitiveDir, files);
    for (const rel of files) {
      const content = await readFile(join(primitiveDir, ...rel.split("/")));
      zip.file(`agents/${name}/${rel}`, content);
    }
  }

  // Phase 3: embed narrative memory in migration-mode bundles. Source is
  // `<memoryDir>/narrative/<name>/...`, embedded in the zip under `memory/<name>/`,
  // digest recorded in `snapshots.memory[<name>]`.
  //
  // Empty narrative dirs are skipped: the zip carries files only (no empty
  // dirs), so a snapshot entry for an empty narrative would point at a path
  // that doesn't exist in the archive, and `hashPrimitive` on import would
  // ENOENT. The target workspace will recreate narrative dirs on first
  // write, so losing empty placeholders is fine.
  const memorySnapshots: Record<string, { backend: string; digest: string; path: string }> = {};
  if (opts.mode === "migration" && opts.memoryDir) {
    const narrativeRoot = join(opts.memoryDir, "narrative");
    for (const name of await listPrimitiveDirs(narrativeRoot)) {
      const narrativeDir = join(narrativeRoot, name);
      const files: string[] = [];
      await walkFilesRecursive(narrativeDir, narrativeDir, files);
      if (files.length === 0) continue;
      const { hash } = await hashPrimitive(narrativeDir);
      const embedBase = `memory/${name}`;
      memorySnapshots[name] = { backend: "filesystem", digest: hash, path: embedBase };
      for (const rel of files) {
        const content = await readFile(join(narrativeDir, ...rel.split("/")));
        zip.file(`${embedBase}/${rel}`, content);
      }
    }
  }

  const lockfile: Lockfile = {
    schemaVersion: 1,
    mode: opts.mode,
    workspace: opts.workspace,
    ...(opts.platformDeps ? { platformDeps: opts.platformDeps } : {}),
    primitives: { skills, agents },
    ...(opts.mode === "migration"
      ? { snapshots: { memory: memorySnapshots, resources: {}, history: null } }
      : {}),
  };

  const { stringify } = await import("@std/yaml");
  zip.file("workspace.lock", stringify(lockfile as Record<string, unknown>, { lineWidth: 100 }));

  const buf = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
  return buf;
}

async function isDirEmpty(dir: string): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.length === 0;
  } catch {
    return true;
  }
}

export async function importBundle(opts: ImportOptions): Promise<ImportResult> {
  if (!(await isDirEmpty(opts.targetDir))) {
    throw new Error(`importBundle: target directory is not empty: ${opts.targetDir}`);
  }

  const stagingDir = opts.targetDir + ".staging";
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });

  try {
    const zip = await JSZip.loadAsync(opts.zipBytes);
    const fileNames = Object.keys(zip.files).filter((n) => !zip.files[n]?.dir);
    for (const name of fileNames) {
      const file = zip.file(name);
      if (!file) continue;
      const bytes = await file.async("uint8array");
      const absPath = join(stagingDir, name);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, bytes);
    }

    const lockfilePath = join(stagingDir, "workspace.lock");
    await stat(lockfilePath);
    const lockfile = await readLockfile(lockfilePath);

    const primitives: ImportResult["primitives"] = [];
    for (const [name, pin] of Object.entries(lockfile.primitives.skills)) {
      const primitiveDir = join(stagingDir, pin.path);
      const { hash } = await hashPrimitive(primitiveDir);
      if (hash !== pin.hash) {
        throw new Error(
          `importBundle: integrity check failed for skill "${name}": expected ${pin.hash}, got ${hash}`,
        );
      }
      primitives.push({ kind: "skill", name, path: pin.path });
    }
    for (const [name, pin] of Object.entries(lockfile.primitives.agents)) {
      const primitiveDir = join(stagingDir, pin.path);
      const { hash } = await hashPrimitive(primitiveDir);
      if (hash !== pin.hash) {
        throw new Error(
          `importBundle: integrity check failed for agent "${name}": expected ${pin.hash}, got ${hash}`,
        );
      }
      primitives.push({ kind: "agent", name, path: pin.path });
    }
    if (lockfile.mode === "migration" && lockfile.snapshots) {
      for (const [name, pin] of Object.entries(lockfile.snapshots.memory)) {
        const primitiveDir = join(stagingDir, pin.path);
        const { hash } = await hashPrimitive(primitiveDir);
        if (hash !== pin.digest) {
          throw new Error(
            `importBundle: integrity check failed for memory "${name}": expected ${pin.digest}, got ${hash}`,
          );
        }
        primitives.push({ kind: "memory", name, path: pin.path });
      }
    }

    await rm(opts.targetDir, { recursive: true, force: true });
    await rename(stagingDir, opts.targetDir);

    return { lockfile, primitives };
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true });
    throw error;
  }
}

/** Re-verify an already-imported workspace directory against its lockfile. */
export async function verifyWorkspace(
  workspaceDir: string,
): Promise<{ ok: boolean; mismatches: string[] }> {
  const lockfile = await readLockfile(join(workspaceDir, "workspace.lock"));
  const mismatches: string[] = [];
  for (const [name, pin] of Object.entries(lockfile.primitives.skills)) {
    const { hash } = await hashPrimitive(join(workspaceDir, pin.path));
    if (hash !== pin.hash) mismatches.push(`skill:${name}`);
  }
  for (const [name, pin] of Object.entries(lockfile.primitives.agents)) {
    const { hash } = await hashPrimitive(join(workspaceDir, pin.path));
    if (hash !== pin.hash) mismatches.push(`agent:${name}`);
  }
  if (lockfile.mode === "migration" && lockfile.snapshots) {
    for (const [name, pin] of Object.entries(lockfile.snapshots.memory)) {
      const { hash } = await hashPrimitive(join(workspaceDir, pin.path));
      if (hash !== pin.digest) mismatches.push(`memory:${name}`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
