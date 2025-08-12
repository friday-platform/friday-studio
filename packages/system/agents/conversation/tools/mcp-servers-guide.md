# Atlas MCP Servers Configuration Guide

> **Model Context Protocol (MCP)** enables AI models to securely access external tools and data
> sources. This guide covers high-value MCP servers for Atlas workspaces, with actual configuration
> patterns used in production Atlas deployments.

### Atlas-Specific Features

- **EMCP Context**: Atlas provides built-in filesystem context without external MCP servers
- **Tool Scoping**: Fine-grained control over which tools agents can access
- **Multi-Transport**: Support for stdio, SSE, and future transport protocols
- **Security-First**: Mandatory allow/deny lists for all MCP tools

---

## Core MCP Servers for Atlas

### Development Tools

### 1. GitHub Integration

**Package**: `github-repos-manager-mcp` **Status**: Community-maintained **Atlas Use Cases**: Repository management, issue tracking, team collaboration

**Description**: Comprehensive GitHub repository automation and management with 89 tools for complete GitHub workflow integration. Features token-based authentication, direct API integration, and no Docker dependency for lightweight performance.

**Prerequisites**: GitHub Personal Access Token with scopes: `repo`, `user:read`, `read:org`

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      github:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "github-repos-manager-mcp"]
        auth:
          type: "bearer"
          token_env: "GITHUB_TOKEN"
        tools:
          allow: [
            "list_repositories",
            "get_repository_info",
            "get_file_contents",
            "create_issue",
            "list_issues",
            "set_default_repository",
          ]
          # For full access to all 89 tools, use:
          # allow: ["*"] # or specify individual tools for security
        env:
          GITHUB_TOKEN: "your-github-pat"
        client_config:
          timeout: "60s"
```

**Available Tools** (89 total):

**Repository Management**:

- `list_repositories`, `get_repository_info`, `set_default_repository`
- `search_repositories`, `create_repository`, `delete_repository`
- `get_file_contents`, `create_file`, `update_file`, `delete_file`

**Issue Management**:

- `create_issue`, `list_issues`, `get_issue`, `update_issue`, `close_issue`
- `add_issue_labels`, `remove_issue_labels`, `assign_issue`, `unassign_issue`

**Pull Request Operations**:

- `create_pull_request`, `list_pull_requests`, `get_pull_request`
- `merge_pull_request`, `close_pull_request`, `update_pull_request`

**Branch Management**:

- `list_branches`, `create_branch`, `delete_branch`
- `get_branch_info`, `compare_branches`

**Collaboration Features**:

- `add_collaborator`, `remove_collaborator`, `list_collaborators`
- `create_team`, `add_team_member`, `list_teams`

**Content Operations**:

- `upload_image`, `embed_image_in_issue`
- `search_code`, `search_commits`, `get_commit_info`

**Use Cases**: Repository management, issue tracking, team collaboration, code analysis, automated workflows, content management

---

### 2. Git Operations

**Package**: `mcp-server-git` **Status**: Community-maintained **Atlas Use Cases**: Automated
commits, branch analysis, repository maintenance

**Description**: Local Git repository operations for Atlas agents. Enables version control automation within workspace contexts.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      git:
        transport:
          type: "stdio"
          command: "uvx"
          args: ["mcp-server-git", "--repository", "/workspace"]
        tools:
          allow: ["git_status", "git_diff", "git_commit", "git_log"]
        client_config:
          timeout: "60s"
```

**Available Tools**:

- `git_status` - Check working directory status
- `git_diff_unstaged` - View unstaged changes
- `git_diff_staged` - View staged changes
- `git_diff` - Compare commits/branches
- `git_commit` - Create commits
- `git_add` - Stage files
- `git_reset` - Unstage files
- `git_log` - View commit history
- `git_create_branch` - Create new branches
- `git_checkout` - Switch branches
- `git_show` - Display commit details
- `git_init` - Initialize repositories
- `git_branch` - List/manage branches

---

### 3. Google GenAI Toolbox

**Package**: `mcp-toolbox` **Status**: Beta **Atlas Use Cases**: Database integration, AI tool development, data access automation

**Description**: Open-source database toolbox that acts as a control plane between AI applications and databases. Provides centralized tool management, enhanced performance, and end-to-end observability for GenAI applications.

