import React from "react";

// Output buffer entry that can hold different component types
export interface OutputEntry {
  id: string;
  component: React.ReactElement;
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
  handler: (args: string[], context: CommandContext) => OutputEntry[];
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
