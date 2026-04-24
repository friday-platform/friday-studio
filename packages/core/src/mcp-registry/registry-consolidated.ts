import process from "node:process";
import type { MCPServerMetadata, MCPServersRegistry } from "./schemas.ts";

/**
 * Google Workspace service definitions.
 * Each service runs its own workspace-mcp HTTP instance on a dedicated port
 * with `--tools` filtering for tool isolation. Bearer tokens from per-service
 * Link providers authenticate each connection. Servers auto-start via the
 * `startup` field in their config template.
 */
const GOOGLE_WORKSPACE_SERVICES = [
  {
    id: "google-calendar",
    name: "Google Calendar",
    urlDomains: ["calendar.google.com"],
    urlEnvKey: "GOOGLE_CALENDAR_MCP_URL",
    defaultPort: 8001,
    toolFlag: "calendar",
    description:
      "Full Google Calendar management via workspace-mcp — list calendars, search events, create/modify/delete events, add attendees, create Google Meet links",
    constraints:
      "Requires OAuth. Use for calendar queries, event creation, scheduling, meeting management.",
  },
  {
    id: "google-gmail",
    name: "Gmail",
    urlDomains: ["mail.google.com"],
    urlEnvKey: "GOOGLE_GMAIL_MCP_URL",
    defaultPort: 8002,
    toolFlag: "gmail",
    description:
      "Read and manage Gmail via workspace-mcp — search messages, read email content and attachments, send emails, create drafts, manage labels and filters. Full inbox access. This is the ONLY way to read email.",
    constraints:
      "Requires OAuth. This is the ONLY way to read email. For send-only notifications without OAuth, use the bundled email agent instead.",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    urlDomains: ["drive.google.com"],
    urlEnvKey: "GOOGLE_DRIVE_MCP_URL",
    defaultPort: 8003,
    toolFlag: "drive",
    description:
      "Full Google Drive management via workspace-mcp — search files, list folders, create/update files, manage sharing and permissions, get download URLs",
    constraints:
      "Requires OAuth. Use for file storage, searching, sharing, managing permissions, and document access.",
  },
  {
    id: "google-docs",
    name: "Google Docs",
    urlDomains: ["docs.google.com"],
    urlEnvKey: "GOOGLE_DOCS_MCP_URL",
    defaultPort: 8004,
    toolFlag: "docs",
    description:
      "Full Google Docs management via workspace-mcp — search docs, create documents, edit text, insert images/tables, find and replace, export to PDF",
    constraints:
      "Requires OAuth. Use for document creation, editing, formatting, tables, images, and PDF export.",
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    urlDomains: ["docs.google.com"],
    urlEnvKey: "GOOGLE_SHEETS_MCP_URL",
    defaultPort: 8005,
    toolFlag: "sheets",
    description:
      "Full Google Sheets management via workspace-mcp — list spreadsheets, read/write cell values, create sheets, format cells, conditional formatting.",
    constraints:
      "Requires OAuth. Use when data lives in Google Sheets. For analyzing data already uploaded as CSV/database artifacts, use the data-analyst agent instead.",
  },
];

function createGoogleWorkspaceEntry(
  spec: (typeof GOOGLE_WORKSPACE_SERVICES)[number],
): MCPServerMetadata {
  // Token env var: google-calendar -> GOOGLE_CALENDAR_ACCESS_TOKEN
  const tokenEnvKey = `${spec.id.toUpperCase().replace(/-/g, "_")}_ACCESS_TOKEN`;
  const defaultUrl = `http://localhost:${spec.defaultPort}/mcp`;
  const url = process.env[spec.urlEnvKey] || defaultUrl;

  return {
    id: spec.id,
    name: spec.name,
    urlDomains: [...spec.urlDomains],
    description: spec.description,
    constraints: spec.constraints,
    source: "static",
    securityRating: "high",
    configTemplate: {
      transport: { type: "http", url },
      auth: { type: "bearer", token_env: tokenEnvKey },
      env: { [tokenEnvKey]: { from: "link", provider: spec.id, key: "access_token" } },
      client_config: { timeout: { progressTimeout: "60s", maxTotalTimeout: "30m" } },
      startup: {
        type: "command",
        command: "uvx",
        args: ["workspace-mcp", "--tools", spec.toolFlag, "--transport", "streamable-http"],
        env: {
          GOOGLE_OAUTH_CLIENT_ID:
            "406964657835-aq8lmia8j95dhl1a2bvharmfk3t1hgqj.apps.googleusercontent.com",
          GOOGLE_OAUTH_CLIENT_SECRET: "kSmqreRr0qwBWJgbf5Y-PjSU",
          MCP_ENABLE_OAUTH21: "true",
          EXTERNAL_OAUTH21_PROVIDER: "true",
          WORKSPACE_MCP_PORT: String(spec.defaultPort),
        },
        ready_url: defaultUrl,
      },
    },
    requiredConfig: [
      { key: tokenEnvKey, description: `${spec.name} access token from Link`, type: "string" },
    ],
  };
}

const googleWorkspaceEntries = Object.fromEntries(
  GOOGLE_WORKSPACE_SERVICES.map((spec) => [spec.id, createGoogleWorkspaceEntry(spec)]),
) as Record<string, MCPServerMetadata>;

/**
 * Consolidated MCP servers registry
 * Merges data from both blessedMCPServers and mcpServersRegistry
 * with enhanced metadata including requiredConfig
 */
export const mcpServersRegistry: MCPServersRegistry = {
  servers: {
    github: {
      id: "github",
      name: "GitHub",
      description:
        "GitHub API via MCP — read and manage repositories, pull requests, issues, commits, code search, and reviews. USE FOR: listing merged PRs, reading issue threads, searching code, creating issues, commenting on PRs, reviewing repository activity.",
      constraints:
        "GitHub API operations only. Cannot clone repos, edit code files, run builds, or execute shell commands. For codebase work (cloning, editing files, running tests, debugging code), use the claude-code agent.",
      urlDomains: ["github.com", "githubusercontent.com"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://api.githubcopilot.com/mcp" },
        auth: { type: "bearer", token_env: "GH_TOKEN" },
        env: { GH_TOKEN: { from: "link", provider: "github", key: "access_token" } },
      },
      requiredConfig: [
        { key: "GH_TOKEN", description: "GitHub App installation token.", type: "string" },
      ],
    },
    time: {
      id: "time",
      name: "Time & Timezone",
      description:
        "Time and timezone utilities — get current time in any timezone, convert between timezones. Useful when tasks need precise time-aware scheduling or coordination across regions.",
      constraints: "Read-only time queries. No scheduling or calendar operations.",
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone"] },
        tools: { allow: ["convert_time", "get_current_time"] },
      },
    },
    // Google Workspace services (generated from GOOGLE_WORKSPACE_SERVICES)
    ...googleWorkspaceEntries,
  },
  metadata: { version: "2.2.0", lastUpdated: "2026-04-24" },
};
