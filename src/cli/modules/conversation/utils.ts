import type { ProcessedPart, UIMessagePart } from "./types.ts";

// Check if a part type should be skipped from display
export const shouldSkipPart = (type: string): boolean => {
  const skipTypes = [
    "data-connection",
    "data-session-start",
    "data-session-finish",
    "data-heartbeat",
    "step-start",
    "data-agent-finish",
  ];
  return skipTypes.includes(type);
};

// Map part type to display type for UI components
export const mapPartTypeToDisplayType = (type: string): ProcessedPart["type"] => {
  switch (type) {
    case "data-user-message":
      return "request";
    case "text":
      return "text";
    case "reasoning":
      return "reasoning";
    case "tool_call":
      return "tool_call";
    case "tool_result":
      return "tool_result";
    case "error":
      return "error";
    default:
      return "data";
  }
};

// Extract displayable content from a UIMessage part (from ai package)
export const extractPartContent = (part: UIMessagePart): string => {
  // Handle text parts
  if (part.type === "text") {
    return part.text;
  }

  // Handle reasoning parts
  if (part.type === "reasoning") {
    return part.text;
  }

  // Handle data parts (including user messages)
  if (part.type.startsWith("data-")) {
    const dataPart = part as Extract<UIMessagePart, { type: string; data: unknown }>;
    if ("data" in dataPart) {
      if (typeof dataPart.data === "string") return dataPart.data;
      if (typeof dataPart.data === "object") return JSON.stringify(dataPart.data, null, 2);
    }
  }

  // Handle tool parts
  if (part.type.startsWith("tool-")) {
    const toolPart = part as Extract<UIMessagePart, { type: string; result?: unknown }>;
    if ("result" in toolPart && toolPart.result) {
      return typeof toolPart.result === "string"
        ? toolPart.result
        : JSON.stringify(toolPart.result, null, 2);
    }
  }

  // Handle step-start
  if (part.type === "step-start") {
    return "";
  }

  return "";
};

// Check if a part is currently streaming
export const isPartStreamable = (part: UIMessagePart): boolean => {
  if (part.type === "text" || part.type === "reasoning") {
    return part.state === "streaming";
  }
  return false;
};

// Determine if a processed part should be displayed
export const shouldDisplayPart = (part: ProcessedPart): boolean => {
  // Tool calls and tool results should always display immediately when they arrive
  // They don't have streaming states and are complete by nature
  if (part.type === "tool_call" || part.type === "tool_result") {
    return part.content && part.content.trim() !== "";
  }

  // Error messages should also display immediately
  if (part.type === "error") {
    return part.content && part.content.trim() !== "";
  }

  // For text and reasoning parts, only display when complete (not streaming)
  // This prevents duplicates and partial content
  if (part.streamingState !== "complete") {
    return false;
  }

  // Don't display empty content
  if (!part.content || part.content.trim() === "") {
    return false;
  }

  // Display all complete parts with content
  return true;
};
