/** biome-ignore-all lint/suspicious/noTemplateCurlyInString: mcp-remote requires ${} interpolation */
import type { MCPCategory, MCPServersRegistry } from "./schemas.ts";

/**
 * Consolidated MCP servers registry
 * Merges data from both blessedMCPServers and mcpServersRegistry
 * with enhanced metadata including domains and requiredConfig
 */
export const mcpServersRegistry: MCPServersRegistry = {
  servers: {
    "github-repos-manager": {
      id: "github-repos-manager",
      name: "GitHub Integration",
      category: "development",
      domains: ["github"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "github-repos-manager-mcp"] },
        auth: { type: "bearer", token_env: "GITHUB_TOKEN" },
        tools: {
          allow: [
            "list_repositories",
            "get_repository_info",
            "get_file_contents",
            "create_issue",
            "list_issues",
            "set_default_repository",
          ],
        },
        env: { GITHUB_TOKEN: "your-github-pat" },
        client_config: { timeout: { progressTimeout: "60s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        {
          key: "GITHUB_TOKEN",
          description: "GitHub Personal Access Token with appropriate permissions",
          type: "string",
          examples: ["ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"],
        },
      ],
    },
    azure: {
      id: "azure",
      name: "Azure Services",
      category: "cloud",
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
      category: "finance",
      domains: ["stripe"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "@stripe/mcp", "--tools=all"] },
        auth: { type: "api_key", token_env: "STRIPE_SECRET_KEY" },
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
      category: "testing",
      domains: ["automated testing", "ui automation", "screenshot generation"],
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
      category: "utility",
      domains: ["timekeeping", "timezone conversion"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: { type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone"] },
        tools: { allow: ["convert_time", "get_current_time"] },
      },
    },
    git: {
      id: "git",
      name: "Git Operations",
      category: "development",
      domains: ["git"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "uvx",
          args: ["mcp-server-git", "--repository", "/workspace"],
        },
        tools: { allow: ["git_status", "git_diff", "git_commit", "git_log"] },
        client_config: { timeout: { progressTimeout: "60s", maxTotalTimeout: "30m" } },
      },
    },
    weather: {
      id: "weather",
      name: "Weather Data Service",
      category: "utility",
      domains: ["weather"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["-y", "@timlukahorstmann/mcp-weather"] },
        auth: { type: "api_key", token_env: "ACCUWEATHER_API_KEY" },
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
      category: "development",
      domains: ["google genai"],
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
      category: "analytics",
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
      category: "security",
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
      category: "project-management",
      domains: ["linear"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "mcp-remote", "https://mcp.linear.app/mcp"],
        },
      },
    },
    trello: {
      id: "trello",
      name: "Trello Board Management",
      category: "project-management",
      domains: ["trello"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["@delorenj/mcp-server-trello"] },
        auth: { type: "api_key", token_env: "TRELLO_API_KEY" },
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
      category: "content",
      domains: ["notion"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "mcp-remote", "https://mcp.notion.com/mcp"],
        },
      },
    },
    rss: {
      id: "rss",
      name: "RSS Feed Management",
      category: "content",
      domains: ["rss"],
      source: "static",
      securityRating: "medium",
      configTemplate: {
        transport: { type: "stdio", command: "npx", args: ["mcp_rss"] },
        tools: { allow: ["get_content", "get_sources", "set_tag"] },
        env: {
          DB_HOST: "localhost",
          DB_PORT: "3306",
          DB_USERNAME: "root",
          DB_PASSWORD: "your-password",
          DB_DATABASE: "mcp_rss",
          OPML_FILE_PATH: "/path/to/your/feeds.opml",
          RSS_UPDATE_INTERVAL: "60",
        },
        client_config: { timeout: { progressTimeout: "30s", maxTotalTimeout: "30m" } },
      },
      requiredConfig: [
        { key: "DB_HOST", description: "Database host address", type: "string" },
        {
          key: "DB_PORT",
          description: "Database port number",
          type: "string",
          examples: ["3306", "5432"],
        },
        { key: "DB_USERNAME", description: "Database username", type: "string" },
        { key: "DB_PASSWORD", description: "Database password", type: "string" },
        { key: "DB_DATABASE", description: "Database name", type: "string" },
        { key: "OPML_FILE_PATH", description: "Path to OPML feed file", type: "string" },
        {
          key: "RSS_UPDATE_INTERVAL",
          description: "Feed update interval in minutes",
          type: "string",
          examples: ["60", "120"],
        },
      ],
    },
    posthog: {
      id: "posthog",
      name: "PostHog Analytics & Feature Flags",
      category: "analytics",
      domains: ["posthog"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: [
            "-y",
            "mcp-remote",
            "https://mcp.posthog.com/sse",
            "--header",
            "Authorization: Bearer ${POSTHOG_API_KEY}",
          ],
        },
        env: { POSTHOG_API_KEY: "your-posthog-api-key" },
      },
      requiredConfig: [{ key: "POSTHOG_API_KEY", description: "PostHog API key", type: "string" }],
    },
    sentry: {
      id: "sentry",
      name: "Sentry Error Tracking",
      category: "development",
      domains: ["sentry"],
      source: "static",
      securityRating: "high",
      configTemplate: {
        transport: {
          type: "stdio",
          command: "npx",
          args: ["-y", "mcp-remote", "https://mcp.sentry.dev/mcp"],
        },
      },
    },
    discord: {
      id: "discord",
      name: "Discord Bot Integration",
      category: "communication",
      domains: ["discord", "chat", "messaging", "community"],
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
  },
  categories: [
    "development",
    "cloud",
    "analytics",
    "automation",
    "communication",
    "testing",
    "security",
    "content",
    "finance",
    "utility",
    "database",
    "project-management",
    "monitoring",
  ] as MCPCategory[],
  metadata: { version: "2.0.0", lastUpdated: "2025-01-27", totalServers: 17 },
};
