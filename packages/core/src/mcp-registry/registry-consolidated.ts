import process from "node:process";
import type { MCPServerMetadata, MCPServersRegistry } from "./schemas.ts";

/**
 * Google Workspace service definitions.
 * All services use workspace-mcp with OAuth credentials injected at runtime.
 *
 * Each service has its own MCP URL via `urlEnvKey` (e.g. GOOGLE_GMAIL_MCP_URL).
 * Server-side `--tools` filtering replaces client-side allowTools lists.
 */
const GOOGLE_WORKSPACE_SERVICES = [
  {
    id: "google-calendar",
    name: "Google Calendar",
    urlDomains: ["calendar.google.com"],
    urlEnvKey: "GOOGLE_CALENDAR_MCP_URL",
    description:
      "Full Google Calendar management via OAuth - list calendars, search events, create/modify/delete events, add attendees, create Google Meet links",
    constraints:
      "Requires OAuth. Use for calendar queries, event creation, scheduling, meeting management. Bundled google-calendar agent provides high-level calendar operations.",
  },
  {
    id: "google-gmail",
    name: "Gmail",
    urlDomains: ["mail.google.com"],
    urlEnvKey: "GOOGLE_GMAIL_MCP_URL",
    description:
      "Read and manage Gmail — search messages, read email content and attachments, send emails, create drafts, manage labels and filters. Full inbox access. This is the ONLY way to read email.",
    constraints:
      "Requires OAuth. This is the ONLY way to read email. For send-only notifications without OAuth, use the bundled email agent instead.",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    urlDomains: ["drive.google.com"],
    urlEnvKey: "GOOGLE_DRIVE_MCP_URL",
    description:
      "Full Google Drive management via OAuth - search files, list folders, create/update files, manage sharing and permissions, get download URLs",
    constraints:
      "Requires OAuth. Use for file storage, searching, sharing, managing permissions, and document access.",
  },
  {
    id: "google-docs",
    name: "Google Docs",
    urlDomains: ["docs.google.com"],
    urlEnvKey: "GOOGLE_DOCS_MCP_URL",
    description:
      "Full Google Docs management via OAuth - search docs, create documents, edit text, insert images/tables, find and replace, export to PDF",
    constraints:
      "Requires OAuth. Use for document creation, editing, formatting, tables, images, and PDF export.",
  },
  {
    id: "google-sheets",
    name: "Google Sheets",
    urlDomains: ["docs.google.com"],
    urlEnvKey: "GOOGLE_SHEETS_MCP_URL",
    description:
      "Full Google Sheets management via OAuth — list spreadsheets, read/write cell values, create sheets, format cells, conditional formatting.",
    constraints:
      "Requires OAuth. Use when data lives in Google Sheets. For analyzing data already uploaded as CSV/database artifacts, use the data-analyst agent instead.",
  },
];

function createGoogleWorkspaceEntry(
  spec: (typeof GOOGLE_WORKSPACE_SERVICES)[number],
): MCPServerMetadata {
  // Token env var: google-calendar -> GOOGLE_CALENDAR_ACCESS_TOKEN
  const tokenEnvKey = `${spec.id.toUpperCase().replace(/-/g, "_")}_ACCESS_TOKEN`;
  const url = process.env[spec.urlEnvKey] || "http://localhost:8000/mcp";

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
    hubspot: {
      id: "hubspot",
      name: "HubSpot",
      description:
        "HubSpot CRM via MCP — manage contacts, companies, deals, tickets, and marketing campaigns. Read and update CRM records, track sales pipelines, and automate marketing workflows.",
      constraints: "Requires OAuth. CRM and marketing operations only.",
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
      description:
        "Azure cloud management — subscriptions, resource groups, Key Vault, Storage, SQL, Cosmos DB, and monitoring. Read and manage Azure infrastructure resources.",
      constraints:
        "Requires Azure service principal credentials. Infrastructure management only — not for deploying code or running builds.",
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
      description:
        "Stripe payment processing — manage customers, invoices, subscriptions, and account info. Read billing data and create payment records.",
      constraints: "Requires Stripe API secret key. Financial data operations only.",
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
      description:
        "Browser automation via Playwright — navigate pages, click elements, fill forms, take screenshots, extract text from JS-rendered content.",
      constraints:
        "For general web research (searching for information), use the bundled research agent. Use Playwright for page interaction, form filling, JS-rendered scraping, and browser automation.",
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
    weather: {
      id: "weather",
      name: "Weather Data Service",
      description:
        "Weather forecasts and conditions — get hourly and daily weather data for any location via AccuWeather.",
      constraints: "Requires AccuWeather API key. Read-only weather data.",
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
      description:
        "Google GenAI Toolbox — load custom tool definitions from a YAML config, execute database queries, and manage tool schemas. For custom AI tool pipelines on Google Cloud.",
      constraints: "Requires toolbox config YAML. Custom tool execution only.",
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
      description:
        "Google Analytics 4 reporting — run analytics reports, get page views, active users, and traffic data for websites and apps.",
      constraints:
        "Requires Google service account credentials and GA4 property ID. Read-only analytics data.",
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
      description:
        "Auth0 identity management — list and inspect applications, view authentication logs, and read tenant settings. Monitor auth health and debug login issues.",
      constraints:
        "Read-only identity management. Cannot modify auth configurations or user accounts.",
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
      description:
        "Linear project management — read and manage issues, projects, cycles, and teams. Create issues, update status, track sprints, and search across the workspace.",
      constraints: "Requires OAuth. Project management operations only.",
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
      description:
        "Jira and Confluence via Atlassian MCP — manage Jira issues, boards, and sprints; read and edit Confluence pages and spaces.",
      constraints: "Requires OAuth. Jira and Confluence operations only.",
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
      description:
        "Trello board management — list boards, get cards and lists, create cards, and update card details. Lightweight project tracking and task management.",
      constraints: "Requires Trello API key and token. Board and card operations only.",
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
      description:
        "Notion workspace management — read and edit pages, databases, and blocks. Search content, create pages, and manage workspace structure.",
      constraints: "Requires OAuth. Notion workspace operations only.",
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
      description:
        "RSS feed reader — fetch and parse RSS/Atom feeds from any URL. Monitor news, blogs, and content updates.",
      constraints: "Read-only feed fetching. No authentication required.",
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
      description:
        "PostHog product analytics and feature flags — query events, view dashboards, manage feature flags, and analyze user behavior.",
      constraints: "Requires OAuth. Analytics and feature flag operations only.",
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
      description:
        "Sentry error tracking — search issues, view error details and stack traces, analyze performance traces, and manage issue status. Debug production errors and monitor application health.",
      constraints: "Requires OAuth. Error tracking and performance monitoring only.",
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
      description:
        "Discord bot integration — list servers, read messages, send messages, and get server info. Communicate via Discord channels and manage bot interactions.",
      constraints:
        "Requires Discord bot token with Message Content Intent. Bot-level access only — cannot manage server settings or roles.",
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
