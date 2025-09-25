// Output buffer entry that can hold different component types
export interface OutputEntry {
  id: string;
  type:
    | "text" // response
    | "thinking"
    | "request"
    | "finish"
    | "tool_call"
    | "tool_result"
    | "tool_error"
    | "selection_list"
    | "file_diff"
    | "directory_listing"
    | "error"
    | "header";
  author?: string;
  timestamp?: string;
  content?: string;
  currentlyStreaming?: boolean;
  metadata?: Record<string, unknown>;
}

// Command definition interface
export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
}
