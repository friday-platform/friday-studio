import process from "node:process";
import type { MCPServerMetadata, MCPServersRegistry } from "./schemas.ts";

/**
 * Google Workspace service definitions.
 * All services use workspace-mcp with OAuth credentials injected at runtime.
 */
const GOOGLE_WORKSPACE_SERVICES = [
  {
    id: "google-gmail",
    name: "Gmail",
    domains: ["google-gmail", "gmail", "email", "inbox"],
    urlDomains: ["mail.google.com"],
    description:
      "Full Gmail management via OAuth - search messages, read content and attachments, send emails, create drafts, manage labels and filters, batch operations",
    constraints:
      "Requires OAuth. Use for reading inbox, searching messages, sending emails, creating drafts, managing labels/filters. For simple notifications without OAuth, use bundled email agent instead.",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    domains: ["google-drive", "drive", "gdrive", "files", "storage"],
    urlDomains: ["drive.google.com"],
    description:
      "Full Google Drive management via OAuth - search files, list folders, create/update files, manage sharing and permissions, get download URLs",
    constraints:
      "Requires OAuth. Use for file storage, searching, sharing, managing permissions, and document access.",
  },
  {
    id: "google-docs",
    name: "Google Docs",
    domains: ["google-docs", "docs", "documents"],
    urlDomains: ["docs.google.com"],
    description:
      "Full Google Docs management via OAuth - search docs, create documents, edit text, insert images/tables, find and replace, export to PDF",
    constraints:
      "Requires OAuth. Use for document creation, editing, formatting, tables, images, and PDF export.",
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    domains: ["google-sheets", "sheets", "spreadsheet", "spreadsheets"],
    urlDomains: ["docs.google.com"],
    description:
      "Full Google Sheets management via OAuth - list spreadsheets, read/write values, create sheets, format cells, conditional formatting",
    constraints:
      "Requires OAuth. Use for spreadsheet data, formulas, formatting, and conditional formatting.",
  },
] as const;

/**
 * Get Google Workspace MCP URL from environment.
 * Falls back to localhost for local development.
 */
function getGoogleWorkspaceMcpUrl(): string {
  return process.env.GOOGLE_WORKSPACE_MCP_URL || "http://localhost:8000/mcp";
}

