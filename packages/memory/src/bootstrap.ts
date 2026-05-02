import type { MemoryAdapter, NarrativeEntry, StoreMetadata } from "@atlas/agent-sdk";
import { z } from "zod";

// ── Bootstrap scope types ───────────────────────────────────────────────────

export type MountScope = "workspace" | "job" | "agent";

export type BootstrapScope = MountScope;

export interface MountBinding {
  scope: MountScope;
  memoryName: string;
}

export interface BootstrapContext {
  workspaceId: string;
  agentId: string;
  mounts: MountBinding[];
}

export interface BootstrapOpts {
  scopes?: BootstrapScope[];
  separator?: string;
}

export const MountBindingSchema = z.object({
  scope: z.enum(["workspace", "job", "agent"]),
  memoryName: z.string().min(1),
});

export const BootstrapContextSchema = z.object({
  workspaceId: z.string().min(1),
  agentId: z.string().min(1),
  mounts: z.array(MountBindingSchema),
});

export const BootstrapOptsSchema = z.object({
  scopes: z.array(z.enum(["workspace", "job", "agent"])).optional(),
  separator: z.string().optional(),
});

// ── resolveBootstrap (legacy — iterates all narrative stores via render) ───

export async function resolveBootstrap(
  adapter: MemoryAdapter,
  workspaceId: string,
  _agentId: string,
  opts: BootstrapOpts = {},
): Promise<string> {
  const separator = opts.separator ?? "\n\n";

  const allStores: StoreMetadata[] = await adapter.list(workspaceId);

  const narrativeStores = allStores.filter(
    (c) => c.kind === "narrative" && c.workspaceId === workspaceId,
  );

  const blocks: string[] = [];
  for (const meta of narrativeStores) {
    const store = await adapter.store(workspaceId, meta.name);
    const rendered = await store.render();
    if (rendered.trim().length > 0) {
      blocks.push(rendered);
    }
  }

  return blocks.join(separator);
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_MOUNT_MAX_BYTES = 8 * 1024;
export const DEFAULT_TOTAL_MAX_BYTES = 32 * 1024;

// ── Zod schemas ──────────────────────────────────────────────────────────────

export const MountBootstrapConfigSchema = z.object({
  maxBytes: z.number().int().positive().optional(),
});

export const AgentMountConfigSchema = z.object({
  name: z.string(),
  store: z.string(),
  filter: z.record(z.string(), z.unknown()).optional(),
  bootstrap: MountBootstrapConfigSchema.optional(),
});

// ── TypeScript types ─────────────────────────────────────────────────────────

export interface MountBootstrapConfig {
  maxBytes?: number;
}

export interface AgentMountConfig {
  name: string;
  store: string;
  filter?: Record<string, unknown>;
  bootstrap?: MountBootstrapConfig;
}

// ── Internal helpers (exported for unit-testing) ─────────────────────────────

export function applyFilter(
  entries: NarrativeEntry[],
  filter: Record<string, unknown>,
): NarrativeEntry[] {
  const keys = Object.keys(filter).filter((k) => filter[k] !== undefined);
  if (keys.length === 0) return entries;

  return entries.filter((entry) => {
    const meta = entry.metadata;
    if (!meta) return false;

    for (const key of keys) {
      const value = filter[key];

      if (key.endsWith("_min")) {
        const baseField = key.slice(0, -4);
        const metaVal = meta[baseField];
        if (metaVal === undefined) continue;
        if (typeof metaVal !== "number" || typeof value !== "number") return false;
        if (metaVal < value) return false;
      } else if (key.endsWith("_max")) {
        const baseField = key.slice(0, -4);
        const metaVal = meta[baseField];
        if (metaVal === undefined) continue;
        if (typeof metaVal !== "number" || typeof value !== "number") return false;
        if (metaVal > value) return false;
      } else {
        const metaVal = meta[key];
        if (metaVal === undefined) continue;
        if (metaVal !== value) return false;
      }
    }
    return true;
  });
}

function getPriority(entry: NarrativeEntry): number {
  const p = entry.metadata?.["priority"];
  return typeof p === "number" ? p : 0;
}

export function sortByPriorityDesc(entries: NarrativeEntry[]): NarrativeEntry[] {
  return [...entries].sort((a, b) => getPriority(b) - getPriority(a));
}

function renderBullet(entry: NarrativeEntry): string {
  return `- ${entry.text}`;
}

export function truncateToBytes(
  entries: NarrativeEntry[],
  maxBytes: number,
): { entries: NarrativeEntry[]; truncated: boolean } {
  const encoder = new TextEncoder();
  const kept: NarrativeEntry[] = [];
  let totalSize = 0;

  for (const entry of entries) {
    const line = renderBullet(entry) + "\n";
    const lineBytes = encoder.encode(line).byteLength;
    if (totalSize + lineBytes > maxBytes && kept.length > 0) {
      return { entries: kept, truncated: true };
    }
    totalSize += lineBytes;
    kept.push(entry);
  }

  return { entries: kept, truncated: false };
}

export function renderSection(
  mountName: string,
  entries: NarrativeEntry[],
  truncated: boolean,
): string {
  const lines: string[] = [`## ${mountName}`];
  for (const e of entries) {
    lines.push(renderBullet(e));
  }
  if (truncated) {
    lines.push("<!-- truncated -->");
  }
  return lines.join("\n");
}

// ── Main entry-point ─────────────────────────────────────────────────────────

export async function buildBootstrapBlock(
  adapter: MemoryAdapter,
  workspaceId: string,
  mounts: AgentMountConfig[],
  opts?: { totalMaxBytes?: number },
): Promise<string> {
  const totalMaxBytes = opts?.totalMaxBytes ?? DEFAULT_TOTAL_MAX_BYTES;
  const encoder = new TextEncoder();
  const sections: string[] = [];
  let totalSize = 0;

  for (const mount of mounts) {
    const store = await adapter.store(workspaceId, mount.store);
    const allEntries = await store.read();
    const filtered = mount.filter ? applyFilter(allEntries, mount.filter) : allEntries;
    if (filtered.length === 0) continue;

    const sorted = sortByPriorityDesc(filtered);
    const perMountCap = mount.bootstrap?.maxBytes ?? DEFAULT_MOUNT_MAX_BYTES;
    const { entries: kept, truncated } = truncateToBytes(sorted, perMountCap);
    if (kept.length === 0) continue;

    const section = renderSection(mount.name, kept, truncated);
    const separator = sections.length > 0 ? "\n\n" : "";
    const sectionBytes = encoder.encode(separator + section).byteLength;

    if (totalSize + sectionBytes > totalMaxBytes && sections.length > 0) break;

    totalSize += sectionBytes;
    sections.push(section);
  }

  return sections.join("\n\n");
}

// ── buildBootstrap (canonical entry-point — all narrative stores, workspace scope)

export async function buildBootstrap(
  adapter: MemoryAdapter,
  workspaceId: string,
  _agentId: string,
): Promise<string> {
  const allStores: StoreMetadata[] = await adapter.list(workspaceId);
  const narrativeStores = allStores.filter((c) => c.kind === "narrative");

  const sections: string[] = [];
  for (const meta of narrativeStores) {
    const store = await adapter.store(workspaceId, meta.name);
    const rendered = await store.render();
    if (rendered.trim()) {
      sections.push(rendered.trim());
    }
  }

  return sections.join("\n\n");
}

// ── seedMemories (eager directory creation on workspace registration) ────────

export async function seedMemories(
  adapter: { ensureRoot(workspaceId: string, name: string): Promise<void> },
  workspaceId: string,
  ownEntries: Array<{ name: string; strategy?: string }>,
): Promise<void> {
  for (const entry of ownEntries) {
    if (!entry.strategy || entry.strategy === "narrative") {
      await adapter.ensureRoot(workspaceId, entry.name);
    }
  }
}
