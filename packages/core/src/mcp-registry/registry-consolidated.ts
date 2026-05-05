import process from "node:process";
import type { MCPServerMetadata, MCPServersRegistry } from "./schemas.ts";

/**
 * Google Workspace service definitions.
 * Each service runs its own workspace-mcp instance with `--tools` filtering
 * for tool isolation. Bearer tokens are pulled from per-service Link providers.
 */
type GoogleWorkspaceServiceSpec = {
  id: string;
  name: string;
  urlDomains: string[];
  urlEnvKey: string;
  defaultPort: number;
  toolFlag: string;
  description: string;
  constraints: string;
  /** Per-service additions to the workspace-mcp subprocess env. */
  extraStartupEnv?: Record<string, string>;
};
const GOOGLE_WORKSPACE_SERVICES: GoogleWorkspaceServiceSpec[] = [
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
      "Requires OAuth. Use for calendar queries, event creation, scheduling, meeting management. Bundled google-calendar agent provides high-level calendar operations. Launch: MCP_ENABLE_OAUTH21=true EXTERNAL_OAUTH21_PROVIDER=true WORKSPACE_MCP_STATELESS_MODE=true GOOGLE_OAUTH_CLIENT_ID=external GOOGLE_OAUTH_CLIENT_SECRET=external WORKSPACE_MCP_PORT=8001 uvx workspace-mcp --tools calendar --transport streamable-http",
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
      "Requires OAuth. This is the ONLY way to read email. For send-only notifications without OAuth, use the bundled email agent instead. Launch: MCP_ENABLE_OAUTH21=true EXTERNAL_OAUTH21_PROVIDER=true WORKSPACE_MCP_STATELESS_MODE=true GOOGLE_OAUTH_CLIENT_ID=external GOOGLE_OAUTH_CLIENT_SECRET=external WORKSPACE_MCP_PORT=8002 uvx workspace-mcp --tools gmail --transport streamable-http",
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
      "Requires OAuth. Use for file storage, searching, sharing, managing permissions, and document access. Launch: MCP_ENABLE_OAUTH21=true EXTERNAL_OAUTH21_PROVIDER=true WORKSPACE_MCP_STATELESS_MODE=true GOOGLE_OAUTH_CLIENT_ID=external GOOGLE_OAUTH_CLIENT_SECRET=external WORKSPACE_MCP_PORT=8003 uvx workspace-mcp --tools drive --transport streamable-http",
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
      "Requires OAuth. Use for document creation, editing, formatting, tables, images, and PDF export. Launch: MCP_ENABLE_OAUTH21=true EXTERNAL_OAUTH21_PROVIDER=true WORKSPACE_MCP_STATELESS_MODE=true GOOGLE_OAUTH_CLIENT_ID=external GOOGLE_OAUTH_CLIENT_SECRET=external WORKSPACE_MCP_PORT=8004 uvx workspace-mcp --tools docs --transport streamable-http",
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    urlDomains: ["docs.google.com"],
    urlEnvKey: "GOOGLE_SHEETS_MCP_URL",
    defaultPort: 8005,
    toolFlag: "sheets",
    description:
      "Read-only Google Sheets access via workspace-mcp — list spreadsheets, read cell values and ranges, get spreadsheet metadata. Write operations (create sheets, update cells, format) are not currently supported because the `spreadsheets` (write) scope is not in the verified GCP project Friday delegates OAuth through.",
    constraints:
      "Requires OAuth. Read-only — no cell writes, sheet creation, or formatting. Use when data lives in Google Sheets and you need to read it. For analyzing data already uploaded as CSV/database artifacts, use the data-analyst agent instead. Launch: MCP_ENABLE_OAUTH21=true EXTERNAL_OAUTH21_PROVIDER=true WORKSPACE_MCP_STATELESS_MODE=true GOOGLE_OAUTH_CLIENT_ID=external GOOGLE_OAUTH_CLIENT_SECRET=external WORKSPACE_MCP_PORT=8005 WORKSPACE_FEATURE_OVERRIDES=sheets.write:off uvx workspace-mcp --tools sheets --transport streamable-http",
    // sheets.write tools would 403 at runtime without the spreadsheets scope —
    // disable them at the MCP layer so they don't appear in the tool catalog.
    extraStartupEnv: { WORKSPACE_FEATURE_OVERRIDES: "sheets.write:off" },
  },
];

