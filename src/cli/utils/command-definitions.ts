export interface CommandDefinition {
  command: string;
  description: string;
}

export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  {
    command: "/help",
    description: "Show available commands and usage information",
  },
  {
    command: "/workspaces",
    description: "View available workspaces",
  },
  {
    command: "/init",
    description: "Initialize a new workspace",
  },
  {
    command: "/credits",
    description: "Show Atlas credits and acknowledgments",
  },
  {
    command: "/session",
    description: "View available workspace sessions",
  },
  {
    command: "/signal",
    description: "View available workspace signals",
  },
  {
    command: "/agent",
    description: "View workspace agents",
  },
  {
    command: "/library",
    description: "View workspace library",
  },
  {
    command: "/config",
    description: "Atlas configuration settings",
  },
  {
    command: "/version",
    description: "Show Atlas version information",
  },
  {
    command: "/clear",
    description: "Clear the output buffer",
  },
  {
    command: "/exit",
    description: "Exit the Atlas interactive interface",
  },
];