function createGoogleWorkspaceEntry(
  spec: (typeof GOOGLE_WORKSPACE_SERVICES)[number],
): MCPServerMetadata {
  // Token env var: google-calendar -> GOOGLE_CALENDAR_ACCESS_TOKEN
  const tokenEnvKey = `${spec.id.toUpperCase().replace(/-/g, "_")}_ACCESS_TOKEN`;

  return {
    id: spec.id,
    name: spec.name,
    domains: [...spec.domains],
    urlDomains: [...spec.urlDomains],
    description: spec.description,
    constraints: spec.constraints,
    source: "static",
    securityRating: "high",
    configTemplate: {
      transport: { type: "http", url: getGoogleWorkspaceMcpUrl() },
      auth: { type: "bearer", token_env: tokenEnvKey },
      env: { [tokenEnvKey]: { from: "link", provider: spec.id, key: "access_token" } },
      client_config: { timeout: { progressTimeout: "60s", maxTotalTimeout: "30m" } },
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
 * with enhanced metadata including domains and requiredConfig
 */
export const mcpServersRegistry: MCPServersRegistry = {
  servers: {
    github: {
      id: "github",
      name: "GitHub",
      domains: ["github"],
      urlDomains: ["github.com", "githubusercontent.com"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://api.githubcopilot.com/mcp" },
        auth: { type: "bearer", token_env: "GH_CLASSIC_PAT" },
        env: { GH_CLASSIC_PAT: { from: "link", provider: "github", key: "access_token" } },
      },
      requiredConfig: [
        {
          key: "GH_CLASSIC_PAT",
          description: "GitHub Classic Personal Access Token.",
          type: "string",
          examples: ["ghp_XXXXXXXXX"],
        },
      ],
    },
    hubspot: {
      id: "hubspot",
      name: "HubSpot",
      domains: ["hubspot"],
      urlDomains: ["hubspot.com", "app.hubspot.com"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://mcp.hubspot.com" },
        auth: { type: "bearer", token_env: "HUBSPOT_ACCESS_TOKEN" },
        env: { HUBSPOT_ACCESS_TOKEN: { from: "link", provider: "hubspot", key: "access_token" } },
      },
      requiredConfig: [
        { key: "HUBSPOT_ACCESS_TOKEN", description: "HubSpot App Access Token.", type: "string" },
      ],
    },
    azure: {
      id: "azure",
      name: "Azure Services",
      domains: ["azure"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@azure/mcp@latest", "server", "start"],
        },
        tools: {
          allow: ["subscription", "group", "keyvault", "storage", "sql", "cosmos", "monitor"],
        },
        env: {
          AZURE_TENANT_ID: "your-tenant-id",
          AZURE_CLIENT_ID: "your-client-id",
          AZURE_CLIENT_SECRET: "your-client-secret",
        },
        client_config: { timeout: { progressTimeout: "120s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        {
          key: "AZURE_TENANT_ID",
          description: "Azure Active Directory tenant ID",
          type: "string",
          examples: ["00000000-0000-0000-0000-000000000000"],
        },
        {
          key: "AZURE_CLIENT_ID",
          description: "Azure service principal client ID",
          type: "string",
          examples: ["00000000-0000-0000-0000-000000000000"],
        },
        {
          key: "AZURE_CLIENT_SECRET",
          description: "Azure service principal client secret",
          type: "string",
        },
      ],
    },
    stripe: {
      id: "stripe",
      name: "Stripe Payments",
      domains: ["stripe"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "@stripe/mcp", "--tools=all"] },
        tools: {
          allow: [
            "create_customer",
            "list_customers",
            "create_invoice",
            "list_invoices",
            "list_subscriptions",
            "get_stripe_account_info",
          ],
        },
        env: { STRIPE_SECRET_KEY: "your-stripe-secret-key" },
        client_config: { timeout: { progressTimeout: "60s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        {
          key: "STRIPE_SECRET_KEY",
          description: "Stripe API secret key",
          type: "string",
          examples: ["sk_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
        },
      ],
    },
    playwright: {
      id: "playwright",
      name: "Playwright Browser Automation",
      domains: ["playwright", "browser", "web-scraping", "scraping"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@executeautomation/playwright-mcp-server"],
        },
        tools: { allow: ["navigate", "click", "type", "screenshot", "extract_text"] },
        client_config: { timeout: { progressTimeout: "120s", maxTotalTimeout: "30m" } },
      },
    },
    time: {
      id: "time",
      name: "Time & Timezone",
      domains: ["timekeeping", "timezone-conversion"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone"] },
        tools: { allow: ["convert_time", "get_current_time"] },
      },
    },
    weather: {
      id: "weather",
      name: "Weather Data Service",
      domains: ["weather"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "@timlukahorstmann/mcp-weather"] },
        tools: { allow: ["weather-get_hourly", "weather-get_daily"] },
        env: { ACCUWEATHER_API_KEY: "your-api-key" },
        client_config: { timeout: { progressTimeout: "30s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        { key: "ACCUWEATHER_API_KEY", description: "AccuWeather API key", type: "string" },
      ],
    },
    "google-genai-toolbox": {
      id: "google-genai-toolbox",
      name: "Google GenAI Toolbox",
      domains: ["google-genai"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "toolbox",
          args: ["--stdio", "--tools-file", "/path/to/tools.yaml"],
        },
        tools: { allow: ["load_toolset", "execute_query", "get_schema", "reload_tools"] },
        env: { TOOLBOX_CONFIG: "/path/to/tools.yaml" },
        client_config: { timeout: { progressTimeout: "90s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        {
          key: "TOOLBOX_CONFIG",
          description: "Path to toolbox configuration YAML file",
          type: "string",
        },
      ],
    },
    "google-analytics": {
      id: "google-analytics",
      name: "Google Analytics 4",
      domains: ["google-analytics"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "mcp-server-google-analytics"] },
        tools: { allow: ["runReport", "getPageViews", "getActiveUsers"] },
        env: {
          GOOGLE_CLIENT_EMAIL: "service-account@project.iam.gserviceaccount.com",
          GOOGLE_PRIVATE_KEY: "your-private-key",
          GA_PROPERTY_ID: "your-ga4-property-id",
        },
        client_config: { timeout: { progressTimeout: "90s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        {
          key: "GOOGLE_CLIENT_EMAIL",
          description: "Google service account email address",
          type: "string",
        },
        {
          key: "GOOGLE_PRIVATE_KEY",
          description: "Google service account private key",
          type: "string",
        },
        {
          key: "GA_PROPERTY_ID",
          description: "Google Analytics 4 property ID",
          type: "string",
          examples: ["123456789"],
        },
      ],
    },
    auth0: {
      id: "auth0",
      name: "Auth0 Identity Management",
      domains: ["auth0"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "@auth0/auth0-mcp-server", "run"],
        },
        tools: {
          allow: ["get_application", "list_applications", "list_logs", "get_tenant_settings"],
        },
        env: { DEBUG: "auth0-mcp" },
        client_config: { timeout: { progressTimeout: "90s", maxTotalTimeout: "30m" } },
      },
    },
    linear: {
      id: "linear",
      name: "Linear Project Management",
      domains: ["linear"],
      urlDomains: ["linear.app"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://mcp.linear.app/mcp" },
        auth: { type: "bearer", token_env: "LINEAR_ACCESS_TOKEN" },
        env: { LINEAR_ACCESS_TOKEN: { from: "link", provider: "linear", key: "access_token" } },
      },
      requiredConfig: [
        { key: "LINEAR_ACCESS_TOKEN", description: "Linear API access token", type: "string" },
      ],
    },
    atlassian: {
      id: "atlassian",
      name: "Atlassian (Jira & Confluence)",
      domains: ["jira", "atlassian", "confluence"],
      urlDomains: ["atlassian.net", "atlassian.com", "jira.com", "confluence.com"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://mcp.atlassian.com/v1/mcp" },
        auth: { type: "bearer", token_env: "ATLASSIAN_ACCESS_TOKEN" },
        env: {
          ATLASSIAN_ACCESS_TOKEN: { from: "link", provider: "atlassian", key: "access_token" },
        },
      },
      requiredConfig: [
        {
          key: "ATLASSIAN_ACCESS_TOKEN",
          description: "Atlassian API access token",
          type: "string",
        },
      ],
    },
    trello: {
      id: "trello",
      name: "Trello Board Management",
      domains: ["trello"],
      urlDomains: ["trello.com"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["@delorenj/mcp-server-trello"] },
        tools: {
          allow: [
            "list_boards",
            "get_lists",
            "get_cards_by_list_id",
            "add_card_to_list",
            "update_card_details",
          ],
        },
        env: { TRELLO_API_KEY: "your-api-key", TRELLO_TOKEN: "your-token" },
        client_config: { timeout: { progressTimeout: "60s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        { key: "TRELLO_API_KEY", description: "Trello API key", type: "string" },
        { key: "TRELLO_TOKEN", description: "Trello API token", type: "string" },
      ],
    },
    notion: {
      id: "notion",
      name: "Notion Workspace",
      domains: ["notion"],
      urlDomains: ["notion.so", "notion.site"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://mcp.notion.com/mcp" },
        auth: { type: "bearer", token_env: "NOTION_ACCESS_TOKEN" },
        env: { NOTION_ACCESS_TOKEN: { from: "link", provider: "notion", key: "access_token" } },
      },
      requiredConfig: [
        { key: "NOTION_ACCESS_TOKEN", description: "Notion API access token", type: "string" },
      ],
    },
    rss: {
      id: "rss",
      name: "RSS Feed Reader",
      domains: ["rss"],
      source: "static",
      securityRating: "low",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "rss-mcp"] },
        tools: { allow: ["get_feed"] },
        // Optional: set PRIORITY_RSSHUB_INSTANCE env var for preferred RSSHub instance
        client_config: { timeout: { progressTimeout: "30s", maxTotalTimeout: "5m" } },
      },
      requiredConfig: [],
    },
    posthog: {
      id: "posthog",
      name: "PostHog Analytics & Feature Flags",
      domains: ["posthog"],
      urlDomains: ["posthog.com", "app.posthog.com", "eu.posthog.com", "us.posthog.com"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://mcp.posthog.com/mcp" },
        auth: { type: "bearer", token_env: "POSTHOG_API_KEY" },
        env: { POSTHOG_API_KEY: { from: "link", provider: "posthog", key: "access_token" } },
      },
      requiredConfig: [{ key: "POSTHOG_API_KEY", description: "PostHog API key", type: "string" }],
    },
    sentry: {
      id: "sentry",
      name: "Sentry Error Tracking",
      domains: ["sentry"],
      urlDomains: ["sentry.io", "sentry.dev"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "http", url: "https://mcp.sentry.dev/mcp" },
        auth: { type: "bearer", token_env: "SENTRY_ACCESS_TOKEN" },
        env: { SENTRY_ACCESS_TOKEN: { from: "link", provider: "sentry", key: "access_token" } },
      },
      requiredConfig: [
        { key: "SENTRY_ACCESS_TOKEN", description: "Sentry API access token", type: "string" },
      ],
    },
    discord: {
      id: "discord",
      name: "Discord Bot Integration",
      domains: ["discord", "chat", "messaging", "community"],
      urlDomains: ["discord.com", "discord.gg"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "mcp-discord"] },
        auth: { type: "bearer", token_env: "DISCORD_TOKEN" },
        tools: {
          allow: [
            "discord_login",
            "discord_list_servers",
            "discord_get_server_info",
            "send_message",
            "read_messages",
          ],
        },
        env: { DISCORD_TOKEN: "your-discord-bot-token" },
        client_config: { timeout: { progressTimeout: "60s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        {
          key: "DISCORD_TOKEN",
          description:
            "Discord bot token from Developer Portal with Message Content Intent enabled. Minimum permissions: Send Messages, Read Message History, View Channel.",
          type: "string",
          examples: ["MTIzNDU2Nzg5MDEyMzQ1Njc4.XXXXXX.XXXXXXXXXXXXXXXXXXXXXXXXXXX"],
        },
      ],
    },
    // Google Workspace services (generated from GOOGLE_WORKSPACE_SERVICES)
    ...googleWorkspaceEntries,
  },
  metadata: { version: "2.0.0", lastUpdated: "2025-01-27" },
};

let _cachedIntegrationsPrompt: string | null = null;

/**
 * Returns a formatted string of available integrations for use in LLM prompts.
 * Lists each server with its recognized keywords (domains).
 *
 * Example output:
 * - Google Calendar: google-calendar, calendar, gcal
 * - Slack: slack
 *
 * Scaling: ~40 chars per server, ~800 chars for 20 servers.
 * For 100+ servers, consider semantic search or category-based injection.
 *
 * @returns List of integration names with their keywords
 */
export function getAvailableIntegrationsPrompt(): string {
  if (_cachedIntegrationsPrompt) return _cachedIntegrationsPrompt;
  const lines: string[] = [];
  for (const server of Object.values(mcpServersRegistry.servers)) {
    lines.push(`- ${server.name}: ${server.domains.join(", ")}`);
  }
  lines.sort((a, b) => a.localeCompare(b));
  _cachedIntegrationsPrompt = lines.join("\n");
  return _cachedIntegrationsPrompt;
}
