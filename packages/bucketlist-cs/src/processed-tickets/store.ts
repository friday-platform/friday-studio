import type { MemoryAdapter } from "@atlas/agent-sdk";
import { z } from "zod";

const NAMESPACE = "tickets";
const FIELD = "ticketId";

export interface ProcessedTicketStore {
  recordProcessed(ticketIds: string[], ttlHours?: number): Promise<void>;
  filterNew(candidateIds: string[]): Promise<string[]>;
  clear(): Promise<void>;
}

export async function createProcessedTicketStore(
  memory: MemoryAdapter,
  workspaceId: string,
): Promise<ProcessedTicketStore> {
  const corpus = await memory.corpus(workspaceId, "processed-tickets", "dedup");

  return {
    async recordProcessed(ticketIds, ttlHours) {
      for (const ticketId of ticketIds) {
        await corpus.append(NAMESPACE, { ticketId }, ttlHours);
      }
    },

    async filterNew(candidateIds) {
      const unseen = await corpus.filter(NAMESPACE, FIELD, candidateIds);
      return z.array(z.string()).parse(unseen);
    },

    async clear() {
      await corpus.clear(NAMESPACE);
    },
  };
}
