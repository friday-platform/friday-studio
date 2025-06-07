import type { ITempestMemoryManager, ITempestMemoryStorageAdapter } from "../types/core.ts";
import { LocalFileStorageAdapter } from "../storage/local.ts";

export class MemoryManager implements ITempestMemoryManager {
  private store: ITempestMemoryStorageAdapter;
  private memoryData: Map<string, any> = new Map();

  constructor(storageAdapter?: ITempestMemoryStorageAdapter) {
    this.store = storageAdapter || new LocalFileStorageAdapter();
    this.loadFromStorage();
  }

  remember(key: string, value: any): void {
    this.memoryData.set(key, {
      value,
      timestamp: new Date(),
      type: typeof value
    });
    this.store.commit(Object.fromEntries(this.memoryData));
  }

  recall(key: string): any {
    const memory = this.memoryData.get(key);
    return memory ? memory.value : undefined;
  }

  summarize(): string {
    const entries = Array.from(this.memoryData.entries());
    if (entries.length === 0) {
      return "No memories stored.";
    }

    const summary = entries.map(([key, memory]) => {
      const age = Date.now() - memory.timestamp.getTime();
      const ageStr = age < 60000 ? "just now" : 
                    age < 3600000 ? `${Math.floor(age/60000)}m ago` :
                    `${Math.floor(age/3600000)}h ago`;
      return `${key}: ${memory.type} (${ageStr})`;
    }).join("\n");

    return `Memory Summary (${entries.length} items):\n${summary}`;
  }

  size(): number {
    return this.memoryData.size;
  }

  forget(key: string): void {
    this.memoryData.delete(key);
    this.store.commit(Object.fromEntries(this.memoryData));
  }

  private async loadFromStorage(): Promise<void> {
    try {
      const data = await this.store.load();
      if (data) {
        this.memoryData = new Map(Object.entries(data));
      }
    } catch (error) {
      console.warn("Failed to load memory from storage:", error);
    }
  }
}