**Prerequisites**: Database connection and `tools.yaml` configuration file

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      genai-toolbox:
        transport:
          type: "stdio"
          command: "toolbox"
          args: ["--stdio", "--tools-file", "/path/to/tools.yaml"]
        tools:
          allow: ["load_toolset", "execute_query", "get_schema", "reload_tools"]
        env:
          TOOLBOX_CONFIG: "/path/to/tools.yaml"
        client_config:
          timeout: "90s"
```

**Prerequisites**: Binary installation required - see official documentation

**Available Tools**:

- **Tool Management**: `load_toolset`, `reload_tools`, `list_tools`
- **Database Operations**: `execute_query`, `get_schema`, `describe_table`
- **Connection Management**: `test_connection`, `pool_status`
- **Configuration**: `validate_tools`, `get_config`

**Use Cases**: Database integration for AI applications, centralized tool management, data access automation, GenAI application development

---

### 4. Time & Timezone

**Package**: `mcp-server-time` **Status**: Community-maintained **Atlas Use Cases**: Scheduling,
time-based automation, global coordination

**Description**: Time operations for scheduling and coordination workflows. Essential for time-sensitive automation.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      time:
        transport:
          type: "stdio"
          command: "uvx"
          args: ["mcp-server-time", "--local-timezone"]
        tools:
          allow: ["convert_time", "get_current_time"]
```

**Available Tools**:

- `get_current_time` - Get current time in specified IANA timezone
- `convert_time` - Convert time between timezones with DST support

**Use Cases**: Scheduling agents, time-based triggers, global workspace coordination, meeting scheduling across timezones

---

### Cloud & Infrastructure

### 5. Azure Services

**Package**: `@azure/mcp` **Status**: Production-ready **Atlas Use Cases**: Cloud infrastructure management, DevOps automation, security management

**Description**: Official Microsoft Azure MCP Server with comprehensive Azure service integration. Features 30+ Azure services, hierarchical command routing, and integrated Azure CLI/Developer CLI support.

**Prerequisites**: Azure CLI authentication or Azure credentials configured

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      azure:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@azure/mcp@latest", "server", "start"]
        auth:
          type: "service_principal"
          # Uses environment variables for authentication
        tools:
          allow: ["subscription", "group", "keyvault", "storage", "sql", "cosmos", "monitor"]
          # For full access to all 30+ tools, use:
          # allow: ["*"] # or specify individual services for security
        env:
          AZURE_TENANT_ID: "your-tenant-id"
          AZURE_CLIENT_ID: "your-client-id"
          AZURE_CLIENT_SECRET: "your-client-secret"
          # Alternative: Use Azure CLI environment
          # AZURE_SUBSCRIPTION_ID: "your-subscription-id"
        client_config:
          timeout: "120s"
```

**Available Tools** (30+ Azure services):

**Core Azure Services**:

- `subscription` - Azure subscription operations and management
- `group` - Resource group operations and listing
- `keyvault` - Key Vault secrets, keys, and certificates management
- `storage` - Storage account operations, containers, blobs, and tables
- `sql` - Azure SQL databases and servers management
- `postgres` - Azure Database for PostgreSQL operations
- `redis` - Azure Redis Cache management
- `cosmos` - Cosmos DB databases, containers, and document queries

**Container & Compute Services**:

- `aks` - Azure Kubernetes Service cluster management
- `foundry` - AI Foundry services and resources

**Monitoring & Analytics**:

- `monitor` - Azure Monitor logs and metrics querying
- `grafana` - Azure Managed Grafana workspace operations
- `kusto` - Azure Data Explorer cluster operations
- `search` - Azure AI Search services management
- `loadtesting` - Azure Load Testing resources

**Integration & Messaging**:

- `servicebus` - Azure Service Bus resource management
- `appconfig` - App Configuration store operations

**DevOps & Infrastructure**:

- `role` - Azure RBAC and authorization management
- `marketplace` - Azure Marketplace products and offers
- `workbooks` - Azure Workbooks resource management
- `bicepschema` - Bicep Infrastructure as Code generation
- `azureterraformbestpractices` - Terraform best practices for Azure

**Third-party Integrations**:

- `datadog` - Datadog resource management and querying

**Documentation & Best Practices**:

- `documentation` - Search official Microsoft/Azure documentation
- `bestpractices` - Production-grade Azure best practices

**CLI Extensions**:

- `extension_az` - Direct Azure CLI command execution
- `extension_azd` - Azure Developer CLI operations
- `extension_azqr` - Azure Quick Review compliance reports

**Use Cases**: Cloud infrastructure management, DevOps automation, security management, monitoring setup, compliance reporting, Infrastructure as Code generation

---

### 6. Stripe Payments

**Package**: `@stripe/mcp` **Status**: Production-ready **Atlas Use Cases**: E-commerce automation, subscription management, payment processing

**Description**: Official Stripe MCP server for comprehensive payment processing, subscription management, and financial operations. Features OAuth authentication, restricted API key support, and extensive tool coverage.

**Prerequisites**: Stripe account and API key (restricted keys recommended)

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      stripe:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@stripe/mcp", "--tools=all"]
        auth:
          type: "api_key"
          token_env: "STRIPE_SECRET_KEY"
        tools:
          allow: [
            "create_customer",
            "list_customers",
            "create_invoice",
            "list_invoices",
            "list_subscriptions",
            "get_stripe_account_info",
          ]
          # For full access to all tools, use:
          # allow: ["*"] # or specify individual tools for security
        env:
          STRIPE_SECRET_KEY: "your-stripe-secret-key"
        client_config:
          timeout: "60s"
```