function createGoogleWorkspaceEntry(spec: GoogleWorkspaceServiceSpec): MCPServerMetadata {
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
        env: { WORKSPACE_MCP_PORT: String(spec.defaultPort), ...spec.extraStartupEnv },
        ready_url: defaultUrl,
      },
    },
    /* ────────────────────────────────────────────────────────────────
     *  DUMMY OAUTH CREDENTIALS — READ THIS BEFORE YOU PANIC
     * ────────────────────────────────────────────────────────────────
     *
     *  workspace-mcp requires GOOGLE_OAUTH_CLIENT_ID and
     *  GOOGLE_OAUTH_CLIENT_SECRET to be *present* at startup even when
     *  EXTERNAL_OAUTH21_PROVIDER=true (the mode where Friday supplies
     *  real access tokens via HTTP Bearer headers).
     *
     *  Why?  Two separate code paths check them:
     *
     *  1. auth/oauth_config.py — is_configured() returns false if either
     *     env var is missing, which causes the auth middleware to skip
     *     entirely → every tool call fails with "no authenticated user".
     *
     *  2. core/server.py — FastMCP's GoogleProvider constructor derives a
     *     JWT signing key from client_secret. Without it the server crashes
     *     at boot with "jwt_signing_key is required".
     *
     *  The *actual* Google API calls use the Bearer token from the request
     *  header (resolved by Link). These dummy values are NEVER sent to
     *  Google — they only satisfy workspace-mcp's internal validation.
     *
     *  In production Lukasz confirmed they use the exact same trick:
     *    GOOGLE_OAUTH_CLIENT_ID='external'
     *    GOOGLE_OAUTH_CLIENT_SECRET='external'
     *
     *  STATELESS_MODE is hygiene: it stops workspace-mcp from writing
     *  credential files to ~/.google_workspace_mcp/.
     * ──────────────────────────────────────────────────────────────── */
    platformEnv: {
      MCP_ENABLE_OAUTH21: "true",
      EXTERNAL_OAUTH21_PROVIDER: "true",
      WORKSPACE_MCP_STATELESS_MODE: "true",
      // DUMMY — see wall-of-text above. Real tokens come from Link via
      // Authorization: Bearer <access_token> on every HTTP request.
      GOOGLE_OAUTH_CLIENT_ID: "external",
      GOOGLE_OAUTH_CLIENT_SECRET: "external",
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
        transport: { type: "stdio", command: "uvx", args: ["mcp-server-time"] },
        tools: { allow: ["convert_time", "get_current_time"] },
      },
    },
    filesystem: {
      id: "filesystem",
      name: "Filesystem",
      description:
        "Local filesystem access via the official MCP filesystem server — read/write text and media files, list directories, build directory trees, search files by name, move/rename, edit files with line-based diffs. Scoped to the user's home directory.",
      constraints:
        "Scoped to ${HOME}. Cannot escape the user's home directory. Filename search only — does not search file contents (use a code-search agent for that). Note: filenames using NFD-normalized Unicode (some accented Latin / Cyrillic) may round-trip incorrectly on macOS — see modelcontextprotocol/servers#1970.",
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-filesystem", "${HOME}"],
        },
      },
    },
    // Google Workspace services (generated from GOOGLE_WORKSPACE_SERVICES)
    ...googleWorkspaceEntries,
  },
  metadata: { version: "2.2.0", lastUpdated: "2026-04-24" },
};
