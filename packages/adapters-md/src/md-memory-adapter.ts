/**
 * MdMemoryAdapter — Markdown-backed MemoryAdapter facade.
 *
 * Routes store() to MdNarrativeStore for the 'narrative' kind.
 * Retrieval, dedup, and kv backends are deferred to Phase 1b.
 *
 * Storage layout: {root}/memory/{workspaceId}/narrative/{memoryName}/
 * Each memory gets its own directory; MdNarrativeStore writes MEMORY.md inside it.
 *
 * From parity plan v6, lines 585-603:
 * > MemoryAdapter — store-typed memory with swappable backends.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  HistoryEntry,
  HistoryFilter,
  MemoryAdapter,
  StoreKind,
  StoreMetadata,
  StoreOf,
} from "@atlas/agent-sdk";
import { MdNarrativeStore } from "./md-narrative-store.ts";
import { NotImplementedError } from "./md-skill-adapter.ts";

export class MdMemoryAdapter implements MemoryAdapter {
  private readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  private narrativeDir(workspaceId: string): string {
    return path.join(this.root, "memory", workspaceId, "narrative");
  }

  async ensureRoot(workspaceId: string, memoryName: string): Promise<void> {
    await fs.mkdir(path.join(this.narrativeDir(workspaceId), memoryName), { recursive: true });
  }

  // TS cannot narrow conditional StoreOf<K> from a runtime check on K
  // (microsoft/TypeScript#33014); safe because all non-narrative paths throw
  async store<K extends StoreKind>(
    workspaceId: string,
    name: string,
    kind: K,
  ): Promise<StoreOf<K>> {
    if (kind !== "narrative") {
      throw new NotImplementedError(`${kind} backend not implemented — see Phase 1b`);
    }
    const storeDir = path.join(this.narrativeDir(workspaceId), name);
    await fs.mkdir(storeDir, { recursive: true });
    const result: unknown = new MdNarrativeStore({ workspaceRoot: storeDir });
    return result as StoreOf<K>;
  }

  async list(workspaceId: string): Promise<StoreMetadata[]> {
    const dir = this.narrativeDir(workspaceId);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: StoreMetadata[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push({ name: entry.name, kind: "narrative", workspaceId });
      }
    }
    return results;
  }

  async bootstrap(workspaceId: string, _agentId: string): Promise<string> {
    const stores = await this.list(workspaceId);
    if (stores.length === 0) {
      return "";
    }

    const rendered: string[] = [];
    for (const meta of stores) {
      const store = await this.store(workspaceId, meta.name, "narrative");
      const content = await store.render();
      rendered.push(content);
    }
    return rendered.join("\n");
  }

  history(_workspaceId: string, _filter?: HistoryFilter): Promise<HistoryEntry[]> {
    throw new NotImplementedError("history() not implemented — see Phase 1b");
  }

  rollback(_workspaceId: string, _store: string, _toVersion: string): Promise<void> {
    throw new NotImplementedError("rollback() not implemented — see Phase 1b");
  }
}
