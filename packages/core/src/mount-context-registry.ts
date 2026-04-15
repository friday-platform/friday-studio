import type { AgentMemoryContext } from "@atlas/agent-sdk";

const registry = new Map<string, AgentMemoryContext>();

export function mountContextKey(sessionId: string, agentId: string): string {
  return `${sessionId}:${agentId}`;
}

export function setMountContext(key: string, ctx: AgentMemoryContext): void {
  registry.set(key, ctx);
}

export function takeMountContext(key: string): AgentMemoryContext | undefined {
  const ctx = registry.get(key);
  if (ctx) {
    registry.delete(key);
  }
  return ctx;
}

export function clearMountContextRegistry(): void {
  registry.clear();
}
