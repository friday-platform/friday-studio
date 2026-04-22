import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import type { Intent, OutputEntry, ReasoningEntry, ToolCallGroupEntry } from "./types.ts";
import { parseWorkspacePlannerArtifactId } from "./types.ts";

export function formatMessage(
  message: AtlasUIMessage,
  part: AtlasUIMessagePart,
): OutputEntry | undefined {
  if (message.role === "user") {
    if (part.type === "text") {
      return {
        type: "request",
        id: message.id,
        timestamp: new Date().toISOString(),
        content: String(part.text),
      };
    }
    // data-credential-linked is shown in sidebar progress, not in chat
    if (part.type === "data-credential-linked") {
      return undefined;
    }
    if (part.type === "data-artifact-attached") {
      return {
        type: "artifact_attached",
        id: message.id,
        timestamp: new Date().toISOString(),
        artifactIds: part.data.artifactIds ?? [],
        filenames: part.data.filenames ?? [],
        mimeTypes: part.data.mimeTypes,
      };
    }
  }

  if (message.role === "assistant") {
    if (part.type === "reasoning") {
      return {
        type: "reasoning",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: part.text,
      } satisfies ReasoningEntry;
    }
    if (part.type === "text") {
      return {
        type: "text",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: part.text,
      };
    }
    if (part.type === "tool-table_output") {
      return {
        type: "table_output",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        result: part.output,
      };
    }
    if (part.type === "tool-workspace-planner") {
      return {
        type: "workspace_planner",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        artifactId: parseWorkspacePlannerArtifactId(part.output) ?? "",
      };
    }
    if (part.type === "tool-connect_service") {
      if (part?.output?.error) return undefined;
      return {
        type: "connect_service",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        provider: part?.output?.provider ?? "",
      };
    }

    if (part.type === "tool-display_artifact") {
      if (part?.output?.displayed?.type === "workspace-plan") {
        return undefined;
      }
      return {
        type: "display_artifact",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        artifactId: part?.output?.artifactId ?? "",
      };
    }

    if (part.type === "tool-fsm-workspace-creator") {
      // Direct invocation format: { ok: true, data: { workspaceId, ... } }
      if (part.output?.ok === true && part.output?.data) {
        return {
          id: crypto.randomUUID(),
          type: "workspace_creator",
          timestamp: new Date().toISOString(),
          output: part.output,
        };
      }
      // MCP envelope format: { result: { content: [{ text: JSON }] } }
      if (part.output?.result?.content) {
        return {
          id: crypto.randomUUID(),
          type: "workspace_creator",
          timestamp: new Date().toISOString(),
          output: part.output,
        };
      }
    }

    // Step descriptions from do_task execution (e.g., "Explores your Notion workspace...")
    // Only step-start events have stepIndex — skip phase indicators like "Planning..."
    if (part.type === "data-tool-progress" && part.data.stepIndex != null) {
      return {
        type: "intent",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: part.data.content,
      };
    }

    // Inner tool calls from sub-agent execution (e.g., Notion searches inside do_task)
    if (part.type === "data-inner-tool-call") {
      // Only show completed calls — started events would duplicate entries
      if (part.data.status !== "completed") return undefined;
      const hasData = part.data.input || part.data.result;
      return {
        type: "intent",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: formatToolName(part.data.toolName),
        details: hasData
          ? {
              ...(part.data.input ? { input: part.data.input } : {}),
              ...(part.data.result ? { result: part.data.result } : {}),
            }
          : undefined,
      };
    }

    if (part.type === "tool-do_task") {
      const input = part.input;
      const intentText =
        input && typeof input === "object" && "intent" in input && typeof input.intent === "string"
          ? input.intent
          : undefined;
      return {
        type: "intent",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: "do_task",
        details: intentText ? { text: intentText } : part,
      };
    }

    // load_skill is an internal system tool — don't surface to users
    if (part.type === "tool-load_skill") {
      return undefined;
    }

    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      const toolName = "toolName" in part ? String(part.toolName) : part.type.replace("tool-", "");
      return {
        type: "intent",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: formatToolName(toolName),
        details: part,
      };
    }
    if (part.type.startsWith("tool-result-")) {
      return undefined;
    }
    if (part.type === "data-agent-timeout") {
      return {
        type: "error",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: part.data.error,
      };
    }
    if (part.type === "data-error") {
      return {
        type: "error",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: part.data.error,
      };
    }
    if (part.type === "tool-error") {
      return {
        type: "error",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: part.errorText ?? "Unknown tool error",
      };
    }

    if (part.type === "data-agent-error") {
      return {
        type: "error",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        content: part.data.error,
      };
    } else if (part.type === "data-intent") {
      return {
        id: crypto.randomUUID(),
        type: "intent",
        timestamp: new Date().toISOString(),
        content: part.data.content,
      };
    }
  }
}

/**
 * Extract action summary from message parts.
 * Prefers deterministic data event, falls back to legacy tool result.
 */
function extractActionSummary(parts: AtlasUIMessagePart[]): string | undefined {
  // Check for deterministic action summary (data event)
  for (const part of parts) {
    if (part.type === "data-action-summary") {
      return String(part.data?.summary ?? "");
    }
  }
  return undefined;
}

/**
 * Group consecutive intent entries into collapsible ToolCallGroupEntry items.
 * Non-intent entries pass through unchanged.
 */
export function groupToolCalls(
  entries: OutputEntry[],
  messageParts: AtlasUIMessagePart[],
): OutputEntry[] {
  const result: OutputEntry[] = [];
  let pendingIntents: Intent[] = [];

  function flushIntents() {
    if (pendingIntents.length === 0) return;

    const first = pendingIntents[0];
    if (!first) return;

    const summary = extractActionSummary(messageParts);
    const group: ToolCallGroupEntry = {
      type: "tool_call_group",
      id: crypto.randomUUID(),
      timestamp: first.timestamp,
      summary,
      items: pendingIntents,
    };
    result.push(group);
    pendingIntents = [];
  }

  for (const entry of entries) {
    if (entry.type === "intent") {
      pendingIntents.push(entry);
    } else {
      flushIntents();
      result.push(entry);
    }
  }
  flushIntents();

  return result;
}

function formatToolName(name: string): string {
  return name || "unknown";
}
