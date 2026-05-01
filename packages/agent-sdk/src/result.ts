import type { ArtifactRef, OutlineRef, ToolCall, ToolResult } from "./types.ts";

export interface AgentExtras {
  reasoning?: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  artifactRefs?: ArtifactRef[];
  outlineRefs?: OutlineRef[];
}

/** @example return ok({ response: "Hello" }, { artifactRefs }); */
export function ok<T>(data: T, extras?: AgentExtras) {
  return { ok: true as const, data, ...extras };
}

/** @example return err("ANTHROPIC_API_KEY not set"); */
export function err(reason: string) {
  return { ok: false as const, error: { reason } };
}

// Inferred types for consumers who need them
export type AgentPayloadSuccess<T> = ReturnType<typeof ok<T>>;
export type AgentPayloadError = ReturnType<typeof err>;
export type AgentPayload<T> = AgentPayloadSuccess<T> | AgentPayloadError;
