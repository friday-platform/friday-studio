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
}

// Command context for handlers
export interface CommandContext {
  addEntry: (entry: OutputEntry) => void;
}

// Command definition interface
export interface CommandDefinition {
  name: string;
  description: string;
  usage: string;
  handler: (
    args: string[],
    context: CommandContext,
  ) => Map<string, OutputEntry>;
}

// Parse command arguments while preserving complex arguments
export interface ParsedCommand {
  command: string;
  args: string[];
  rawInput: string;
}

export interface ConversationEntry {
  id: string;
  type: "user" | "system" | "command_output" | "error" | "intro";
  content: string;
  timestamp: Date;
}
