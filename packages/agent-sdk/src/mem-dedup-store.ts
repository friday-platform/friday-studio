import type {
  DedupEntry,
  DedupStore,
  HistoryEntry,
  HistoryFilter,
  MemoryAdapter,
  StoreKind,
  StoreMetadata,
  StoreOf,
} from "./memory-adapter.ts";

interface StoredEntry {
  field: string;
  value: string;
  expiresAt: number | null;
}

export class MemDedupStore implements DedupStore {
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
  private stores = new Map<string, MemDedupStore>();

  private storesKey(workspaceId: string, name: string): string {
    return `${workspaceId}:${name}`;
  }

  // TS cannot narrow conditional StoreOf<K> from a runtime check on K
  // (microsoft/TypeScript#33014); safe because all non-dedup paths throw
  // deno-lint-ignore require-await
  async store<K extends StoreKind>(
    workspaceId: string,
    name: string,
    kind: K,
  ): Promise<StoreOf<K>> {
    if (kind !== "dedup") {
      throw new Error(`InMemoryMemoryAdapter only supports 'dedup' stores, got '${kind}'`);
    }
    const key = this.storesKey(workspaceId, name);
    let existing = this.stores.get(key);
    if (!existing) {
      existing = new MemDedupStore(workspaceId, name);
      this.stores.set(key, existing);
    }
    const result: unknown = existing;
    return result as StoreOf<K>;
  }

  // deno-lint-ignore require-await
  async list(workspaceId: string): Promise<StoreMetadata[]> {
    const result: StoreMetadata[] = [];
    for (const [key, store] of this.stores) {
      if (key.startsWith(`${workspaceId}:`)) {
        result.push({ name: store.name, kind: "dedup", workspaceId: store.workspaceId });
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

  async rollback(_workspaceId: string, _store: string, _toVersion: string): Promise<void> {
    // no-op in memory stub
  }
}
