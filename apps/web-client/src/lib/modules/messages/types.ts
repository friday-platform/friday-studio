import { AgentResultSchema } from "@atlas/agent-sdk";
import { z } from "zod";

/** User text message */
export interface RequestEntry {
  type: "request";
  id: string;
  timestamp: string;
  content: string;
}

/** Assistant text response */
export interface TextEntry {
  type: "text";
  id: string;
  timestamp: string;
  content: string;
}

/** Assistant reasoning */
export interface ReasoningEntry {
  type: "reasoning";
  id: string;
  timestamp: string;
  content: string;
}

/** Error message */
export interface ErrorEntry {
  type: "error";
  id: string;
  timestamp: string;
  content: string;
}

/** OAuth credential linked notification */
export interface CredentialLinkedEntry {
  type: "credential_linked";
  id: string;
  timestamp: string;
  provider: string;
  displayName: string;
}

/** Artifact attachment (files uploaded by user) */
export interface ArtifactAttachedEntry {
  type: "artifact_attached";
  id: string;
  timestamp: string;
  artifactIds: string[];
  filenames: string[];
}

/** Tool: display_artifact */
export interface DisplayArtifactEntry {
  type: "display_artifact";
  id: string;
  timestamp: string;
  artifactId: string;
}

/** Tool: workspace-planner */
export interface WorkspacePlannerEntry {
  type: "workspace_planner";
  id: string;
  timestamp: string;
  artifactId: string;
}

/**
 * Tool output for fsm-workspace-creator.
 *
 * The output structure is an MCP tool result containing the AgentResult envelope:
 * { result: { content: [{ type: "text", text: JSON }] } }
 *
 * The JSON text contains the full AgentResult with:
 * - agentId, timestamp, input, durationMs (envelope metadata)
 * - ok: true/false (success discriminant)
 * - data: FSMCreatorSuccessData (when ok: true)
 * - error: { reason: string } (when ok: false)
 */
export interface WorkspaceCreator {
  type: "workspace_creator";
  id: string;
  timestamp: string;
  output: { result: { content: Array<{ type: string; text?: string }>; isError?: boolean } };
}

/** Tool: connect_service */
export interface ConnectServiceEntry {
  type: "connect_service";
  id: string;
  timestamp: string;
  provider: string;
  metadata?: Record<string, unknown>;
}

/** Tool: table_output */
export interface TableOutputEntry {
  type: "table_output";
  id: string;
  timestamp: string;
  result: unknown;
}

/** Tool: intent */
export interface Intent {
  type: "intent";
  id: string;
  timestamp: string;
  content: string;
}

/** Generic/other tools */
export interface GenericToolEntry {
  type: "tool_call";
  id: string;
  timestamp: string;
  toolName: string;
}

/** Discriminated union of all output entry types */
export type OutputEntry =
  | RequestEntry
  | TextEntry
  | ReasoningEntry
  | ErrorEntry
  | CredentialLinkedEntry
  | ArtifactAttachedEntry
  | DisplayArtifactEntry
  | WorkspacePlannerEntry
  | WorkspaceCreator
  | ConnectServiceEntry
  | TableOutputEntry
  | Intent
  | GenericToolEntry;

/** Schema for MCP tool result outer structure (used by system agent tools) */
const MCPToolResultSchema = z.object({
  result: z.object({ content: z.array(z.object({ text: z.string() })) }),
});

/** Schema for MCP execution result envelope (wraps AgentResult) */
export const MCPExecutionResultSchema = z.object({
  type: z.literal("completed"),
  result: z.unknown(),
});

/** Schema for workspace-planner success data */
const WorkspacePlannerSuccessDataSchema = z.object({ artifactId: z.string() });

/**
 * Extract artifactId from workspace-planner's part.output.
 *
 * Supports the AgentResult envelope structure:
 * { agentId, timestamp, input, durationMs, ok: true, data: { artifactId } }
 */
export function parseWorkspacePlannerArtifactId(output: unknown): string | undefined {
  const outer = MCPToolResultSchema.safeParse(output);
  if (!outer.success) return undefined;

  const firstContent = outer.data.result.content[0];
  if (!firstContent) return undefined;

  try {
    const parsed = JSON.parse(firstContent.text);
    const executionResult = MCPExecutionResultSchema.safeParse(parsed);
    if (!executionResult.success) return undefined;

    const envelope = AgentResultSchema.safeParse(executionResult.data.result);
    if (envelope.success && envelope.data.ok) {
      const data = WorkspacePlannerSuccessDataSchema.safeParse(envelope.data.data);
      if (data.success) {
        return data.data.artifactId;
      }
    }
  } catch {
    // JSON parse failed
  }
  return undefined;
}