**Available Tools** (Specific tool names):

**Account Management**:

- `get_stripe_account_info` - Retrieve account information and settings
- `retrieve_balance` - Get current account balance and pending amounts

**Customer Operations**:

- `create_customer` - Create new customer profiles
- `list_customers` - Retrieve customer lists with filtering
- `update_customer` - Modify existing customer information
- `delete_customer` - Remove customer profiles

**Invoice Management**:

- `create_invoice` - Generate new invoices
- `create_invoice_item` - Add line items to invoices
- `finalize_invoice` - Complete and send invoices
- `list_invoices` - Retrieve invoice collections
- `update_invoice` - Modify existing invoices

**Subscription Handling**:

- `cancel_subscription` - Terminate subscription services
- `list_subscriptions` - Retrieve subscription data
- `update_subscription` - Modify subscription terms
- `create_subscription` - Set up new recurring billing

**Payment Processing**:

- `create_payment_intent` - Initialize payment flows
- `confirm_payment_intent` - Complete payment processing
- `list_payment_intents` - Track payment statuses
- `create_charge` - Process one-time payments

**Product & Price Management**:

- `create_product` - Add new products to catalog
- `list_products` - Retrieve product inventory
- `create_price` - Set pricing for products
- `list_prices` - Manage pricing structures

**Documentation & Support**:

- `search_documentation` - Query Stripe API documentation

**Use Cases**: E-commerce automation, subscription management, payment processing, financial reporting, invoice automation, customer lifecycle management

---

### Web Automation & Testing

### 7. Playwright Browser Automation

**Package**: `@executeautomation/playwright-mcp-server` **Status**: Community-maintained **Atlas Use Cases**: Automated testing, web scraping, UI automation

**Description**: Browser automation using Playwright for web page interaction, testing, and screenshot capture.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      playwright:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@executeautomation/playwright-mcp-server"]
        tools:
          allow: ["navigate", "click", "type", "screenshot", "extract_text"]
        client_config:
          timeout: "120s"
```

**Available Tools**:

**Navigation & Browser Control**:

- `Playwright_navigate` - Navigate to web pages
- `Playwright_close` - Close browser tabs/windows
- `playwright_go_back` - Navigate back in browser history
- `playwright_go_forward` - Navigate forward in browser history

**Element Interaction**:

- `Playwright_click` - Click on web elements
- `playwright_click_and_switch_tab` - Click and switch to new tab
- `Playwright_hover` - Hover over elements
- `Playwright_fill` - Fill form inputs
- `Playwright_select` - Select dropdown options
- `playwright_upload_file` - Upload files to forms
- `playwright_drag` - Drag and drop elements
- `playwright_press_key` - Press keyboard keys

**Frame & IFrame Operations**:

- `Playwright_iframe_click` - Click elements within iframes
- `Playwright_iframe_fill` - Fill inputs within iframes

**Data Extraction**:

- `Playwright_screenshot` - Capture page screenshots
- `playwright_get_visible_text` - Extract visible text content
- `playwright_get_visible_html` - Extract visible HTML content
- `Playwright_console_logs` - Retrieve browser console logs
- `playwright_save_as_pdf` - Save page as PDF

**JavaScript & Evaluation**:

- `Playwright_evaluate` - Execute JavaScript in browser context
- `playwright_custom_user_agent` - Set custom user agent

**Testing & Assertions**:

- `Playwright_expect_response` - Wait for and validate responses
- `Playwright_assert_response` - Assert response conditions

**Code Generation**:

- `start_codegen_session` - Start test code generation session
- `end_codegen_session` - End code generation session
- `get_codegen_session` - Get current session details
- `clear_codegen_session` - Clear session data

**Use Cases**: Automated testing, web scraping, UI automation, performance monitoring, screenshot
generation

---

### Search & Analytics

### 8. Google Analytics 4

**Package**: `mcp-server-google-analytics` **Status**: Community-maintained **Atlas Use Cases**: Website analytics, user behavior analysis, performance tracking

**Description**: GA4 data access with 200+ dimensions and metrics through natural language queries.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      google-analytics:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "mcp-server-google-analytics"]
        env:
          GOOGLE_CLIENT_EMAIL: "service-account@project.iam.gserviceaccount.com"
          GOOGLE_PRIVATE_KEY: "your-private-key"
          GA_PROPERTY_ID: "your-ga4-property-id"
        tools:
          allow: ["runReport", "getPageViews", "getActiveUsers"]
        client_config:
          timeout: "90s"
```

