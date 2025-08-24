export { Component } from "./component.tsx";
export { JobDetailsWithPath } from "./job-details-with-path.tsx";
export * from "./registry.ts";
export { SignalDetailsWithPath } from "./signal-details-with-path.tsx";
export * from "./types.ts";
export { WorkspaceSelection } from "./workspace-selection.tsx";

// Parse command arguments while preserving complex arguments
export const parseSlashCommand = (input: string) => {
  if (!input.startsWith("/")) {
    return null;
  }

  const trimmed = input.slice(1).trim();
  const args: string[] = [];
  let current = "";
  let inQuotes = false;
  let braceDepth = 0;
  let i = 0;

  while (i < trimmed.length) {
    const char = trimmed[i];

    if (char === '"' && braceDepth === 0) {
      inQuotes = !inQuotes;
      current += char;
    } else if (char === "{") {
      braceDepth++;
      current += char;
    } else if (char === "}") {
      braceDepth--;
      current += char;
    } else if (char === " " && !inQuotes && braceDepth === 0) {
      if (current.trim()) {
        args.push(current.trim());
        current = "";
      }
    } else {
      current += char;
    }
    i++;
  }

  if (current.trim()) {
    args.push(current.trim());
  }

  if (args.length === 0) {
    return null;
  }

  return { command: args[0]?.toLowerCase(), args: args.slice(1), rawInput: input };
};
