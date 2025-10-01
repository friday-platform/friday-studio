/**
 * Core storage interfaces and types for Atlas storage adapters
 */

import type { CoALAMemoryEntry, CoALAMemoryType } from "@atlas/memory";

// Enhanced storage adapter for CoALA memory types
export interface ICoALAMemoryStorageAdapter {
  commitByType(memoryType: CoALAMemoryType, data: CoALAMemoryEntry[]): Promise<void>;
  loadByType(memoryType: CoALAMemoryType): Promise<CoALAMemoryEntry[]>;
  commitAll(dataByType: Record<CoALAMemoryType, CoALAMemoryEntry[]>): Promise<void>;
  loadAll(): Promise<Record<CoALAMemoryType, CoALAMemoryEntry[]>>;
  listMemoryTypes(): CoALAMemoryType[];
}