**Available Functions**:

- `runReport` - Custom analytics reports
- `getPageViews` - Page view analytics
- `getActiveUsers` - User activity tracking
- `getEvents` - Event tracking and analysis
- `getUserBehavior` - User behavior insights

**Use Cases**: Website analytics, user behavior analysis, performance tracking, marketing insights

---

### Authentication & Security

### 9. Auth0 Identity Management

**Package**: `@auth0/auth0-mcp-server` **Status**: Beta **Atlas Use Cases**: Identity management, authentication setup, security monitoring

**Description**: Auth0 tenant management through natural language with secure credential storage and OAuth 2.0 device authorization flow.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      auth0:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@auth0/auth0-mcp-server", "run"]
        auth:
          type: "oauth"
          # OAuth 2.0 device flow - interactive setup required
        tools:
          allow: ["get_application", "list_applications", "list_logs", "get_tenant_settings"]
          # For read-only operations, use:
          # allow: ["get_application", "list_applications", "list_logs", "get_tenant_settings"]
          # For full access, add: ["create_application", "update_application", "create_action", "deploy_action"]
        env:
          DEBUG: "auth0-mcp"
        client_config:
          timeout: "90s"
```

**Available Tools**:

- **Applications**: `list_applications`, `get_application`, `create_application`, `update_application`
- **Resource Servers**: `list_resource_servers`, `get_resource_server`, `create_resource_server`, `update_resource_server`
- **Actions**: `list_actions`, `get_action`, `create_action`, `update_action`, `deploy_action`
- **Logs**: `list_logs`, `get_log_entry`
- **Forms**: `list_forms`, `get_form`, `create_form`, `update_form`, `publish_form`
- **Tenant**: `get_tenant_settings`

**Use Cases**: Identity management, authentication setup, security monitoring, user access control, application configuration

---

### Task & Project Management

### 10. Linear Project Management

**Package**: Official Linear MCP server (remote)

**Description**: Linear project management integration for issue tracking, updates, and team coordination.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      linear:
        transport:
          type: "sse"
          url: "https://mcp.linear.app/sse"
        auth:
          type: "bearer"
          token_env: "LINEAR_API_KEY"
        tools:
          allow: ["create_issue", "update_issue", "list_issues"]
        client_config:
          timeout: "120s"
```

**Use Cases**: Project tracking, issue management, team collaboration, automated reporting

---

### 11. Trello Board Management

**Package**: `@delorenj/mcp-server-trello` **Status**: Community-maintained **Atlas Use Cases**: Kanban project management, task tracking, team coordination

**Description**: Trello board management through natural language for kanban-style project management. Features built-in rate limiting, dynamic board selection, and comprehensive error handling.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      trello:
        transport:
          type: "stdio"
          command: "pnpx"
          args: ["@delorenj/mcp-server-trello"]
        auth:
          type: "api_key"
          token_env: "TRELLO_API_KEY"
        tools:
          allow: [
            "list_boards",
            "get_lists",
            "get_cards_by_list_id",
            "add_card_to_list",
            "update_card_details",
          ]
          # For full access, add: ["archive_card", "move_card", "attach_image_to_card", "set_active_board"]
        env:
          TRELLO_API_KEY: "your-api-key"
          TRELLO_TOKEN: "your-token"
        client_config:
          timeout: "60s"
