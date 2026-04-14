/**
 * MdMemoryAdapter — Markdown-backed MemoryAdapter facade.
 *
 * Routes corpus() to MdNarrativeCorpus for the 'narrative' kind.
 * Retrieval, dedup, and kv backends are deferred to Phase 1b.
 *
 * Storage layout: {root}/memory/{workspaceId}/narrative/{corpusName}/
 * Each corpus gets its own directory; MdNarrativeCorpus writes MEMORY.md inside it.
 *
 * From parity plan v6, lines 585-603:
 * > MemoryAdapter — corpus-typed memory with swappable backends.
 */

import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  HistoryEntry,
  HistoryFilter,
  MemoryAdapter,
} from "@atlas/agent-sdk";
import { MdNarrativeCorpus } from "./md-narrative-corpus.ts";
import { NotImplementedError } from "./md-skill-adapter.ts";

export class MdMemoryAdapter implements MemoryAdapter {
  private readonly root: string;

  constructor(opts: { root: string }) {
    this.root = opts.root;
  }

  private narrativeDir(workspaceId: string): string {
    return path.join(this.root, "memory", workspaceId, "narrative");
  }

  // TS cannot narrow conditional CorpusOf<K> from a runtime check on K
  // (microsoft/TypeScript#33014); safe because all non-narrative paths throw
  async corpus<K extends CorpusKind>(
    workspaceId: string,
    name: string,
    kind: K,
  ): Promise<CorpusOf<K>> {
    if (kind !== "narrative") {
      throw new NotImplementedError(`${kind} backend not implemented — see Phase 1b`);
    }
    const corpusDir = path.join(this.narrativeDir(workspaceId), name);
    await fs.mkdir(corpusDir, { recursive: true });
    const result: unknown = new MdNarrativeCorpus({ workspaceRoot: corpusDir });
    return result as CorpusOf<K>;
  }

  async list(workspaceId: string): Promise<CorpusMetadata[]> {
    const dir = this.narrativeDir(workspaceId);
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }

    const results: CorpusMetadata[] = [];
    for (const entry of entries) {
      if (entry.isDirectory()) {
        results.push({ name: entry.name, kind: "narrative", workspaceId });
      }
    }
    return results;
  }

  async bootstrap(workspaceId: string, _agentId: string): Promise<string> {
    const corpora = await this.list(workspaceId);
    if (corpora.length === 0) {
      return "";
    }

    const rendered: string[] = [];
    for (const meta of corpora) {
      const corpus = await this.corpus(workspaceId, meta.name, "narrative");
      const content = await corpus.render();
      rendered.push(content);
    }
    return rendered.join("\n");
  }

  history(_workspaceId: string, _filter?: HistoryFilter): Promise<HistoryEntry[]> {
    throw new NotImplementedError("history() not implemented — see Phase 1b");
  }

  rollback(_workspaceId: string, _corpus: string, _toVersion: string): Promise<void> {
    throw new NotImplementedError("rollback() not implemented — see Phase 1b");
  }
}
