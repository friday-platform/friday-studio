# Multi-Purpose Development Workspace

A comprehensive Atlas workspace featuring 10 specialized agents based on the most popular MCP (Model
Context Protocol) servers used by developers in their daily work.

## Overview

This workspace demonstrates how Atlas can orchestrate multiple AI agents to handle various
development workflows, from code review and repository management to cloud operations and error
tracking.

## Agents

### 1. GitHub Manager (`github-manager`)

- **Purpose**: Repository management and automation
- **Capabilities**: Create repositories, manage issues/PRs, analyze code
- **Use Cases**: Repository setup, issue tracking, code analysis

### 2. Filesystem Manager (`filesystem-manager`)

- **Purpose**: Secure file and directory operations
- **Capabilities**: Read/write files, directory management, content analysis
- **Use Cases**: Project setup, file operations, code organization

### 3. Database Analyst (`database-analyst`)

- **Purpose**: PostgreSQL analysis and optimization
- **Capabilities**: Schema inspection, query optimization, data insights
- **Use Cases**: Database performance tuning, schema analysis

### 4. Web Researcher (`web-researcher`)

- **Purpose**: Web content fetching and analysis
- **Capabilities**: Content fetching, API integration, documentation analysis
- **Use Cases**: Research, API testing, documentation gathering

### 5. Slack Communicator (`slack-communicator`)

- **Purpose**: Team communication automation
- **Capabilities**: Send messages, manage channels, workflow automation
- **Use Cases**: Status updates, alerts, team coordination

### 6. Memory Keeper (`memory-keeper`)

- **Purpose**: Persistent knowledge management
- **Capabilities**: Knowledge storage, graph operations, memory management
- **Use Cases**: Context retention, knowledge base building

### 7. Cloud Operator (`cloud-operator`)

- **Purpose**: AWS infrastructure management
- **Capabilities**: Resource management, deployment, monitoring
- **Use Cases**: Infrastructure deployment, cloud monitoring

### 8. CI/CD Monitor (`ci-cd-monitor`)

- **Purpose**: Build pipeline monitoring and failure resolution
- **Capabilities**: Build monitoring, failure analysis, automated fixes
- **Use Cases**: Build monitoring, deployment automation

### 9. Error Tracker (`error-tracker`)

- **Purpose**: Application error tracking via Sentry
- **Capabilities**: Error monitoring, performance tracking, alerting
- **Use Cases**: Error analysis, performance monitoring

### 10. Code Assistant (`code-assistant`)

- **Purpose**: Advanced code analysis and development assistance
- **Capabilities**: Code analysis, documentation generation, refactoring
- **Use Cases**: Code review, documentation, development guidance

## Jobs and Workflows

### Code Review Workflow

```yaml
Trigger: pull-request-opened, code-review-request
Agents: code-assistant → github-manager
```

Automated code review with quality analysis and GitHub integration.

### Repository Management

```yaml
Trigger: create-repository, issue-created
Agents: github-manager → slack-communicator
```

Repository operations with team notifications.

### Database Operations

```yaml
Trigger: database-analysis-request, performance-issue
Agents: database-analyst → memory-keeper
```

Database analysis with persistent knowledge storage.

### Build Monitoring

```yaml
Trigger: build-failed, deployment-failed
Agents: ci-cd-monitor → error-tracker → slack-communicator
```

Comprehensive build failure response with error tracking and notifications.

### Project Health Check

```yaml
Trigger: health-check-request, weekly-report
Agents: github-manager, database-analyst, error-tracker, ci-cd-monitor, code-assistant (parallel)
```

Comprehensive project analysis combining multiple data sources.

## Setup Instructions

### Prerequisites

1. **Environment Variables** - Configure the following in your `.env` file:

```bash
# GitHub Integration
GITHUB_TOKEN=your_github_token

# Database Connection
DB_HOST=localhost
DB_PORT=5432
DB_NAME=your_database
DB_USER=your_username
DB_PASSWORD=your_password

# Slack Integration
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your_signing_secret

# AWS Credentials
AWS_ACCESS_KEY_ID=your_access_key
AWS_SECRET_ACCESS_KEY=your_secret_key
AWS_DEFAULT_REGION=us-east-1

# CI/CD Integration
CIRCLECI_API_TOKEN=your_circleci_token

# Error Tracking
SENTRY_AUTH_TOKEN=your_sentry_token
```

2. **MCP Server Dependencies** - Ensure the following MCP servers are available:
   - GitHub MCP Server
   - Filesystem MCP Server
   - PostgreSQL MCP Server
   - Slack MCP Server
   - AWS MCP Server
   - CircleCI MCP Server
   - Sentry MCP Server

### Quick Start

1. **Setup the workspace:**

```bash
cd examples/workspaces/multi-purpose-dev
./setup.sh
```

2. **Setup MCP servers (required for agents):**

```bash
./setup-mcp-servers.sh
```

3. **Start MCP servers:**

```bash
cd mcp-servers
./start-all-mcp.sh
```

4. **Start the workspace server:**

```bash
cd ..
./start-workspace.sh
```

5. **Test with signals:**

```bash
# In another terminal
./test-signals.sh
```

## Usage Examples

### 1. Automated Code Review

```bash
# Trigger when opening a PR (webhook) or manually
atlas signal trigger code-review-request '{
  "files": ["src/api/users.ts", "src/models/user.ts"],
  "focus_areas": ["security", "performance", "best-practices"]
}'
```

### 2. Project Setup

```bash
# Create a new project with boilerplate
atlas signal trigger project-setup '{
  "project_name": "my-app",
  "project_type": "nodejs",
  "template": "express-typescript"
}'
```

### 3. Infrastructure Deployment

