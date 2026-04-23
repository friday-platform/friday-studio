#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-sys --unstable-kv

/**
 * Migrates existing workspaces from the old 3-corpus memory model to the new 2-corpus model.
 *
 * Old model: own=[user-profile(long_term), notes(long_term), scratchpad(scratchpad)]
 * New model: own=[notes(short_term), memory(long_term)] + mounts from user workspace
 *
 * Data migration: entries in user-profile corpus are appended to the notes corpus
 * so nothing is silently orphaned. Uses the workspace registry (Deno KV) to resolve
 * workspace directory names to machine IDs so memory directories are found correctly.
 *
 * Usage:
 *   deno task migrate-memory          # dry-run: shows what would change
 *   deno task migrate-memory --apply  # writes changes (.bak files created)
 */

import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getAtlasHome } from "@atlas/utils/paths.server";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";

const USER_WORKSPACE_ID = "user";

// Workspaces that should never be migrated (system-managed configs).
const SKIP_WORKSPACES = new Set(["system"]);

const apply = Deno.args.includes("--apply");

// ── Registry: workspace dir → machine ID ─────────────────────────────────────

async function loadWorkspaceDirToIdMap(atlasHome: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const kvPath = join(atlasHome, "storage.db");

  if (!existsSync(kvPath)) return map;

  const kv = await Deno.openKv(kvPath);
  try {
    for await (const entry of kv.list<Record<string, unknown>>({ prefix: ["workspaces"] })) {
      const key = entry.key;
      if (key.length !== 2 || key[1] === "_list") continue;
      const value = entry.value;
      if (!value || typeof value !== "object") continue;
      const id = typeof value["id"] === "string" ? value["id"] : null;
      const path = typeof value["path"] === "string" ? value["path"] : null;
      if (id && path && !path.startsWith("system://")) {
        map.set(path, id);
      }
    }
  } finally {
    kv.close();
  }

  return map;
}

// ── Memory model helpers ──────────────────────────────────────────────────────

interface OwnEntry {
  name: string;
  type: string;
  strategy?: string;
}

interface MountEntry {
  name: string;
  source: string;
  mode: string;
  scope: string;
}

interface MemorySection {
  own?: OwnEntry[];
  mounts?: MountEntry[];
}

function hasOldModel(memory: MemorySection | undefined): boolean {
  if (!memory?.own) return false;
  const names = memory.own.map((e) => e.name);
  return names.includes("user-profile") || names.includes("scratchpad");
}

function needsNewCorpus(memory: MemorySection | undefined): boolean {
  if (!memory?.own) return true;
  return !memory.own.some((e) => e.name === "memory");
}

function needsUserMounts(workspaceId: string, memory: MemorySection | undefined): boolean {
  if (workspaceId === USER_WORKSPACE_ID) return false;
  const mounts = memory?.mounts ?? [];
  const hasNotes = mounts.some((m) => m.source === `${USER_WORKSPACE_ID}/narrative/notes`);
  const hasMem = mounts.some((m) => m.source === `${USER_WORKSPACE_ID}/narrative/memory`);
  return !hasNotes || !hasMem;
}

function requiresMigration(workspaceId: string, memory: MemorySection | undefined): boolean {
  return hasOldModel(memory) || needsNewCorpus(memory) || needsUserMounts(workspaceId, memory);
}

function buildNewMemory(workspaceId: string, memory: MemorySection | undefined): MemorySection {
  const isUser = workspaceId === USER_WORKSPACE_ID;

  const own: OwnEntry[] = (memory?.own ?? [])
    .filter((e) => e.name !== "user-profile" && e.name !== "scratchpad")
    .map((e) => (e.name === "notes" ? { ...e, type: "short_term" } : e));

  if (!own.some((e) => e.name === "notes")) {
    own.unshift({ name: "notes", type: "short_term", strategy: "narrative" });
  }

  if (!own.some((e) => e.name === "memory")) {
    own.push({ name: "memory", type: "long_term", strategy: "narrative" });
  }

  const existingMounts = (memory?.mounts ?? []).filter(
    (m) =>
      m.source !== `${USER_WORKSPACE_ID}/narrative/notes` &&
      m.source !== `${USER_WORKSPACE_ID}/narrative/memory`,
  );

  const mounts: MountEntry[] = isUser
    ? existingMounts
    : [
        ...existingMounts,
        {
          name: "user-notes",
          source: `${USER_WORKSPACE_ID}/narrative/notes`,
          mode: "ro",
          scope: "workspace",
        },
        {
          name: "user-memory",
          source: `${USER_WORKSPACE_ID}/narrative/memory`,
          mode: "ro",
          scope: "workspace",
        },
      ];

  return { own, mounts };
}

// ── Targeted YAML block replacement ──────────────────────────────────────────

