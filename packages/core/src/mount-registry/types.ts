import type { CorpusKind } from "@atlas/agent-sdk";
import { z } from "zod";

export const MountSourceSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  kind: z.enum(["narrative", "retrieval", "dedup", "kv"]),
  name: z.string(),
  createdAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime(),
});

export const MountConsumerSchema = z.object({
  consumerId: z.string(),
  sourceId: z.string(),
  addedAt: z.string().datetime(),
});

export type MountSource = z.infer<typeof MountSourceSchema>;
export type MountConsumer = z.infer<typeof MountConsumerSchema>;

export function buildSourceId(workspaceId: string, kind: CorpusKind, name: string): string {
  return `${workspaceId}/${kind}/${name}`;
}
