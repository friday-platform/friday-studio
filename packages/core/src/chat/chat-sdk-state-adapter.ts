import type { Lock, QueueEntry, StateAdapter } from "chat";
import { ChatStorage } from "./storage.ts";

interface CacheEntry {
  value: unknown;
  expiresAt: number | null;
}

/**
 * StateAdapter backed by ChatStorage (subscriptions) and an in-memory Map
 * (cache/dedup). Lock, list, and queue methods are compile-only stubs — Chat
 * SDK doesn't call them when configured with `concurrency: "concurrent"`.
 */
export class ChatSdkStateAdapter implements StateAdapter {
  private readonly userId: string;
  private readonly workspaceId: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly threadSources = new Map<
    string,
    "atlas" | "slack" | "discord" | "telegram" | "whatsapp"
  >();

  constructor(opts: { userId: string; workspaceId: string }) {
    this.userId = opts.userId;
    this.workspaceId = opts.workspaceId;
  }

  /** Pre-set the source for a thread before subscribe creates the chat. */
  setSource(
    threadId: string,
    source: "atlas" | "slack" | "discord" | "telegram" | "whatsapp",
  ): void {
    this.threadSources.set(threadId, source);
  }

  /**
   * Drop a pre-set source. Callers use this to clean up after a failed
   * subscribe so the entry doesn't leak when subscribe never reaches the
   * stateAdapter.subscribe() call that would normally consume it.
   */
  clearSource(threadId: string): void {
    this.threadSources.delete(threadId);
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }
  disconnect(): Promise<void> {
    return Promise.resolve();
  }

  async subscribe(threadId: string): Promise<void> {
    const source = this.threadSources.get(threadId) ?? "atlas";
    this.threadSources.delete(threadId);
    await ChatStorage.createChat({
      chatId: threadId,
      userId: this.userId,
      workspaceId: this.workspaceId,
      source,
    });
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    const result = await ChatStorage.getChat(threadId, this.workspaceId);
    if (!result.ok) return false;
    return result.data !== null;
  }

  async unsubscribe(threadId: string): Promise<void> {
    await ChatStorage.deleteChat(threadId, this.workspaceId);
  }

  // Interface requires Promise<T> but cache is synchronous in-memory.
  // deno-lint-ignore require-await
  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() >= entry.expiresAt) {
      this.cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  // deno-lint-ignore require-await
  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    // Opportunistic eviction: walk the map once per write and drop expired
    // entries. Lazy eviction in get() doesn't catch keys that are written
    // and never re-read (e.g. the chat package's dedupe entries written via
    // setIfNotExists), so the map otherwise grows until process restart.
    const now = Date.now();
    for (const [k, entry] of this.cache) {
      if (entry.expiresAt !== null && now >= entry.expiresAt) {
        this.cache.delete(k);
      }
    }
    this.cache.set(key, { value, expiresAt: ttlMs ? now + ttlMs : null });
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    const existing = await this.get(key);
    if (existing !== null) return false;
    await this.set(key, value, ttlMs);
    return true;
  }

  // deno-lint-ignore require-await
  async delete(key: string): Promise<void> {
    this.cache.delete(key);
  }

  acquireLock(_threadId: string, _ttlMs: number): Promise<Lock | null> {
    return Promise.reject(new Error("not implemented"));
  }

  releaseLock(_lock: Lock): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }

  extendLock(_lock: Lock, _ttlMs: number): Promise<boolean> {
    return Promise.reject(new Error("not implemented"));
  }

  forceReleaseLock(_threadId: string): Promise<void> {
    return Promise.reject(new Error("not implemented"));
  }

  // In-memory list backing for adapters that opt-in to persistMessageHistory
  // (Telegram, WhatsApp). ChatStorage is the source of truth for chat
  // messages; this Map caches them for Chat SDK's internal history lookups.
  private readonly lists = new Map<string, { entries: unknown[]; maxLength?: number }>();

  appendToList(
    key: string,
    value: unknown,
    options?: { maxLength?: number; ttlMs?: number },
  ): Promise<void> {
    const existing = this.lists.get(key) ?? { entries: [], maxLength: options?.maxLength };
    existing.entries.push(value);
    if (options?.maxLength && existing.entries.length > options.maxLength) {
      existing.entries = existing.entries.slice(-options.maxLength);
    }
    this.lists.set(key, existing);
    return Promise.resolve();
  }

  getList<T = unknown>(key: string): Promise<T[]> {
    const entry = this.lists.get(key);
    return Promise.resolve((entry?.entries ?? []) as T[]);
  }

  enqueue(_threadId: string, _entry: QueueEntry, _maxSize: number): Promise<number> {
    return Promise.reject(new Error("not implemented"));
  }

  dequeue(_threadId: string): Promise<QueueEntry | null> {
    return Promise.reject(new Error("not implemented"));
  }

  queueDepth(_threadId: string): Promise<number> {
    return Promise.reject(new Error("not implemented"));
  }
}
