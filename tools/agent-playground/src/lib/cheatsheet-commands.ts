/** CLI cheatsheet command definitions, grouped by category with page context. */

export interface CheatsheetCommand {
  /** The CLI command string (will be displayed in monospace) */
  command: string;
  /** Short description of what the command does */
  description: string;
  /**
   * Which pages this command is relevant to (empty = global/all pages).
   *
   * Supports two matching modes:
   * - `/path` — prefix match (e.g. `/platform` matches `/platform/foo/bar`)
   * - `~/segment` — matches if the pathname contains `/segment` anywhere
   *   (e.g. `~/sessions` matches `/platform/silky_grape/sessions`)
   */
  pages: string[];
  /** When true, only show "Copy" — never offer "Run" in the terminal. */
  copyOnly?: boolean;
}

export interface CheatsheetCategory {
  /** Category display name */
  name: string;
  /** Commands in this category */
  commands: CheatsheetCommand[];
}

/**
 * Match pages by prefix or segment. An empty pages array means global.
 * Returns true if the command should show on the given pathname.
 */
export function isRelevant(command: CheatsheetCommand, pathname: string): boolean {
  if (command.pages.length === 0) return true;
  return command.pages.some((p) => matchPage(p, pathname));
}

/**
 * Relevance score for sorting — higher = more specific match.
 * - 2 = segment match (`~/section` matches current page)
 * - 1 = prefix match (`/platform` matches current page)
 * - 0 = global or no match
 */
export function relevanceScore(command: CheatsheetCommand, pathname: string): number {
  if (command.pages.length === 0) return 0;
  let best = 0;
  for (const p of command.pages) {
    if (p.startsWith("~/") && pathname.includes(p.slice(1))) {
      best = Math.max(best, 2);
    } else if (!p.startsWith("~/") && pathname.startsWith(p)) {
      best = Math.max(best, 1);
    }
  }
  return best;
}

function matchPage(pattern: string, pathname: string): boolean {
  if (pattern.startsWith("~/")) {
    return pathname.includes(pattern.slice(1));
  }
  return pathname.startsWith(pattern);
}

export const categories: CheatsheetCategory[] = [
  {
    name: "Sessions",
    commands: [
      {
        command: "atlas ps",
        description: "List active sessions",
        pages: ["~/sessions", "/platform"],
      },
      {
        command: "atlas ps --json",
        description: "List sessions as JSON",
        pages: ["~/sessions", "/platform"],
      },
      {
        command: "atlas session get <id>",
        description: "Get session details",
        pages: ["~/sessions", "/platform"],
      },
      {
        command: "atlas session cancel <id>",
        description: "Cancel a running session",
        pages: ["~/sessions", "/platform"],
      },
    ],
  },
  {
    name: "Signals & Jobs",
    commands: [
      {
        command: "atlas signal list -w <id>",
        description: "List configured signals",
        pages: ["~/jobs", "/platform"],
      },
      {
        command: "atlas signal trigger -n <name>",
        description: "Trigger a signal",
        pages: ["~/jobs", "/platform"],
      },
      {
        command: `atlas signal trigger -n <name> --data '{"key":"value"}'`,
        description: "Trigger signal with payload",
        pages: ["~/jobs", "/platform"],
      },
      {
        command: "atlas signal trigger -n <name> --all",
        description: "Trigger signal on all workspaces",
        pages: ["~/jobs", "/platform"],
      },
    ],
  },
  {
    name: "Skills",
    commands: [
      {
        command: "atlas skill list",
        description: "List published skills",
        pages: ["/skills", "~/skills"],
      },
      {
        command: "atlas skill list -n tempest",
        description: "List skills in a namespace",
        pages: ["/skills", "~/skills"],
      },
      {
        command: "atlas skill get -n @tempest/pr-code-review",
        description: "Get skill details",
        pages: ["/skills", "~/skills"],
      },
      {
        command: "atlas skill publish -p ./my-skill",
        description: "Publish a skill from a directory",
        pages: ["/skills", "~/skills"],
      },
      {
        command: "atlas skill publish -p . -n @tempest/my-skill",
        description: "Publish with explicit name (overrides frontmatter)",
        pages: ["/skills", "~/skills"],
      },
      {
        command: "atlas skill versions -n @tempest/pr-code-review",
        description: "List all versions of a skill",
        pages: ["/skills", "~/skills"],
      },
    ],
  },
  {
    name: "Agents",
    commands: [
      {
        command: "atlas agent list",
        description: "List configured agents",
        pages: ["/agents", "~/agents"],
      },
      {
        command: "atlas agent describe <name>",
        description: "View agent configuration",
        pages: ["/agents", "~/agents"],
      },
    ],
  },
  {
    name: "Workspaces",
    commands: [
      {
        command: "atlas workspace list",
        description: "List registered workspaces",
        pages: ["/inspector", "/platform"],
      },
      {
        command: "atlas workspace add -p ~/path/to/workspace",
        description: "Register a workspace directory",
        pages: ["/inspector", "/platform"],
      },
      {
        command: "atlas workspace add --scan ~/code",
        description: "Scan a directory tree for workspace.yml files",
        pages: ["/inspector", "/platform"],
      },
      {
        command: "atlas workspace status -w <id>",
        description: "Show workspace config and status",
        pages: ["/inspector", "/platform"],
      },
      {
        command: "atlas workspace cleanup",
        description: "Remove workspaces with missing directories",
        pages: ["/inspector", "/platform"],
      },
    ],
  },
  {
    name: "Chat & Prompts",
    commands: [
      {
        command: 'atlas prompt "your message"',
        description: "Send a prompt to Friday",
        pages: ["/agents"],
      },
      {
        command: 'atlas prompt "follow up" --chat <id>',
        description: "Continue an existing chat",
        pages: ["/agents"],
      },
      { command: "atlas chat", description: "List recent chats", pages: ["/agents"] },
      {
        command: "atlas chat <id> --human",
        description: "View chat transcript (readable)",
        pages: ["/agents"],
      },
      {
        command: "atlas chat <id> --show-prompts",
        description: "View chat with system prompt context",
        pages: ["/agents"],
      },
    ],
  },
  {
    name: "Logs",
    commands: [
      {
        command: "atlas logs --since 5m --human",
        description: "Recent logs (human-readable)",
        pages: [],
      },
      { command: "atlas logs --level error", description: "Error logs only", pages: [] },
      {
        command: "atlas logs --session <id>",
        description: "Logs for a specific session",
        pages: ["~/sessions", "/platform"],
      },
      {
        command: "atlas logs --chat <id>",
        description: "Logs for a specific chat",
        pages: ["/agents"],
      },
    ],
  },
  {
    name: "Daemon",
    commands: [
      { command: "atlas daemon status", description: "Check if daemon is running", pages: [] },
      {
        command: "atlas daemon start --detached",
        description: "Start daemon in background",
        pages: [],
        copyOnly: true,
      },
      {
        command: "atlas daemon stop",
        description: "Stop the running daemon",
        pages: [],
        copyOnly: true,
      },
      { command: "atlas daemon restart", description: "Restart daemon", pages: [], copyOnly: true },
    ],
  },
  {
    name: "Development",
    commands: [
      {
        command: "deno task dev",
        description: "Start full dev environment (daemon + link + ledger + web)",
        pages: [],
      },
      { command: "deno task typecheck", description: "Type check everything", pages: [] },
      { command: "deno task lint", description: "Lint and auto-fix", pages: [] },
      { command: "deno task test", description: "Run tests", pages: [] },
    ],
  },
];
