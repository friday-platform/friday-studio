import type { CorpusKind, CorpusOf } from "../memory-adapter.ts";
import type { AgentContext } from "../types.ts";

export async function resolveCorpus<K extends CorpusKind>(
  ctx: AgentContext,
  name: string,
  kind: K,
): Promise<CorpusOf<K>> {
  if (!ctx.memory?.adapter) {
    throw new Error("MemoryAdapter not available on agent context");
  }
  return await ctx.memory.adapter.corpus(ctx.session.workspaceId, name, kind);
}
