import type { MemoryAdapter } from "@atlas/agent-sdk";

const NAMESPACE = "tickets";
const FIELD = "ticketId";
const TTL_HOURS = 168;

export async function runMigration(
  memory: MemoryAdapter,
  workspaceId: string,
  legacyTicketIds: string[],
): Promise<{ migrated: number; skipped: number }> {
  const corpus = await memory.corpus(workspaceId, "processed-tickets", "dedup");

  const newIds = await corpus.filter(NAMESPACE, FIELD, legacyTicketIds);
  const newIdSet = new Set(newIds);

  for (const id of legacyTicketIds) {
    if (newIdSet.has(id)) {
      await corpus.append(NAMESPACE, { [FIELD]: id }, TTL_HOURS);
    }
  }

  const migrated = newIdSet.size;
  return { migrated, skipped: legacyTicketIds.length - migrated };
}
