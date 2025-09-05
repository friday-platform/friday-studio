import type { MCPServerConfig } from "@atlas/config";

type RegistryItem = {
  id: string;
  name: string;
  description: string;
  domains: string[];
  tools: { name: string; description: string }[];
  config: MCPServerConfig;
  documentation: string;
  repository: string;
  package: string;
};

/**
 * Registry of available MCP servers
 */
export const blessedMCPServers: Record<string, RegistryItem> = {
  "github-repos-manager": {
    id: "github-repos-manager",
    name: "GitHub Integration",
    description: "GitHub repository automation with 89 tools. Uses GitHub personal access tokens.",
    domains: ["github"],
    tools: [
      { name: "list_repositories", description: "List accessible repositories" },
      { name: "get_repository_info", description: "Get repository information" },
      { name: "create_issue", description: "Create GitHub issues" },
      { name: "list_issues", description: "List GitHub issues" },
      { name: "create_pull_request", description: "Create pull requests" },
      { name: "get_file_contents", description: "Get file contents from GitHub repository" },
    ],
    config: {
      transport: { type: "stdio", command: "npx", args: ["-y", "github-repos-manager-mcp"] },
      auth: { type: "bearer", token_env: "GITHUB_TOKEN" },
      env: { GITHUB_TOKEN: "your-github-pat" },
    },
    documentation: "https://github.com/some-repo/github-repos-manager-mcp",
    repository: "https://github.com/some-repo/github-repos-manager-mcp",
    package: "github-repos-manager-mcp",
  },
  azure: {
    id: "azure",
    name: "Azure Services",
    description:
      "Microsoft Azure MCP Server with 30+ Azure services. Uses Azure CLI and service principals.",

    tools: [
      { name: "subscription", description: "Azure subscription management" },
      { name: "group", description: "Resource group management" },
      { name: "keyvault", description: "Key Vault secrets and certificates" },
      { name: "storage", description: "Storage accounts and blob containers" },
      { name: "sql", description: "Azure SQL databases and servers" },
      { name: "monitor", description: "Azure Monitor logs and metrics" },
    ],
    domains: ["azure"],
    config: {
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@azure/mcp@latest", "server", "start"],
      },
      env: {
        AZURE_TENANT_ID: "your-tenant-id",
        AZURE_CLIENT_ID: "your-client-id",
        AZURE_CLIENT_SECRET: "your-client-secret",
      },
    },
    documentation: "https://docs.microsoft.com/azure/mcp",
    repository: "https://github.com/microsoft/azure-mcp",
    package: "@azure/mcp",
  },
  stripe: {
    id: "stripe",
    name: "Stripe Payments",
    description:
      "Stripe MCP server for payments, subscriptions, and financial data. Uses Stripe API keys.",
    tools: [
      { name: "create_customer", description: "Create new customer profiles" },
      { name: "list_customers", description: "Retrieve customer lists with filtering" },
      { name: "create_invoice", description: "Generate new invoices" },
      { name: "list_invoices", description: "Retrieve invoice collections" },
      { name: "create_subscription", description: "Set up new recurring billing" },
      { name: "list_subscriptions", description: "Retrieve subscription data" },
    ],
    domains: ["stripe"],
    config: {
      transport: { type: "stdio", command: "npx", args: ["-y", "@stripe/mcp", "--tools=all"] },
      auth: { type: "api_key", token_env: "STRIPE_SECRET_KEY" },
      env: { STRIPE_SECRET_KEY: "your-stripe-secret-key" },
    },
    documentation: "https://stripe.com/docs/mcp",
    repository: "https://github.com/stripe/mcp",
    package: "@stripe/mcp",
  },
  playwright: {
    id: "playwright",
    name: "Playwright Browser Automation",
    description:
      "Browser automation using Playwright for web page interaction, testing, and screenshot capture.",
    tools: [
      { name: "Playwright_navigate", description: "Navigate to web pages" },
      { name: "Playwright_click", description: "Click on web elements" },
      { name: "Playwright_fill", description: "Fill form inputs" },
      { name: "Playwright_screenshot", description: "Capture page screenshots" },
      { name: "playwright_get_visible_text", description: "Extract visible text content" },
    ],
    domains: ["automated testing", "ui automation", "screenshot generation"],
    config: {
      transport: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@executeautomation/playwright-mcp-server"],
      },
    },
    documentation: "https://github.com/executeautomation/playwright-mcp-server",
    repository: "https://github.com/executeautomation/playwright-mcp-server",
    package: "@executeautomation/playwright-mcp-server",
  },
  time: {
    id: "time",
    name: "Time & Timezone",
    description:
      "Time operations for scheduling and coordination. Timezone conversion and current time.",

    tools: [
      { name: "get_current_time", description: "Get current time in specified IANA timezone" },
      { name: "convert_time", description: "Convert time between timezones with DST support" },
    ],
    domains: ["timekeeping", "timezone conversion"],
    config: {
      transport: { type: "stdio", command: "uvx", args: ["mcp-server-time", "--local-timezone"] },
      tools: { allow: ["convert_time", "get_current_time"] },
    },
    documentation: "https://github.com/some-repo/mcp-server-time",
    repository: "https://github.com/some-repo/mcp-server-time",
    package: "mcp-server-time",
  },
  git: {
    id: "git",
    name: "Git Operations",
    description: "Git repository operations. Version control automation for workspaces.",

    tools: [
      { name: "git_status", description: "Check working directory status" },
      { name: "git_diff", description: "Compare commits/branches" },
      { name: "git_commit", description: "Create commits" },
      { name: "git_log", description: "View commit history" },
      { name: "git_create_branch", description: "Create new branches" },
    ],
    domains: ["git"],
    config: {
      transport: {
        type: "stdio",
        command: "uvx",
        args: ["mcp-server-git", "--repository", "/workspace"],
      },
    },
    documentation: "https://github.com/some-repo/mcp-server-git",
    repository: "https://github.com/some-repo/mcp-server-git",
    package: "mcp-server-git",
  },
  weather: {
    id: "weather",
    name: "Weather Data Service",
    description:
      "Weather forecasts using AccuWeather API. Hourly and daily weather data for any location.",

    tools: [
      { name: "weather-get_hourly", description: "Get 12-hour weather forecast" },
      { name: "weather-get_daily", description: "Get daily weather forecast" },
    ],
    domains: ["weather"],
    config: {
      transport: { type: "stdio", command: "npx", args: ["-y", "@timlukahorstmann/mcp-weather"] },
      auth: { type: "api_key", token_env: "ACCUWEATHER_API_KEY" },
      env: { ACCUWEATHER_API_KEY: "your-api-key" },
    },
    documentation: "https://github.com/timlukahorstmann/mcp-weather",
    repository: "https://github.com/timlukahorstmann/mcp-weather",
    package: "@timlukahorstmann/mcp-weather",
  },
  "google-genai-toolbox": {
    id: "google-genai-toolbox",
    name: "Google GenAI Toolbox",
    description:
      "Database toolbox connecting AI apps to databases. Centralized tool management and observability.",

    tools: [
      { name: "load_toolset", description: "Load tool configuration sets" },
      { name: "execute_query", description: "Execute database queries" },
      { name: "get_schema", description: "Get database schema information" },
    ],
    domains: ["google genai"],
    config: {
      transport: {
        type: "stdio",
        command: "toolbox",
        args: ["--stdio", "--tools-file", "/path/to/tools.yaml"],
      },
      env: { TOOLBOX_CONFIG: "/path/to/tools.yaml" },
    },
    documentation: "https://github.com/google/genai-toolbox",
    repository: "https://github.com/google/genai-toolbox",
    package: "mcp-toolbox",
  },
  "google-analytics": {
    id: "google-analytics",
    name: "Google Analytics 4",
    description:
      "GA4 data access with 200+ dimensions and metrics through natural language queries.",
    domains: ["google-analytics"],
    tools: [
      { name: "runReport", description: "Custom analytics reports" },
      { name: "getPageViews", description: "Page view analytics" },
      { name: "getActiveUsers", description: "User activity tracking" },
    ],
    config: {
      transport: { type: "stdio", command: "npx", args: ["-y", "mcp-server-google-analytics"] },
      env: {
        GOOGLE_CLIENT_EMAIL: "service-account@project.iam.gserviceaccount.com",
        GOOGLE_PRIVATE_KEY: "your-private-key",
        GA_PROPERTY_ID: "your-ga4-property-id",
      },
    },
    documentation: "https://github.com/some-repo/mcp-server-google-analytics",
    repository: "https://github.com/some-repo/mcp-server-google-analytics",
    package: "mcp-server-google-analytics",
  },
  // "auth0":  // {
  //   id: "auth0",
  //   name: "Auth0 Identity Management",
  //   description:
  //     "Auth0 tenant management through natural language with secure credential storage and OAuth 2.0 device authorization flow.",

  //   tools: [
  //     { name: "get_application", description: "Get application information" },
  //     { name: "list_applications", description: "List all applications" },
  //     { name: "list_logs", description: "List authentication logs" },
  //   ],
  //   domains: ["auth0"],
  //   config: {
  //     transport: { type: "stdio", command: "npx", args: ["-y", "@auth0/auth0-mcp-server", "run"] },
  //     auth: { type: "oauth" },
  //     env: { DEBUG: "auth0-mcp" },
  //   },
  //   documentation: "https://auth0.com/docs/mcp",
  //   repository: "https://github.com/auth0/auth0-mcp-server",
  //   package: "@auth0/auth0-mcp-server",
  // },
  linear: {
    id: "linear",
    name: "Linear Project Management",
    description: "Linear issue tracking, updates, and team coordination.",
    tools: [
      { name: "create_issue", description: "Create new issues" },
      { name: "update_issue", description: "Update existing issues" },
      { name: "list_issues", description: "List project issues" },
    ],
    domains: ["linear"],
    config: {
      transport: { type: "sse", url: "https://mcp.linear.app/sse" },
      auth: { type: "bearer", token_env: "LINEAR_API_KEY" },
    },
    documentation: "https://linear.app/docs/mcp",
    repository: "https://github.com/linear/linear-mcp",
    package: "linear-mcp",
  },
  trello: {
    id: "trello",
    name: "Trello Board Management",
    description:
      "Trello board management for kanban project management. Rate limiting and error handling.",
    tools: [
      { name: "list_boards", description: "List all boards" },
      { name: "get_lists", description: "Get board lists" },
      { name: "add_card_to_list", description: "Add card to list" },
    ],
    domains: ["trello"],
    config: {
      transport: { type: "stdio", command: "pnpx", args: ["@delorenj/mcp-server-trello"] },
      auth: { type: "api_key", token_env: "TRELLO_API_KEY" },
      env: { TRELLO_API_KEY: "your-api-key", TRELLO_TOKEN: "your-token" },
    },
    documentation: "https://github.com/delorenj/mcp-server-trello",
    repository: "https://github.com/delorenj/mcp-server-trello",
    package: "@delorenj/mcp-server-trello",
  },
  // "notion":  // {
  //   id: "notion",
  //   name: "Notion Workspace",
  //   description:
  //     "Official Notion MCP server for database and page management through natural language. Provides live context from Notion workspace based on user access and permissions.",

  //   tools: [
  //     { name: "search", description: "Search Notion content" },
  //     { name: "fetch", description: "Fetch Notion pages" },
  //     { name: "create-pages", description: "Create new pages" },
  //   ],
  //   domains: ["notion"],
  //   config: {
  //     transport: { type: "sse", url: "https://mcp.notion.com/sse" },
  //     auth: { type: "oauth" },
  //   },
  //   documentation: "https://notion.com/docs/mcp",
  //   repository: "https://github.com/notion/notion-mcp",
  //   package: "notion-mcp",
  // },
  rss: {
    id: "rss",
    name: "RSS Feed Management",
    description: "RSS feed management with OPML support. MySQL storage and content filtering.",
    tools: [
      { name: "get_content", description: "Retrieve RSS articles with optional filtering" },
      { name: "get_sources", description: "List all configured RSS feed sources" },
      { name: "set_tag", description: "Update article status" },
    ],
    domains: ["rss"],
    config: {
      transport: { type: "stdio", command: "npx", args: ["mcp_rss"] },
      env: {
        DB_HOST: "localhost",
        DB_PORT: "3306",
        DB_USERNAME: "root",
        DB_PASSWORD: "your-password",
        DB_DATABASE: "mcp_rss",
        OPML_FILE_PATH: "/path/to/your/feeds.opml",
        RSS_UPDATE_INTERVAL: "60",
      },
    },
    documentation: "https://github.com/some-repo/mcp_rss",
    repository: "https://github.com/some-repo/mcp_rss",
    package: "mcp_rss",
  },
  posthog: {
    id: "posthog",
    name: "PostHog Analytics & Feature Flags",
    description: "PostHog analytics, feature flags, and error tracking.",

    tools: [
      { name: "query_events", description: "Query analytics events" },
      { name: "create_feature_flag", description: "Create feature flags" },
      { name: "get_insights", description: "Get analytics insights" },
    ],
    domains: ["posthog"],
    config: {
      transport: { type: "sse", url: "https://mcp.posthog.com/sse" },
      auth: { type: "bearer", token_env: "POSTHOG_API_KEY" },
    },
    documentation: "https://posthog.com/docs/mcp",
    repository: "https://github.com/posthog/posthog-mcp",
    package: "@posthog/posthog-mcp",
  },
  // "sentry":  // {
  //   id: "sentry",
  //   name: "Sentry Error Tracking",
  //   description: "Error tracking, performance monitoring, and AI-powered root cause analysis.",

  //   tools: [
  //     { name: "list_issues", description: "List project issues" },
  //     { name: "get_project_info", description: "Get project information" },
  //     { name: "create_release", description: "Create new releases" },
  //   ],
  //   domains: ["sentry"],
  //   config: {
  //     transport: { type: "sse", url: "https://mcp.sentry.dev/mcp" },
  //     auth: { type: "oauth" },
  //   },
  //   documentation: "https://sentry.io/docs/mcp",
  //   repository: "https://github.com/sentry/sentry-mcp",
  //   package: "sentry-mcp",
  // },
};