```bash
# Deploy AWS resources
atlas signal trigger deploy-infrastructure '{
  "template_path": "./infrastructure/app.yml",
  "environment": "staging",
  "parameters": {"InstanceType": "t3.micro"}
}'
```

### 4. Research and Documentation

```bash
# Research a specific topic
atlas signal trigger research-request '{
  "topic": "Node.js performance optimization",
  "focus_areas": ["memory management", "async patterns"]
}'
```

### 5. Team Communication

```bash
# Send status update
atlas signal trigger status-update-request '{
  "message": "Deployment to staging completed successfully",
  "channels": ["#development", "#general"],
  "priority": "normal"
}'
```

### 6. Comprehensive Health Check

```bash
# Weekly project analysis
atlas signal trigger health-check-request '{
  "project_name": "my-app",
  "scope": ["code-quality", "performance", "security", "dependencies"]
}'
```

## Signal Types

### Manual Triggers (CLI)

- `code-review-request`
- `create-repository`
- `database-analysis-request`
- `file-operation-request`
- `research-request`
- `deploy-infrastructure`
- `health-check-request`

### Webhook Triggers

- `pull-request-opened` (GitHub)
- `issue-created` (GitHub)
- `build-failed` (CI/CD)
- `error-spike` (Sentry)
- `infrastructure-alert` (AWS)

### Scheduled Triggers

- `weekly-report` (Cron-based)

## Architecture Highlights

### Multi-Agent Coordination

The workspace demonstrates various execution strategies:

- **Sequential**: Agents process in order (code-review → notification)
- **Parallel**: Agents work simultaneously (health-check analysis)
- **Conditional**: Agents execute based on signal conditions

### Knowledge Persistence

The `memory-keeper` agent maintains persistent knowledge across sessions:

- Project context and history
- Code patterns and preferences
- Team communication patterns
- Infrastructure configurations

### Error Handling

Each agent includes robust error handling:

- Retry logic for transient failures
- Graceful degradation for service outages
- Clear error reporting and escalation

## Best Practices

### Security

- All credentials stored in environment variables
- Access controls on filesystem operations
- Database permissions properly scoped
- Webhook signatures validated

### Performance

- Parallel execution where possible
- Intelligent caching via memory-keeper
- Timeout controls for long-running operations
- Resource usage monitoring

### Maintainability

- Clear separation of concerns
- Comprehensive logging and monitoring
- Version-controlled configurations
- Documented APIs and schemas

## Extending the Workspace

### Adding New Agents

1. Create a new job specification in `jobs/`
2. Add agent configuration to `workspace.yml`
3. Define appropriate signals and triggers
4. Test with manual signal triggers

### Custom Workflows

1. Define new job combinations in `workspace.yml`
2. Create custom signal schemas
3. Configure execution strategies (sequential/parallel)
4. Add error handling and notifications

## MCP Servers Management

### Installed MCP Servers

The setup script installs these MCP servers:

1. **GitHub MCP Server** - Official GitHub integration
2. **Filesystem MCP Server** - File system operations
3. **PostgreSQL MCP Server** - Database interactions
4. **Fetch MCP Server** - Web content fetching
5. **Slack MCP Server** - Team communication
6. **Memory MCP Server** - Persistent knowledge storage
7. **AWS MCP Server** - Cloud infrastructure (community/placeholder)
8. **CircleCI MCP Server** - CI/CD monitoring (placeholder)
9. **Sentry MCP Server** - Error tracking (placeholder)

### MCP Server Commands

```bash
# Setup all MCP servers
./setup-mcp-servers.sh

# Start all MCP servers
cd mcp-servers && ./start-all-mcp.sh

# Stop all MCP servers
cd mcp-servers && ./stop-all-mcp.sh

# Check MCP server status
ps aux | grep mcp

# View MCP server logs
tail -f mcp-servers/logs/*.log
```

### MCP Server Configuration

Some servers require additional configuration:

- **AWS MCP**: Replace placeholder with actual AWS MCP implementation
- **CircleCI MCP**: Replace with real CircleCI MCP server
- **Sentry MCP**: Replace with actual Sentry MCP implementation

## Troubleshooting

### Common Issues

1. **Agent Connection Failures**

   - Ensure MCP servers are running: `ps aux | grep mcp`
   - Check MCP server logs: `tail -f mcp-servers/logs/*.log`
   - Verify credentials in `.env` file
   - Check network connectivity to MCP endpoints

2. **Signal Processing Errors**

   - Validate signal schemas
   - Check trigger conditions (removed problematic conditions)
   - Review agent configurations
   - Ensure all referenced agents are defined

3. **Performance Issues**

   - Monitor agent execution times
   - Check resource usage
   - Review parallel execution limits
   - Monitor MCP server response times

4. **MCP Server Issues**
   - Check if Node.js is installed
   - Verify environment variables are loaded
   - Review individual MCP server logs
   - Restart failed MCP servers individually

### Debugging Commands

```bash
# Check workspace status
./test-signals.sh

# Validate configuration
./setup.sh

# View workspace logs
tail -f ~/.atlas/logs/workspaces/multi-purpose-dev.log

# Check MCP servers
ps aux | grep mcp
cd mcp-servers && ls -la logs/

# Restart MCP servers
cd mcp-servers && ./stop-all-mcp.sh && ./start-all-mcp.sh
```

## Support and Resources

- **Atlas Documentation**: [docs.atlas.ai](https://docs.atlas.ai)
- **MCP Specifications**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Community Examples**: [github.com/atlas-examples](https://github.com/atlas-examples)

---

This workspace demonstrates the power of Atlas for orchestrating complex development workflows
through specialized AI agents. Each agent brings specific capabilities while working together to
create a comprehensive development automation platform.
