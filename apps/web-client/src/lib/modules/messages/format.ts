import type { AtlasUIMessage, AtlasUIMessagePart } from "@atlas/agent-sdk";
import type { OutputEntry, ReasoningEntry } from "./types.ts";
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
    if (part.type === "data-credential-linked") {
      return {
        type: "credential_linked",
        id: message.id,
        timestamp: new Date().toISOString(),
        provider: part.data?.provider ?? "",
        displayName: part.data?.displayName ?? "",
      };
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
      return {
        type: "connect_service",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        provider: part?.output?.provider ?? "",
      };
    }

    if (part.type === "tool-display_artifact") {
      return {
        type: "display_artifact",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        artifactId: part?.output?.artifactId ?? "",
      };
    }

    if (part.type === "tool-fsm-workspace-creator" && part.output?.result?.content) {
      return {
        id: crypto.randomUUID(),
        type: "workspace_creator",
        timestamp: new Date().toISOString(),
        output: part.output,
      };
    }

    if (part.type.startsWith("tool-") || part.type === "dynamic-tool") {
      return {
        type: "tool_call",
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        toolName: "toolName" in part ? part.toolName : part.type.replace("tool-", ""),
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
