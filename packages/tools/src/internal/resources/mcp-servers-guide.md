# Atlas MCP Servers Configuration Guide

> **Model Context Protocol (MCP)** enables AI models to securely access external tools and data
> sources. This guide covers high-value MCP servers for Atlas workspaces, with actual configuration
> patterns used in production Atlas deployments.

## Quick Reference

### Essential Atlas MCP Servers

- **[Tavily](#tavily-web-search-platform)**: AI-powered web search, content extraction, and crawling
- **[GitHub](#1-github-integration)**: Repository operations, code search, issue management
- **[Filesystem](#3-filesystem-operations)**: Secure file operations with path restrictions
- **[Memory](#7-persistent-memory)**: Knowledge graph-based persistent memory
- **[Slack](#17-slack-workspace-integration)**: Team communication and notifications

### Atlas-Specific Features

- **EMCP Context**: Atlas provides built-in filesystem context without external MCP servers
- **Tool Scoping**: Fine-grained control over which tools agents can access
- **Multi-Transport**: Support for stdio, SSE, and future transport protocols
- **Security-First**: Mandatory allow/deny lists for all MCP tools

---

## Core MCP Servers for Atlas

### Development Tools

### 1. GitHub Integration

**Package**: `@modelcontextprotocol/server-github` **Status**: Production-ready **Atlas Use Cases**:
Repository analysis, code review automation, issue tracking

**Description**: Essential GitHub API integration for Atlas workspaces. Provides secure file
operations, repository management, and search capabilities with proper authentication.

**Installation**:

```bash
npm i @modelcontextprotocol/server-github
# Or alternative: npm i github-mcp-server
```

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
          args: ["-y", "@modelcontextprotocol/server-github"]
        auth:
          type: "bearer"
          token_env: "GITHUB_TOKEN"
        tools:
          allow: ["search_repositories", "get_file_contents", "create_issue"]
        env:
          GITHUB_API_URL: "https://api.github.com"
          LOG_LEVEL: "info"
```

**Available Tools**:

- File operations (read, write, create, delete)
- Repository management (create, clone, list)
- Search functionality (code, issues, repositories)
- Branch management (create, switch, merge)
- Pull request operations
- Issue tracking

**Atlas Integration**: Perfect for code analysis agents, automated issue creation, and repository
monitoring workflows. Essential for development-focused workspaces.

---

### 2. Git Operations

**Package**: `mcp-server-git` **Status**: Community-maintained **Atlas Use Cases**: Automated
commits, branch analysis, repository maintenance

**Description**: Local Git repository operations for Atlas agents. Enables version control
automation within workspace contexts.

**Installation**:

```bash
pip install mcp-server-git
# Or: uvx mcp-server-git
```

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

**Atlas Integration**: Ideal for continuous integration agents, automated commit workflows, and
repository analysis tasks.

---

### 3. Filesystem Operations

**Package**: `@modelcontextprotocol/server-filesystem` **Status**: Production-ready **Atlas
Alternative**: Use EMCP context provisioning for better security

**Description**: Secure file operations for when EMCP context isn't sufficient. Atlas EMCP is
preferred for most filesystem access needs.

**Installation**:

```bash
npm i @modelcontextprotocol/server-filesystem
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      filesystem:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]
        tools:
          # Use either allow or deny, not both
          deny: ["write_file", "delete_file"] # Read-only access
        client_config:
          timeout: "30s"
```

**Available Tools**:

- `read_file` - Read file contents
- `read_multiple_files` - Batch file reading
- `write_file` - Write to files
- `edit_file` - Modify existing files
- `create_directory` - Create directories
- `list_directory` - List directory contents
- `move_file` - Move/rename files
- `search_files` - Search within files
- `get_file_info` - File metadata
- `list_allowed_directories` - View accessible paths

**Atlas Integration**: Use sparingly - Atlas EMCP context provides better security and performance
for most file access patterns.

---

### Data & Databases

### 4. Web Content Fetching

**Package**: `@modelcontextprotocol/server-fetch` **Status**: Production-ready **Atlas Use Cases**:
Content analysis, documentation retrieval, web scraping

**Description**: Essential web content retrieval with automatic markdown conversion. Critical for
research and analysis workflows.

**Installation**:

```bash
uvx mcp-server-fetch
# Or: npx -y @modelcontextprotocol/server-fetch
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    client_config:
      timeout: "30s"
    servers:
      fetch:
        transport:
          type: "stdio"
          command: "uvx"
          args: ["mcp-server-fetch"]
        tools:
          allow: ["fetch"]
```

**Available Tools**:

- `fetch` - URL fetching with automatic markdown conversion
- Supports chunked reading with `start_index` parameter
- Proxy support via `--proxy-url` flag

**Atlas Integration**: Essential for research agents, competitive analysis, and documentation
workflows. Combines well with memory servers for persistent learning.

---

### 5. PostgreSQL Database

**Package**: `@modelcontextprotocol/server-postgres` **Status**: Legacy (consider alternatives)
**Atlas Use Cases**: Database analysis, report generation, schema inspection

**Description**: Read-only PostgreSQL access for data analysis workflows. Consider modern
alternatives for new implementations.

**Installation**:

```bash
npm i @modelcontextprotocol/server-postgres
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      postgres:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
        client_config:
          timeout: "60s"
        env:
          DATABASE_URL: "postgresql://localhost/mydb"
```

**Available Tools**:

- Database schema inspection
- Read-only query execution
- Table structure analysis
- Safe data retrieval

**Atlas Integration**: Useful for database analysis agents and automated reporting. Ensure read-only
access for security.

---

### 6. SQLite Database

**Package**: `@modelcontextprotocol/server-sqlite` **Status**: Archived (use alternatives) **Atlas
Use Cases**: Local data analysis, lightweight database queries

**Description**: SQLite database access for local data analysis. Consider alternatives for
production use.

**Installation**:

```bash
npm i @modelcontextprotocol/server-sqlite
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      sqlite:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-sqlite", "/data/database.sqlite"]
        tools:
          allow: ["query", "describe_table", "list_tables"]
```

**Available Tools**:

- SQL query execution
- Schema information extraction
- Multi-database support
- Transaction management

**Atlas Integration**: Suitable for local data analysis workflows. Prefer modern database adapters
for production workspaces.

---

### AI & Memory Systems

### 7. Persistent Memory

**Package**: `@modelcontextprotocol/server-memory` **Status**: Production-ready **Atlas
Integration**: Complements built-in Atlas memory system

**Description**: External memory system that works alongside Atlas's built-in memory. Use for
specialized memory patterns not covered by Atlas core memory.

**Installation**:

```bash
npm i @modelcontextprotocol/server-memory
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      memory:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-memory"]
        env:
          MEMORY_FILE_PATH: "/workspace/.memory/session.json"
        tools:
          allow: ["create_memory", "update_memory", "delete_memory", "list_memories"]
```

**Available Tools**:

- Entity management and tracking
- Relationship mapping
- Observation storage
- Context preservation

**Memory Categories**:

- Basic identity information
- Behavioral patterns
- User preferences
- Goals and objectives
- Relationship networks

**Atlas Integration**: Excellent complement to Atlas's built-in memory system. Use for specialized
knowledge graphs and external memory patterns.

---

### 8. Sequential Thinking

**Package**: `@modelcontextprotocol/server-sequential-thinking` **Status**: Experimental **Atlas Use
Cases**: Complex reasoning, multi-step analysis, problem decomposition

**Description**: Structured thinking processes for complex problem-solving. Enhances agent reasoning
capabilities.

**Installation**:

```bash
npm i @modelcontextprotocol/server-sequential-thinking
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      sequential-thinking:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-sequential-thinking"]
        env:
          DISABLE_THOUGHT_LOGGING: "true"
        client_config:
          timeout: "120s"
```

**Available Tools**:

- Structured thinking processes
- Iterative solution refinement
- Multiple reasoning paths
- Problem decomposition

**Atlas Integration**: Powerful addition to analytical agents. Use for complex reasoning workflows
that benefit from structured thinking.

---

### 9. Time & Timezone

**Package**: `mcp-server-time` **Status**: Community-maintained **Atlas Use Cases**: Scheduling,
time-based automation, global coordination

**Description**: Time operations for scheduling and coordination workflows. Essential for
time-sensitive automation.

**Installation**:

```bash
uvx mcp-server-time
```

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

- `convert_time` - Timezone conversion with DST support
- Time zone lookup
- Date formatting
- Calendar operations

**Atlas Integration**: Essential for scheduling agents, time-based triggers, and global workspace
coordination.

---

### Cloud & Infrastructure

### 10. Azure Services

**Package**: `@azure/mcp`

**Description**: Official Azure MCP Server with comprehensive Azure service integration for cloud
management.

**Installation**:

```bash
npm i @azure/mcp
```

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
          args: ["-y", "@azure/mcp"]
        auth:
          type: "bearer"
          token_env: "AZURE_ACCESS_TOKEN"
        env:
          AZURE_TENANT_ID: "YOUR_TENANT_ID"
          AZURE_CLIENT_ID: "YOUR_CLIENT_ID"
          AZURE_CLIENT_SECRET: "YOUR_CLIENT_SECRET"
        client_config:
          timeout: "90s"
```

**Available Tools**:

- Configuration stores management
- Key-value pair operations
- Secrets management
- Keys and certificates handling
- Log and metrics querying
- Resource management

**Use Cases**: Cloud infrastructure management, DevOps automation, security management, monitoring
setup

---

### 11. Stripe Payments

**Package**: `@stripe/mcp`

**Description**: Official Stripe payments and subscription management for e-commerce and billing
automation.

**Installation**:

```bash
npm i @stripe/mcp
```

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
          type: "bearer"
          token_env: "STRIPE_SECRET_KEY"
        tools:
          allow: ["create_customer", "create_payment", "list_invoices"]
        client_config:
          timeout: "60s"
```

**Environment Variables**: `STRIPE_SECRET_KEY`

**Available Tools**:

- Customer management (create, update, delete)
- Product creation and management
- Payment processing and tracking
- Subscription handling
- Invoice generation
- Dispute management
- Analytics and reporting

**Use Cases**: E-commerce automation, subscription management, payment processing, financial
reporting

---

### Web Automation & Testing

### 12. Playwright Browser Automation

**Package**: `@executeautomation/playwright-mcp-server`

**Description**: Browser automation using Playwright for web page interaction, testing, and
screenshot capture.

**Installation**:

```bash
npm install -g @executeautomation/playwright-mcp-server
# Or: npx @smithery/cli install @executeautomation/playwright-mcp-server --client claude
```

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

- Web navigation and interaction
- Element location and manipulation
- Screenshot capture
- Test code generation
- Form automation
- Data extraction and scraping
- Performance monitoring

**Use Cases**: Automated testing, web scraping, UI automation, performance monitoring, screenshot
generation

---

### 13. Puppeteer Web Control

**Package**: `mcp-server-puppeteer-py`

**Description**: Browser automation using Puppeteer for web navigation, interaction, and data
extraction.

**Installation**: Available through GitHub repository (Python-based)

**Available Tools**:

- Browser control and navigation
- Form automation
- UI testing capabilities
- Web scraping
- PDF generation
- Performance analysis

**Use Cases**: Web automation, UI testing, data extraction, report generation

---

### Search & Analytics

### 14. Algolia Search Platform

**Package**: Built from Go source

**Description**: Search and analytics platform integration with comprehensive API access for search
functionality.

**Installation**:

```bash
git clone git@github.com:algolia/mcp.git
cd mcp/cmd/mcp
go build
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      algolia:
        transport:
          type: "stdio"
          command: "/usr/local/bin/algolia-mcp"
        auth:
          type: "api_key"
          token_env: "ALGOLIA_API_KEY"
        env:
          ALGOLIA_APP_ID: "<APP_ID>"
          ALGOLIA_INDEX_NAME: "<INDEX_NAME>"
          ALGOLIA_WRITE_API_KEY: "<ADMIN_API_KEY>"
        tools:
          allow: ["search", "analytics", "recommend"]
```

**Available Tools**:

- `search` - Full-text search capabilities
- `analytics` - Search analytics and insights
- `recommend` - Recommendation engine
- `abtesting` - A/B testing for search
- `querysuggestions` - Query suggestion management
- `collections` - Index collection management
- `monitoring` - Performance monitoring
- `usage` - Usage analytics

**Use Cases**: Search optimization, analytics tracking, recommendation systems, A/B testing

---

### 15. Google Analytics 4

**Package**: `mcp-server-google-analytics`

**Description**: GA4 data access with 200+ dimensions and metrics through natural language queries.

**Installation**:

```bash
npm install -g mcp-server-google-analytics
# Or: npx -y @smithery/cli install mcp-server-google-analytics --client claude
```

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

### 16. Auth0 Identity Management

**Package**: `@auth0/auth0-mcp-server`

**Description**: Auth0 tenant management through natural language with secure credential storage.

**Installation**:

```bash
npx @auth0/auth0-mcp-server init
```

**Available Tools**:

- **Applications**: CRUD operations for applications
- **Resource Servers**: API configuration management
- **Actions**: Deploy and manage Auth0 Actions
- **Logs**: Retrieve and analyze authentication logs
- **Forms**: Manage login and registration forms

**Security Features**:

- System keychain credential storage
- OAuth 2.0 authentication
- Scoped permissions management
- Audit logging

**Use Cases**: Identity management, authentication setup, security monitoring, user access control

---

### Communication & Messaging

### 17. Slack Workspace Integration

**Package**: `@modelcontextprotocol/server-slack` **Status**: Production-ready **Atlas Use Cases**:
Notifications, team communication, workflow integration

**Description**: Essential Slack integration for Atlas workspaces. Enables agents to communicate
with teams and send notifications.

**Installation**:

```bash
npm i @modelcontextprotocol/server-slack
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      slack:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-slack"]
        auth:
          type: "bearer"
          token_env: "SLACK_BOT_TOKEN"
        env:
          SLACK_TEAM_ID: "T01234567"
          SLACK_CHANNEL_IDS: "C01234567,C76543210"
        tools:
          allow: ["send_message", "list_channels", "add_reaction"]
```

**Required Scopes**: `channels:history`, `channels:read`, `chat:write`, `reactions:write`,
`users:read`

**Available Tools**:

- List channels and workspaces
- Post messages to channels
- Add reactions to messages
- Retrieve message history
- Manage users and permissions
- Channel creation and management

**Atlas Integration**: Critical for team-facing agents. Excellent for sending analysis results,
alerts, and status updates to development teams.

---

### 18. Gmail Email Management

**Package**: `@gongrzhe/server-gmail-autoauth-mcp`

**Description**: Complete Gmail management with auto-authentication support for email automation.

**Installation**:

```bash
npx -y @smithery/cli install @gongrzhe/server-gmail-autoauth-mcp --client claude
```

**Atlas Configuration**:

```yaml
# In workspace.yml
tools:
  mcp:
    servers:
      gmail:
        transport:
          type: "stdio"
          command: "npx"
          args: ["@gongrzhe/server-gmail-autoauth-mcp"]
        tools:
          allow: ["send_email", "read_email", "search_emails"]
        client_config:
          timeout: "60s"
```

**Available Tools**:

- `send_email` - Send emails with attachments
- `draft_email` - Create email drafts
- `read_email` - Read email contents
- `search_emails` - Search across mailbox
- `download_attachment` - Download file attachments
- `modify_email` - Update email properties
- `delete_email` - Delete emails
- **Label Management**: Create, update, delete labels
- **Batch Operations**: Bulk email operations

**Use Cases**: Email automation, customer service, newsletter management, attachment processing

---

### Task & Project Management

### 19. Linear Project Management

**Package**: Official Linear MCP server (remote)

**Description**: Linear project management integration for issue tracking, updates, and team
coordination.

**Installation**: Remote server at `https://mcp.linear.app/sse`

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

**Features**:

- Issue creation and management
- Status updates and tracking
- Automated reporting
- Slack integration
- Google Docs synchronization
- Team coordination

**Use Cases**: Project tracking, issue management, team collaboration, automated reporting

---

### 20. Trello Board Management

**Package**: `mcp-server-ts-trello`

**Description**: Trello board management through natural language for kanban-style project
management.

**Installation**: Available through GitHub repository

**Available Tools**:

- Board management and creation
- List management (To Do, In Progress, Done)
- Card management (create, update, move)
- Project tracking and reporting
- Workflow optimization
- Team collaboration features

**Use Cases**: Kanban project management, task tracking, team coordination, workflow automation

---

### 21. Notion Workspace

**Package**: Official Notion MCP server

**Description**: Notion database and page management through natural language for knowledge
management.

**Installation**: Available through downloadable package and hosted server

**Features**:

- Task management and creation
- Database queries and management
- Page creation and editing
- Note organization
- Team collaboration
- Template management

**Use Cases**: Knowledge management, documentation, project planning, team collaboration

---

### Content & Email Management

### 22. News API Integration

**Package**: `@berlinbra/news-api-mcp`

**Description**: Global news access through News API with advanced filtering and multi-language
support.

**Installation**:

```bash
npx -y @smithery/cli install @berlinbra/news-api-mcp --client claude
```

**Available Tools**:

- `search-news` - Search news articles
- `get-top-headlines` - Retrieve top headlines
- `get-news-sources` - Manage news sources

**Features**:

- Multi-language support
- Category filtering (business, entertainment, health, science, sports, technology)
- Source management
- Date-based queries
- Geographic filtering

**Use Cases**: News monitoring, content curation, market research, trend analysis

---

### 23. RSS Feed Management

**Package**: `mcp_rss`

**Description**: RSS feed management with OPML support and content aggregation for news and content
tracking.

**Installation**:

```bash
npx mcp_rss
```

**Configuration**: Requires MySQL database and environment variables for DB connection

**Available Methods**:

- `get_content` - Retrieve feed content
- `get_sources` - Manage RSS sources
- `set_tag` - Tag and categorize content

**Features**:

- OPML parsing and import
- Automatic content updates
- Content filtering and search
- Favorite tagging system
- Multi-feed aggregation

**Use Cases**: Content aggregation, news monitoring, research automation, content curation

---

### Development & Monitoring

### 24. PostHog Analytics & Feature Flags

**Package**: `@posthog/posthog-mcp`

**Description**: Analytics, feature flags, and error tracking integration for product development
insights.

**Installation**:

```bash
npx @posthog/wizard@latest mcp add
```

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

- Feature flag management and testing
- Analytics queries and insights
- Error investigation and tracking
- Project management
- User behavior analysis
- A/B testing management
- Custom event tracking

**Use Cases**: Product analytics, feature rollouts, user behavior analysis, A/B testing

---

### 25. Sentry Error Tracking

**Package**: Official Sentry MCP server (remote)

**Description**: Error tracking, performance monitoring, and AI-powered root cause analysis.

**Installation**: Remote server (OAuth) or local STDIO mode

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

- Organizations and project management
- Teams and user management
- Issues and error tracking
- DSN (Data Source Name) management
- Error analysis and debugging
- **Seer AI**: AI-powered root cause analysis
- Release management
- Performance monitoring

**Features**:

- Real-time error tracking
- Performance monitoring
- AI-powered root cause analysis
- Release health monitoring
- Custom alerting

**Use Cases**: Error monitoring, performance optimization, debugging assistance, release management

---

### Utility Services

### 26. Weather Data Service

**Package**: Multiple implementations (`mcp-weather-server`, `@executeautomation/weather-mcp`)

**Description**: Real-time weather data and forecasts using Open-Meteo, AccuWeather, or National
Weather Service APIs.

**Installation**:

```bash
pip install mcp-weather-server
# Or npm equivalent
```

**Features**:

- City-based weather queries
- Weather alerts and warnings
- Multi-day forecasts
- Historical weather data
- No API key required (for some implementations)
- Multiple data source support

**Use Cases**: Location-based applications, travel planning, weather-dependent automation,
agriculture

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

### Atlas Testing & Debugging

Atlas provides built-in MCP testing and debugging capabilities:

```bash
# Test MCP server connectivity
atlas config validate

# View available MCP tools
atlas tools list

# Test specific MCP server
atlas tools test github

# Debug MCP tool execution
atlas signal trigger test-signal --debug
```

### MCP Inspector Integration

For external testing, use the MCP Inspector:

```bash
npx @modelcontextprotocol/inspector
```

### Installation Methods

- **npm/npx**: JavaScript/TypeScript servers
- **pip/uvx**: Python servers
- **Remote**: Hosted servers via URL
- **Docker**: Containerized servers
- **Source**: Build from repository

---

## Getting Started with Atlas MCP

1. **Choose MCP servers** based on your workspace requirements
2. **Install packages** using npm, pip, or build from source
3. **Configure in workspace.yml** using Atlas YAML schema
4. **Set environment variables** for authentication tokens
5. **Test configuration** using `atlas config validate`
6. **Deploy agents** that use MCP tools in job execution
7. **Monitor usage** through Atlas built-in logging and metrics

### Atlas-Specific MCP Features

- **Job Integration**: MCP tools are granted to agents via job `execution.agents[].tools.allow`
- **Context Provisioning**: Atlas EMCP provides secure filesystem context without MCP servers
- **Memory Integration**: Built-in workspace memory system complements external MCP memory servers
- **Signal Processing**: MCP tools can be used in response to HTTP, schedule, or system signals
- **Multi-Agent Workflows**: MCP tools shared across agent pipelines with proper scoping

This guide provides production-ready MCP server configurations for Atlas workspaces, enabling secure
and scalable AI agent orchestration with external tool integration.