```

**Available Tools**:

- **Board Management**: `list_boards`, `set_active_board`
- **Workspace Management**: `list_workspaces`
- **List Operations**: `get_lists`
- **Card Operations**: `get_cards_by_list_id`, `add_card_to_list`, `update_card_details`, `move_card`, `archive_card`
- **Attachments**: `attach_image_to_card`
- **Activity**: `get_recent_activity`

**Use Cases**: Kanban project management, task tracking, team coordination, workflow automation, project reporting

---

### 12. Notion Workspace

**Package**: Official Notion MCP server (remote) **Status**: Production-ready **Atlas Use Cases**: Knowledge management, documentation, project planning

**Description**: Official Notion MCP server for database and page management through natural language. Provides live context from Notion workspace based on user access and permissions.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      notion:
        transport:
          type: "sse"
          url: "https://mcp.notion.com/sse"
        auth:
          type: "oauth"
          # OAuth flow through Notion app: Settings → Connections → Notion MCP
        tools:
          allow: ["search", "fetch", "create-pages", "update-page", "get-comments"]
          # For full access, add: ["move-pages", "duplicate-page", "create-database", "update-database"]
        client_config:
          timeout: "90s"
```

**Available Tools**:

- **Search & Retrieval**: `search`, `fetch`
- **Page Management**: `create-pages`, `update-page`, `move-pages`, `duplicate-page`
- **Database Operations**: `create-database`, `update-database`
- **Comments**: `create-comment`, `get-comments`
- **User Management**: `get-users`, `get-user`, `get-self`

**Use Cases**: Knowledge management, documentation, project planning, team collaboration, template creation, workspace organization

---

### Content & Email Management

### 13. RSS Feed Management

**Package**: `mcp_rss` **Status**: Community-maintained **Atlas Use Cases**: Content aggregation, news monitoring, research automation

**Description**: RSS feed management with OPML support and automatic content aggregation. Features MySQL storage, automatic feed updates, and content filtering capabilities.

**Prerequisites**: MySQL database required

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      rss:
        transport:
          type: "stdio"
          command: "npx"
          args: ["mcp_rss"]
        tools:
          allow: ["get_content", "get_sources", "set_tag"]
        env:
          # Database configuration
          DB_HOST: "localhost"
          DB_PORT: "3306"
          DB_USERNAME: "root"
          DB_PASSWORD: "your-password"
          DB_DATABASE: "mcp_rss"

          # RSS configuration
          OPML_FILE_PATH: "/path/to/your/feeds.opml"
          RSS_UPDATE_INTERVAL: "60" # minutes between updates
        client_config:
          timeout: "30s"
```

**Available Tools**:

- **get_content**: Retrieve RSS articles with optional filtering
- **get_sources**: List all configured RSS feed sources
- **set_tag**: Update article status (mark as favorite or normal)

**Use Cases**: Content aggregation, news monitoring, research automation, content curation, RSS feed management

---

### Development & Monitoring

### 14. PostHog Analytics & Feature Flags

**Package**: `@posthog/posthog-mcp`

**Description**: Analytics, feature flags, and error tracking integration for product development insights.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      posthog:
        transport:
          type: "sse"
          url: "https://mcp.posthog.com/sse"
        auth:
          type: "bearer"
          token_env: "POSTHOG_API_KEY"
        tools:
          allow: ["query_events", "create_feature_flag", "get_insights"]
        client_config:
          timeout: "90s"
```

**Available Tools**:

**Dashboard Management**:

- `dashboard_create` - Create new dashboards
- `dashboard_get_all` - List all dashboards
- `dashboard_update` - Update existing dashboards
- `dashboard_delete` - Delete dashboards

**Insights & Analytics**:

- `insight_create` - Create new insights
- `insight_get_all` - List all insights
- `insight_update` - Update existing insights
- `insight_delete` - Delete insights
- `insight_get_sql` - Get SQL for insights

**Feature Flag Management**:

- `feature_flag_create` - Create new feature flags
- `feature_flag_get_all` - List all feature flags
- `feature_flag_update` - Update feature flags
- `feature_flag_delete` - Delete feature flags

**Project & Organization**:

- `organization_get_all` - List organizations
- `project_get_all` - List projects
- `project_set_active` - Set active project

**Error Tracking**:

- `error_tracking_list` - List error tracking data
- `error_tracking_details` - Get error details

**Documentation & Observability**:

- `documentation_search` - Search PostHog documentation
- `llm_observability_get_costs` - Get LLM observability costs

