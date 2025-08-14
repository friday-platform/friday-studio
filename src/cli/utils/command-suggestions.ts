import levenshtein from "js-levenshtein";

export interface CommandInfo {
  command: string;
  aliases?: string[];
  description: string;
}

// Define all available commands and their aliases
export const COMMANDS: CommandInfo[] = [
  {
    command: "workspace",
    aliases: ["work", "w"],
    description: "Manage Atlas workspaces",
  },
  {
    command: "session",
    aliases: ["sesh", "sess"],
    description: "Manage Atlas sessions",
  },
  {
    command: "signal",
    aliases: ["sig"],
    description: "Manage workspace signals",
  },
  { command: "agent", aliases: ["ag"], description: "Manage workspace agents" },
  {
    command: "library",
    aliases: ["lib"],
    description: "Manage library items and templates",
  },
  { command: "logs", aliases: ["log"], description: "View session logs" },
  {
    command: "ps",
    description: "List active sessions (alias for 'session list')",
  },
  {
    command: "version",
    aliases: ["v"],
    description: "Show Atlas version information",
  },
  { command: "help", aliases: ["h"], description: "Show help information" },
];

// Subcommands for each main command
export const SUBCOMMANDS: Record<string, CommandInfo[]> = {
  workspace: [
    { command: "init", description: "Initialize a new workspace" },
    { command: "serve", description: "Start workspace server" },
    { command: "status", description: "Show workspace status" },
    { command: "list", description: "List all workspaces" },
    { command: "stop", description: "Stop workspace server" },
    { command: "restart", description: "Restart workspace server" },
    { command: "remove", description: "Remove a workspace" },
  ],
  session: [
    { command: "list", description: "List active sessions" },
    { command: "get", description: "Get session details" },
    { command: "cancel", description: "Cancel a running session" },
  ],
  signal: [
    { command: "list", description: "List configured signals" },
    { command: "trigger", description: "Trigger a signal manually" },
    { command: "history", description: "Show signal history" },
  ],
  agent: [
    { command: "list", description: "List workspace agents" },
    { command: "describe", description: "Show agent details" },
    { command: "test", description: "Test an agent" },
  ],
  library: [
    { command: "list", description: "List library items" },
    { command: "search", description: "Search library content" },
    { command: "get", description: "Get library item details" },
    { command: "templates", description: "List available templates" },
    { command: "generate", description: "Generate content from template" },
    { command: "stats", description: "Show library statistics" },
  ],
};

/**
 * Find the closest matching command using Levenshtein distance
 */
export function findClosestCommand(
  input: string,
  commands: CommandInfo[],
  threshold = 3,
): CommandInfo[] {
  const suggestions: Array<{ command: CommandInfo; distance: number }> = [];

  for (const cmd of commands) {
    // Check main command
    const cmdDistance = levenshtein(
      input.toLowerCase(),
      cmd.command.toLowerCase(),
    );
    if (cmdDistance <= threshold) {
      suggestions.push({ command: cmd, distance: cmdDistance });
    }

    // Check aliases
    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        const aliasDistance = levenshtein(
          input.toLowerCase(),
          alias.toLowerCase(),
        );
        if (aliasDistance <= threshold) {
          suggestions.push({ command: cmd, distance: aliasDistance });
        }
      }
    }
  }

  // Sort by distance and remove duplicates
  const seen = new Set<string>();
  return suggestions
    .sort((a, b) => a.distance - b.distance)
    .filter((item) => {
      if (seen.has(item.command.command)) return false;
      seen.add(item.command.command);
      return true;
    })
    .slice(0, 3) // Return top 3 suggestions
    .map((item) => item.command);
}

/**
 * Format command suggestions for display
 */
export function formatSuggestions(suggestions: CommandInfo[]): string {
  if (suggestions.length === 0) return "";

  const lines = ["", "Did you mean?"];
  for (const cmd of suggestions) {
    let line = `  ${cmd.command}`;
    if (cmd.aliases && cmd.aliases.length > 0) {
      line += ` (aliases: ${cmd.aliases.join(", ")})`;
    }
    line += ` - ${cmd.description}`;
    lines.push(line);
  }
  lines.push("");
  lines.push("Run 'atlas --help' for available commands.");

  return lines.join("\n");
}

/**
 * Get all command aliases as a formatted string for help display
 */
export function getAliasesHelp(): string {
  const lines = ["", "Command Aliases:", ""];

  for (const cmd of COMMANDS) {
    if (cmd.aliases && cmd.aliases.length > 0) {
      lines.push(`  ${cmd.command} → ${cmd.aliases.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("Power User Tips:");
  lines.push("  • Use 'atlas ps' as a shortcut for 'atlas session list'");
  lines.push(
    "  • Most commands have smart defaults (e.g., 'atlas work' → 'atlas workspace serve')",
  );
  lines.push("  • Use --json flag on data commands for scripting");
  lines.push("  • Commands work from any directory with --workspace flag");

  return lines.join("\n");
}

/**
 * Check if a command exists (including aliases)
 */
export function isValidCommand(input: string): boolean {
  if (!input) return false;

  const lowerInput = input.toLowerCase();

  for (const cmd of COMMANDS) {
    if (cmd.command.toLowerCase() === lowerInput) return true;
    if (cmd.aliases?.some((alias) => alias.toLowerCase() === lowerInput)) {
      return true;
    }
  }

  return false;
}

/**
 * Resolve a command or alias to the actual command name
 */
export function resolveCommand(input: string): string | null {
  const lowerInput = input.toLowerCase();

  for (const cmd of COMMANDS) {
    if (cmd.command.toLowerCase() === lowerInput) return cmd.command;
    if (cmd.aliases?.some((alias) => alias.toLowerCase() === lowerInput)) {
      return cmd.command;
    }
  }

  return null;
}
