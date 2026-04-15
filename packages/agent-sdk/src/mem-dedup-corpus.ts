import type {
  CorpusKind,
  CorpusMetadata,
  CorpusOf,
  DedupCorpus,
  DedupEntry,
  HistoryEntry,
  HistoryFilter,
  MemoryAdapter,
} from "./memory-adapter.ts";

interface StoredEntry {
  field: string;
  value: string;
  expiresAt: number | null;
}

export class MemDedupCorpus implements DedupCorpus {
  private entries = new Map<string, StoredEntry>();

  constructor(
    readonly workspaceId: string,
    readonly name: string,
  ) {}

  private makeId(namespace: string, field: string, value: string): string {
    return `${namespace}:${field}:${value}`;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.entries) {
      if (entry.expiresAt !== null && entry.expiresAt < now) {
        this.entries.delete(id);
      }
    }
  }

  // deno-lint-ignore require-await
  async append(namespace: string, entry: DedupEntry, ttlHours?: number): Promise<void> {
    this.prune();
    const now = Date.now();
    const expiresAt = ttlHours !== undefined ? now + ttlHours * 3_600_000 : null;

    for (const [field, value] of Object.entries(entry)) {
      const serialized = JSON.stringify(value);
      const id = this.makeId(namespace, field, serialized);
      this.entries.set(id, { field, value: serialized, expiresAt });
    }
  }

  // deno-lint-ignore require-await
  async filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]> {
    this.prune();
    const now = Date.now();

    const existing = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (
        id.startsWith(`${namespace}:${field}:`) &&
        entry.field === field &&
        (entry.expiresAt === null || entry.expiresAt > now)
      ) {
        existing.add(entry.value);
      }
    }

    const novel: unknown[] = [];
    for (const v of values) {
      const serialized = JSON.stringify(v);
      if (!existing.has(serialized)) {
        novel.push(v);
      }
    }

    return novel;
  }

  // deno-lint-ignore require-await
  async clear(namespace: string): Promise<void> {
    for (const id of this.entries.keys()) {
      if (id.startsWith(`${namespace}:`)) {
        this.entries.delete(id);
      }
    }
  }
}

export class InMemoryMemoryAdapter implements MemoryAdapter {
  private corpora = new Map<string, MemDedupCorpus>();

  private corporaKey(workspaceId: string, name: string): string {
    return `${workspaceId}:${name}`;
  }

  // TS cannot narrow conditional CorpusOf<K> from a runtime check on K
  // (microsoft/TypeScript#33014); safe because all non-dedup paths throw
  // deno-lint-ignore require-await
  async corpus<K extends CorpusKind>(
    workspaceId: string,
    name: string,
    kind: K,
  ): Promise<CorpusOf<K>> {
    if (kind !== "dedup") {
      throw new Error(`InMemoryMemoryAdapter only supports 'dedup' corpora, got '${kind}'`);
    }
    const key = this.corporaKey(workspaceId, name);
    let existing = this.corpora.get(key);
    if (!existing) {
      existing = new MemDedupCorpus(workspaceId, name);
      this.corpora.set(key, existing);
    }
    const result: unknown = existing;
    return result as CorpusOf<K>;
  }

  // deno-lint-ignore require-await
  async list(workspaceId: string): Promise<CorpusMetadata[]> {
    const result: CorpusMetadata[] = [];
    for (const [key, corpus] of this.corpora) {
      if (key.startsWith(`${workspaceId}:`)) {
        result.push({ name: corpus.name, kind: "dedup", workspaceId: corpus.workspaceId });
      }
    }
    return result;
  }

  // deno-lint-ignore require-await
  async bootstrap(_workspaceId: string, _agentId: string): Promise<string> {
    return "";
  }

  // deno-lint-ignore require-await
  async history(_workspaceId: string, _filter?: HistoryFilter): Promise<HistoryEntry[]> {
    return [];
  }

  async rollback(_workspaceId: string, _corpus: string, _toVersion: string): Promise<void> {
    // no-op in memory stub
  }
}