**Use Cases**: Product analytics, feature rollouts, user behavior analysis, A/B testing

---

### 15. Sentry Error Tracking

**Package**: Official Sentry MCP server (remote)

**Description**: Error tracking, performance monitoring, and AI-powered root cause analysis.

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      sentry:
        transport:
          type: "sse"
          url: "https://mcp.sentry.dev/mcp"
        auth:
          type: "oauth"
        tools:
          allow: ["list_issues", "get_project_info", "create_release"]
        client_config:
          timeout: "60s"
```

**Available Tools**:

**Project & Organization Management**:

- `list_projects` - List accessible Sentry projects
- `create_project` - Create new projects and retrieve client keys
- `list_organization_replays` - List replays from organization

**Issue Tracking & Analysis**:

- `list_project_issues` - List issues from specific projects
- `get_sentry_issue` - Retrieve and analyze specific issues
- `resolve_short_id` - Get issue details using short ID
- `list_issue_events` - List events for specific issues

**Event & Error Management**:

- `get_sentry_event` - Retrieve and analyze specific events
- `list_error_events_in_project` - List error events from projects

**AI-Powered Analysis**:

- **Seer AI Integration**: AI-powered root cause analysis and automated fix recommendations

**Use Cases**: Error monitoring, performance optimization, debugging assistance, release management

---

### Utility Services

### 16. Weather Data Service

**Package**: `@timlukahorstmann/mcp-weather` **Status**: Community-maintained **Atlas Use Cases**: Location-based applications, travel planning, weather-dependent automation

**Description**: Real-time weather forecasts using AccuWeather API. Provides accurate hourly and daily weather data for any location with flexible unit systems.

**Prerequisites**: AccuWeather API key required

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      weather:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@timlukahorstmann/mcp-weather"]
        auth:
          type: "api_key"
          token_env: "ACCUWEATHER_API_KEY"
        tools:
          allow: ["weather-get_hourly", "weather-get_daily"]
        env:
          ACCUWEATHER_API_KEY: "your-api-key"
        client_config:
          timeout: "30s"
```

**Available Tools**:

- **weather-get_hourly**: Get 12-hour weather forecast
- **weather-get_daily**: Get daily weather forecast

**Use Cases**: Location-based applications, travel planning, weather-dependent automation, agriculture, event planning

---

## Atlas Configuration Patterns

### Atlas MCP Configuration Structure

Atlas uses YAML configuration in `workspace.yml` with enhanced security and type safety:

```yaml
# workspace.yml
tools:
  mcp:
    # Global client configuration
    client_config:
      timeout: "30s"
      retry_policy:
        max_attempts: 3
      connection_pool:
        max_connections: 20

    # Individual MCP servers
    servers:
      server-name:
        transport:
          type: "stdio" # or "sse" for remote
          command: "npx"
          args: ["-y", "package-name"]

        # Authentication (optional)
        auth:
          type: "bearer" # or "api_key", "oauth"
          token_env: "API_TOKEN_VAR"

        # Tool filtering (required for security)
        tools:
          allow: ["tool1", "tool2"] # whitelist approach
        # deny: ["dangerous_tool"]  # or blacklist (mutually exclusive)

        # Server-specific configuration
        client_config:
          timeout: "60s" # override global timeout

        # Environment variables
        env:
          CONFIG_VAR: "value"
```

### Atlas Integration Features

- **Enhanced Security**: Mandatory tool filtering with allow/deny lists
- **Type Safety**: YAML schema validation at runtime
- **Authentication**: Built-in auth patterns (bearer, api_key, oauth)
- **Transport Flexibility**: stdio, sse (Server-Sent Events) for remote servers
- **Resource Management**: Connection pooling and timeout controls
- **Agent Integration**: MCP tools available to specific agents via job configuration

### Atlas Security Best Practices

1. **Tool Filtering**: Always specify `tools.allow` or `tools.deny` - never leave tools unrestricted
2. **Environment Variables**: Store secrets in environment variables, referenced via `token_env`
3. **Authentication Types**: Use structured auth configuration with `type` and `token_env`
4. **Transport Security**: Prefer `sse` transport for remote servers with HTTPS endpoints
5. **Timeout Controls**: Set appropriate timeouts to prevent hanging operations
6. **Agent Scoping**: Limit tool access per agent using `tools` in job execution configuration
7. **Audit Logging**: Atlas automatically logs all MCP tool invocations for security auditing