function replaceMemoryBlock(yamlText: string, newMemory: MemorySection): string {
  const lines = yamlText.split("\n");

  let memStart = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^memory:/.test(lines[i] ?? "")) {
      memStart = i;
      break;
    }
  }

  const newBlock = stringifyYaml({ memory: newMemory }).trimEnd();

  if (memStart === -1) {
    return yamlText.trimEnd() + "\n" + newBlock + "\n";
  }

  let memEnd = lines.length;
  for (let i = memStart + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (line.length > 0 && !/^\s/.test(line)) {
      memEnd = i;
      break;
    }
  }

  return [
    ...lines.slice(0, memStart),
    newBlock,
    ...(memEnd < lines.length ? ["", ...lines.slice(memEnd)] : []),
  ].join("\n");
}

// ── Data migration: copy user-profile entries into notes ──────────────────────

async function migrateCorpusEntries(
  wsMemoryDir: string,
  fromCorpus: string,
  toCorpus: string,
): Promise<number> {
  const srcEntries = join(wsMemoryDir, "narrative", fromCorpus, "entries.jsonl");
  if (!existsSync(srcEntries)) return 0;

  const srcText = await readFile(srcEntries, "utf-8");
  const srcLines = srcText.trim().split("\n").filter(Boolean);
  if (srcLines.length === 0) return 0;

  const destDir = join(wsMemoryDir, "narrative", toCorpus);
  const destEntries = join(destDir, "entries.jsonl");

  let existingText = "";
  if (existsSync(destEntries)) {
    existingText = await readFile(destEntries, "utf-8");
  }

  const combined = [existingText.trimEnd(), srcLines.join("\n")].filter(Boolean).join("\n") + "\n";

  if (apply) {
    await mkdir(destDir, { recursive: true });
    await writeFile(destEntries, combined, "utf-8");
  }

  return srcLines.length;
}

// ── Per-workspace migration ───────────────────────────────────────────────────

async function migrateWorkspace(
  wsDir: string,
  dirName: string,
  wsId: string,
  memoryId: string,
  atlasHome: string,
): Promise<void> {
  const configPath = join(wsDir, "workspace.yml");
  if (!existsSync(configPath)) return;

  const rawYaml = await readFile(configPath, "utf-8");
  const parsed = parseYaml(rawYaml) as Record<string, unknown>;
  const memory = (parsed["memory"] ?? undefined) as MemorySection | undefined;

  if (!requiresMigration(wsId, memory)) {
    console.log(`  [skip] ${wsId} — already on new model`);
    return;
  }

  const newMemory = buildNewMemory(wsId, memory);
  const newYaml = replaceMemoryBlock(rawYaml, newMemory);

  const reparsed = parseYaml(newYaml) as Record<string, unknown>;
  const reparsedMemory = reparsed["memory"] as MemorySection | undefined;
  if (!reparsedMemory?.own?.some((e) => e.name === "notes")) {
    console.error(`  [ERROR] ${wsId} — post-mutation parse check failed, skipping`);
    return;
  }

  const wsMemoryDir = join(atlasHome, "memory", memoryId);
  const movedProfile = await migrateCorpusEntries(wsMemoryDir, "user-profile", "notes");

  const label = dirName !== memoryId ? `${dirName} (${memoryId})` : dirName;
  console.log(`\n  ${label}`);
  if (movedProfile > 0) {
    console.log(
      `    data: ${movedProfile} user-profile entr${movedProfile === 1 ? "y" : "ies"} → notes`,
    );
  }

  const oldOwn = memory?.own?.map((e) => e.name).join(", ") ?? "(none)";
  const newOwn = newMemory.own?.map((e) => `${e.name}(${e.type})`).join(", ") ?? "(none)";
  console.log(`    own:    ${oldOwn} → ${newOwn}`);

  if (wsId !== USER_WORKSPACE_ID) {
    const hadMounts = memory?.mounts?.length ?? 0;
    const nowMounts = newMemory.mounts?.length ?? 0;
    console.log(`    mounts: ${hadMounts} → ${nowMounts}`);
  }

  if (!apply) return;

  await copyFile(configPath, configPath + ".bak");
  await writeFile(configPath, newYaml, "utf-8");
  console.log(`    written (backup: workspace.yml.bak)`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const atlasHome = getAtlasHome();
  const workspacesDir = join(atlasHome, "workspaces");

  console.log(
    apply ? "Applying memory migration...\n" : "Dry-run (pass --apply to write changes):\n",
  );

  const dirToId = await loadWorkspaceDirToIdMap(atlasHome);

  const entries = await readdir(workspacesDir, { withFileTypes: true });

  let count = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dirName = entry.name;
    if (SKIP_WORKSPACES.has(dirName)) continue;

    const wsDir = join(workspacesDir, dirName);
    if (!existsSync(join(wsDir, "workspace.yml"))) continue;

    // Resolve machine ID: use registry if available, fall back to directory name.
    const machineId = dirToId.get(wsDir) ?? dirName;

    // The "workspace ID" for memory model purposes (user mounts check) is the machine ID.
    const wsId = machineId;

    count++;
    await migrateWorkspace(wsDir, dirName, wsId, machineId, atlasHome);
  }

  console.log(`\nDone. Checked ${count} workspace${count === 1 ? "" : "s"}.`);
  if (!apply) {
    console.log("Run with --apply to write changes.");
  }
}

await main();
