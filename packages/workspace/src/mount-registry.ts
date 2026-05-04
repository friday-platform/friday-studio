import type { NarrativeStore } from "@atlas/agent-sdk";
import { MountSourceNotFoundError } from "./mount-errors.ts";

export type StoreResolver = () => Promise<NarrativeStore>;

export type AnyStore = NarrativeStore;

class MountRegistryImpl {
  private sources = new Map<string, StoreResolver>();
  private consumers = new Map<string, Set<string>>();

  registerSource(sourceId: string, resolver: StoreResolver): void {
    if (!this.sources.has(sourceId)) {
      this.sources.set(sourceId, resolver);
    }
  }

  addConsumer(sourceId: string, workspaceId: string): void {
    const existing = this.consumers.get(sourceId);
    if (existing) {
      existing.add(workspaceId);
    } else {
      this.consumers.set(sourceId, new Set([workspaceId]));
    }
  }

  resolve(sourceId: string): Promise<AnyStore> {
    const resolver = this.sources.get(sourceId);
    if (!resolver) {
      return Promise.reject(new MountSourceNotFoundError(sourceId));
    }
    return resolver();
  }

  getConsumers(sourceId: string): ReadonlySet<string> {
    return this.consumers.get(sourceId) ?? new Set();
  }

  hasSource(sourceId: string): boolean {
    return this.sources.has(sourceId);
  }

  clear(): void {
    this.sources.clear();
    this.consumers.clear();
  }
}

export const mountRegistry = new MountRegistryImpl();
export type { MountRegistryImpl };
