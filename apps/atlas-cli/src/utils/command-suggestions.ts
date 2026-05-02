import levenshtein from "js-levenshtein";

interface CommandInfo {
  command: string;
  aliases?: string[];
  description: string;
}

// Define all available commands and their aliases
export const COMMANDS: CommandInfo[] = [
  { command: "workspace", aliases: ["work", "w"], description: "Manage Atlas workspaces" },
  { command: "session", aliases: ["sesh", "sess"], description: "Manage Atlas sessions" },
  { command: "signal", aliases: ["sig"], description: "Manage workspace signals" },
  { command: "agent", aliases: ["ag"], description: "Manage workspace agents" },
  { command: "artifacts", aliases: ["artifact"], description: "Retrieve and manage artifacts" },
  { command: "daemon", aliases: ["d"], description: "Manage Atlas daemon" },
  { command: "logs", aliases: ["log"], description: "View session logs" },
  { command: "ps", description: "List active sessions (alias for 'session list')" },
  { command: "help", aliases: ["h"], description: "Show help information" },
];

/**
 * Find the closest matching command using Levenshtein distance
 */
export function findClosestCommand(
  input: string,
  commands: CommandInfo[],
  threshold = 3,
): CommandInfo[] {
  const distanceMap = new Map<string, { command: CommandInfo; distance: number }>();
  const lowerInput = input.toLowerCase();

  for (const cmd of commands) {
    // Check main command and all aliases, keep the best match
    let minDistance = levenshtein(lowerInput, cmd.command.toLowerCase());

    if (cmd.aliases) {
      for (const alias of cmd.aliases) {
        const aliasDistance = levenshtein(lowerInput, alias.toLowerCase());
        minDistance = Math.min(minDistance, aliasDistance);
      }
    }

    if (minDistance <= threshold) {
      distanceMap.set(cmd.command, { command: cmd, distance: minDistance });
    }
  }

  // Sort by distance and return top 3
  return Array.from(distanceMap.values())
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 3)
    .map((item) => item.command);
}

/**
 * Format command suggestions for display
 */
export function formatSuggestions(suggestions: CommandInfo[]): string {
  const lines = [""];

  if (suggestions.length > 0) {
    lines.push("Did you mean?");
    for (const cmd of suggestions) {
      let line = `  ${cmd.command}`;
      if (cmd.aliases && cmd.aliases.length > 0) {
        line += ` (aliases: ${cmd.aliases.join(", ")})`;
      }
      line += ` - ${cmd.description}`;
      lines.push(line);
    }
    lines.push("");
  }

  lines.push("Run 'atlas --help' for available commands.");
  return lines.join("\n");
}
