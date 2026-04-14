import type { CorpusKind, CorpusMetadata, MemoryAdapter, NarrativeEntry } from "@atlas/agent-sdk";
import { z } from "zod";

// ── Bootstrap scope types (legacy resolve path) ────────────────────────────

export type BootstrapScope = "workspace" | "job" | "agent";

export interface BootstrapOpts {
  scopes?: BootstrapScope[];
  separator?: string;
}

export const BootstrapOptsSchema = z.object({
  scopes: z.array(z.enum(["workspace", "job", "agent"])).optional(),
  separator: z.string().optional(),
});

// ── resolveBootstrap (legacy — iterates all narrative corpora via render) ───

export async function resolveBootstrap(
  adapter: MemoryAdapter,
  workspaceId: string,
  _agentId: string,
  opts: BootstrapOpts = {},
): Promise<string> {
  const separator = opts.separator ?? "\n\n";

  const allCorpora: CorpusMetadata[] = await adapter.list(workspaceId);

  const narrativeCorpora = allCorpora.filter(
    (c) => c.kind === "narrative" && c.workspaceId === workspaceId,
  );

  const blocks: string[] = [];
  for (const meta of narrativeCorpora) {
    const corpus = await adapter.corpus(workspaceId, meta.name, "narrative");
    const rendered = await corpus.render();
    if (rendered.trim().length > 0) {
      blocks.push(rendered);
    }
  }

  return blocks.join(separator);
}

// ── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_MOUNT_MAX_BYTES = 8192;
export const DEFAULT_TOTAL_MAX_BYTES = 32768;

// ── Zod schemas ──────────────────────────────────────────────────────────────

export const MountConfigSchema = z.object({
  corpus: z.string(),
  kind: z.enum(["narrative", "retrieval", "dedup", "kv"]),
  filter: z.record(z.string(), z.unknown()).optional(),
  bootstrap: z.object({ maxBytes: z.number().int().positive().optional() }).optional(),
});

export const AgentMountsConfigSchema = z.object({
  agents: z.record(z.string(), z.object({ mounts: z.array(MountConfigSchema).optional() })),
});

// ── TypeScript types ─────────────────────────────────────────────────────────

export interface MountConfig {
  corpus: string;
  kind: CorpusKind;
  filter?: Record<string, unknown>;
  bootstrap?: { maxBytes?: number };
}

export interface RenderedMount {
  name: string;
  entries: NarrativeEntry[];
  bytesUsed: number;
}

// ── Internal helpers (exported for unit-testing) ─────────────────────────────

export function applyFilter(
  entries: NarrativeEntry[],
  filter?: Record<string, unknown>,
): NarrativeEntry[] {
  if (!filter) return entries;

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

export function truncateToBytes(entries: NarrativeEntry[], maxBytes: number): NarrativeEntry[] {
  const encoder = new TextEncoder();
  const kept: NarrativeEntry[] = [];
  let totalSize = 0;

  for (const entry of entries) {
    const line = renderBullet(entry) + "\n";
    const lineBytes = encoder.encode(line).byteLength;
    if (totalSize + lineBytes > maxBytes && kept.length > 0) {
      return kept;
    }
    totalSize += lineBytes;
    kept.push(entry);
  }

  return kept;
}

export function renderMounts(mounts: RenderedMount[]): string {
  const sections: string[] = [];

  for (const mount of mounts) {
    if (mount.entries.length === 0) continue;

    const lines: string[] = [`## ${mount.name}`, ""];
    for (const e of mount.entries) {
      lines.push(renderBullet(e));
    }
    sections.push(lines.join("\n"));
  }

  return sections.join("\n\n");
}

// ── Main entry-point ─────────────────────────────────────────────────────────

export async function buildBootstrapBlock(
  adapter: MemoryAdapter,
  workspaceId: string,
  _agentId: string,
  mounts: MountConfig[],
  opts?: { totalMaxBytes?: number },
): Promise<string> {
  const totalMaxBytes = opts?.totalMaxBytes ?? DEFAULT_TOTAL_MAX_BYTES;
  const encoder = new TextEncoder();
  const collected: RenderedMount[] = [];
  let totalSize = 0;

  for (const mount of mounts) {
    if (mount.kind !== "narrative") continue;

    const corpus = await adapter.corpus(workspaceId, mount.corpus, "narrative");
    const entries = await corpus.read();
    const filtered = applyFilter(entries, mount.filter);
    if (filtered.length === 0) continue;

    const sorted = sortByPriorityDesc(filtered);
    const perMountCap = mount.bootstrap?.maxBytes ?? DEFAULT_MOUNT_MAX_BYTES;
    const kept = truncateToBytes(sorted, perMountCap);
    if (kept.length === 0) continue;

    const sectionLines = [`## ${mount.corpus}`, "", ...kept.map((e) => renderBullet(e))];
    const sectionStr = sectionLines.join("\n");
    const separator = collected.length > 0 ? "\n\n" : "";
    const sectionBytes = encoder.encode(separator + sectionStr).byteLength;

    if (totalSize + sectionBytes > totalMaxBytes && collected.length > 0) break;

    totalSize += sectionBytes;
    collected.push({ name: mount.corpus, entries: kept, bytesUsed: sectionBytes });
  }

  return renderMounts(collected);
}
