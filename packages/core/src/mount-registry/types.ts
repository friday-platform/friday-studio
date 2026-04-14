import { z } from "zod";

export const CorpusKindSchema = z.enum(["narrative", "retrieval", "dedup", "kv"]);

export const MountSourceSchema = z.object({
  sourceId: z.string(),
  sourceWorkspaceId: z.string(),
  corpusKind: CorpusKindSchema,
  corpusName: z.string(),
  createdAt: z.string().datetime(),
  lastAccessedAt: z.string().datetime(),
});
export type MountSource = z.infer<typeof MountSourceSchema>;

export const MountConsumerSchema = z.object({
  sourceId: z.string(),
  consumerWorkspaceId: z.string(),
  mountedAt: z.string().datetime(),
});
export type MountConsumer = z.infer<typeof MountConsumerSchema>;
