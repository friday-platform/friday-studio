import type { NarrativeStore } from "../memory-adapter.ts";
import type { AgentContext } from "../types.ts";

export async function resolveStore(ctx: AgentContext, name: string): Promise<NarrativeStore> {
  if (!ctx.memory?.adapter) {
    throw new Error("MemoryAdapter not available on agent context");
  }
  return await ctx.memory.adapter.store(ctx.session.workspaceId, name);
}
