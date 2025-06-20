# Atlas Getting Started Guide

Welcome to **Atlas** - the comprehensive AI agent orchestration platform that transforms software
delivery through human/AI collaboration.

## 📋 Table of Contents

- [Quick Start](#quick-start)
- [Prerequisites](#prerequisites)
- [Installation](#installation)
- [Creating Your First Workspace](#creating-your-first-workspace)
- [Understanding Jobs and Signals](#understanding-jobs-and-signals)
- [Working with the TUI](#working-with-the-tui)
- [Natural Language Job Creation](#natural-language-job-creation)
- [Example Workflows](#example-workflows)
- [Troubleshooting](#troubleshooting)

## 🚀 Quick Start

Get Atlas running in 5 minutes:

```bash
# 1. Clone and install
git clone <atlas-repo>
cd atlas
./install.sh

# 2. Set up environment
echo "ANTHROPIC_API_KEY=your-key-here" > .env

# 3. Create a workspace
deno task atlas workspace init my-first-workspace
cd my-first-workspace

# 4. Start the interactive TUI
deno task atlas tui
```

## 📦 Prerequisites

- **Deno** v1.40+ (latest LTS recommended)
- **Anthropic API Key** for LLM functionality
- **Git** for workspace management
- **Optional**: Docker for containerized agents

### System Requirements

- **OS**: macOS, Linux, or Windows (WSL recommended)
- **Memory**: 4GB RAM minimum, 8GB recommended
- **Storage**: 2GB free space for Atlas and workspace data

## ⚡ Installation

### Option 1: Automated Installation

```bash
curl -fsSL https://get.atlas.dev/install.sh | sh
```

### Option 2: Manual Installation

```bash
# Clone the repository
git clone <atlas-repo-url>
cd atlas

# Install dependencies
deno cache --reload src/cli.tsx

# Make CLI globally available
deno install --allow-all --name atlas src/cli.tsx

# Verify installation
atlas help
```

### Option 3: Development Setup

```bash
git clone <atlas-repo-url>
cd atlas

# Use the development task runner
deno task atlas help
```

## 🏗️ Creating Your First Workspace

### Step 1: Initialize Workspace

```bash
# Create a new workspace
atlas workspace init my-dev-team

# Navigate to workspace directory
cd my-dev-team
```

This creates a basic workspace structure:

```
my-dev-team/
├── workspace.yml      # Main configuration
├── jobs/             # Job definitions
├── agents/           # Custom agent configurations
└── .atlas/           # Atlas runtime data
```

### Step 2: Configure Your Workspace

Edit `workspace.yml`:

```yaml
workspace:
  name: "My Development Team"
  id: "my-dev-team"
  description: "AI-powered development workflow automation"
  version: "1.0.0"

# Define available signals (triggers)
signals:
  github-webhook:
    provider: "http-webhook"
    path: "/github"
    method: "POST"
    description: "GitHub webhook events"

  manual-trigger:
    provider: "http-webhook"
    path: "/manual"
    method: "POST"
    description: "Manual job triggers"

# Define available agents
agents:
  code-reviewer:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Code review and analysis"
    tools: ["filesystem", "git"]

  deployment-manager:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Deployment orchestration"
    tools: ["kubernetes", "docker"]

# Job references (detailed definitions in jobs/ directory)
jobs:
  code-review-workflow: "jobs/code-review.yml"
  deployment-pipeline: "jobs/deployment.yml"
```

### Step 3: Create Your First Job

Create `jobs/code-review.yml`:

```yaml
name: "code-review-workflow"
description: "Automated code review process"

# Define when this job triggers
triggers:
  - signal: "github-webhook"
    condition: {
      "and": [{ "==": [{ "var": "event.action" }, "opened"] }, { "var": "event.pull_request" }],
    }

# Define execution strategy
execution:
  strategy: "sequential"
  agents:
    - id: "code-reviewer"
      role: "primary-reviewer"
    - id: "deployment-manager"
      role: "deployment-checker"

# Configure session behavior
session_prompts:
  planning: "You are reviewing a GitHub pull request. Focus on code quality, security, and best practices."
  execution: "Provide detailed feedback and actionable suggestions."

# Resource limits
resources:
  estimated_duration_seconds: 300
  cost_limit: 5.00
```

## 📡 Understanding Jobs and Signals

### Signals (Triggers)

Signals are events that trigger job execution:

- **HTTP Webhooks**: GitHub, GitLab, external services
- **CLI Triggers**: Manual job execution
- **Stream Signals**: Real-time data feeds
- **Kubernetes Events**: Pod failures, deployments

### Jobs

Jobs define what happens when signals are received:

- **Multi-Agent Coordination**: Sequential, parallel, or conditional execution
- **Natural Language Configuration**: AI-powered job creation
- **Resource Management**: Cost and time limits
- **Session Prompts**: Context-specific instructions

### Agents

Atlas supports three types of agents:

1. **LLM Agents**: Claude, GPT, or other language models
2. **Tempest Agents**: Pre-built, specialized agents
3. **Remote Agents**: External HTTP services

## 🖥️ Working with the TUI

### Launch the TUI

```bash
# Start from workspace directory
atlas tui

# Or specify workspace
atlas tui --workspace /path/to/workspace
```

### TUI Navigation

- **Tab/j/k**: Navigate between interface elements
- **gg/G**: Jump to top/bottom of logs
- **Ctrl+D/U**: Page navigation
- **y**: Copy log entries
- **Tab**: Switch between conversation and server tabs

### Available Commands

All TUI commands use `/` prefix:

```bash
# Workspace management
/workspace status
/workspace list

# Signal operations  
/signal list
/signal trigger github-webhook '{"action":"opened"}'

# Session management
/session list
/ps

# Agent information
/agent list
/agent describe code-reviewer

# Configuration assistance
/config create-job "Review pull requests and check deployment readiness"
/config validate
/config confirmations
```

## 🤖 Natural Language Job Creation

Atlas can create jobs from natural language descriptions using AI.

### Using the TUI

```bash
# In the TUI, use the config command:
/config create-job "When a GitHub pull request is opened, have the code reviewer check it and then notify Slack"
```

### Using the CLI

```bash
atlas job create --description "Monitor Kubernetes pod failures and automatically restart them" --workspace my-ops-team
```

### Example Job Descriptions

Atlas can understand complex workflows:

- _"When a deployment fails, analyze the logs, check resource usage, and notify the team in Slack
  with a summary"_
- _"On every commit to main branch, run tests, build Docker image, and deploy to staging if tests
  pass"_
- _"Monitor database performance metrics and alert the DBA team if query times exceed 500ms"_

### Confirmation Workflow

For complex conditions, Atlas will ask for confirmation:

```
✅ Job created: "deployment-monitor"
⚠️  The following conditions need confirmation:
   - Trigger condition: "deployment.status == 'failed'"
   
Use `/config confirmations` to review and approve.
```

## 📚 Example Workflows

### 1. Code Review Automation

```yaml
# jobs/github-code-review.yml
name: "github-code-review"
description: "Comprehensive GitHub PR review"

triggers:
  - signal: "github-webhook"
    condition: {
      "or": [
        { "==": [{ "var": "event.action" }, "opened"] },
        { "==": [{ "var": "event.action" }, "synchronize"] },
      ],
    }

execution:
  strategy: "parallel"
  agents:
    - id: "security-scanner"
      role: "security-review"
    - id: "code-quality-checker"
      role: "quality-review"
    - id: "performance-analyzer"
      role: "performance-review"

session_prompts:
  planning: "Analyze the pull request for security, quality, and performance issues."
  execution: "Provide specific, actionable feedback with line numbers and suggestions."
```

### 2. Incident Response

```yaml
# jobs/incident-response.yml
name: "incident-response"
description: "Automated incident detection and response"

triggers:
  - signal: "k8s-events"
    condition: "event.type == 'Warning' && event.reason == 'Failed'"

execution:
  strategy: "sequential"
  agents:
    - id: "incident-detector"
      role: "triage"
    - id: "log-analyzer"
      role: "analysis"
    - id: "slack-notifier"
      role: "communication"

resources:
  estimated_duration_seconds: 120
  cost_limit: 2.00
```

### 3. Database Monitoring

```yaml
# jobs/db-performance-monitor.yml
name: "db-performance-monitor"
description: "Database performance monitoring and optimization"

triggers:
  - signal: "metric-stream"
    condition: "metric.query_time > 500 && metric.db == 'production'"

execution:
  strategy: "conditional"
  agents:
    - id: "db-analyzer"
      role: "performance-analysis"
    - id: "query-optimizer"
      role: "optimization"
      condition: "previous_agent.confidence > 0.8"
```

## 🔧 Troubleshooting

### Common Issues

#### 1. "No workspace found"

```bash
# Solution: Initialize or navigate to workspace
atlas workspace init my-workspace
# OR
cd path/to/existing/workspace
```

#### 2. "ANTHROPIC_API_KEY not set"

```bash
# Solution: Set your API key
echo "ANTHROPIC_API_KEY=your-key-here" > .env
export ANTHROPIC_API_KEY=your-key-here
```

#### 3. "Permission denied" errors

```bash
# Solution: Install with proper permissions
deno install --allow-all --name atlas src/cli.tsx
```

#### 4. "Agent not found"

Check your `workspace.yml` agent configuration:

```yaml
agents:
  my-agent:
    type: "llm" # Must be: llm, tempest, or remote
    model: "claude-3-5-sonnet-20241022" # Required for LLM agents
```

#### 5. TUI not starting

```bash
# Check TypeScript compilation
deno check src/cli.tsx

# Run with debug flags
deno task atlas tui --trace-leaks
```

### Debug Commands

```bash
# Check workspace configuration
atlas workspace validate

# View detailed logs
atlas logs <session-id> --verbose

# Test signal configuration
atlas signal test github-webhook

# Check agent connectivity
atlas agent test code-reviewer
```

### Log Locations

- **Workspace logs**: `~/.atlas/logs/workspaces/`
- **Session logs**: `~/.atlas/logs/sessions/`
- **Agent logs**: `~/.atlas/logs/agents/`

### Getting Help

```bash
# CLI help
atlas help
atlas workspace help
atlas signal help

# TUI help
/help

# Community resources
# - Documentation: https://docs.atlas.dev
# - Discord: https://discord.gg/atlas-dev  
# - GitHub Issues: https://github.com/atlas/issues
```

## 🎯 Next Steps

After completing this guide:

1. **Explore Example Workspaces**: Check `examples/workspaces/` for pre-built configurations
2. **Customize Agents**: Create your own agent configurations for specific use cases
3. **Set Up Integrations**: Connect Atlas to your existing tools (GitHub, Slack, Kubernetes)
4. **Create Complex Workflows**: Build multi-step automation using natural language
5. **Monitor Performance**: Use the TUI to track job execution and optimize workflows

## 📖 Additional Resources

- **[Configuration Architecture](docs/CONFIGURATION_ARCHITECTURE.md)**: Deep dive into workspace
  configuration
- **[Agent Types Guide](docs/AGENT_TYPES.md)**: Comprehensive agent development
- **[Signal Processing](docs/ENHANCED_SIGNAL_PROCESSING.md)**: Advanced signal configuration
- **[Memory Management](docs/memory-model-flow.md)**: Understanding Atlas memory systems
- **[CLI Reference](docs/CLI_SHORTHANDS.md)**: Complete command reference

---

**Welcome to the future of AI-powered software delivery!** 🚀

Atlas transforms how teams collaborate with AI agents to build, deploy, and maintain software. Start
small with simple jobs and gradually build sophisticated multi-agent workflows that revolutionize
your development process.
