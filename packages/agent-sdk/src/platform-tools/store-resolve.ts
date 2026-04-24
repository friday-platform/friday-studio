import type { StoreKind, StoreOf } from "../memory-adapter.ts";
import type { AgentContext } from "../types.ts";

export async function resolveStore<K extends StoreKind>(
  ctx: AgentContext,
  name: string,
  kind: K,
): Promise<StoreOf<K>> {
  if (!ctx.memory?.adapter) {
    throw new Error("MemoryAdapter not available on agent context");
  }
  return await ctx.memory.adapter.store(ctx.session.workspaceId, name, kind);
}
