# Atlas Quick Reference

Essential commands and workflows for Atlas AI agent orchestration platform.

## 🚀 Installation & Setup

```bash
# Install Atlas
curl -fsSL https://get.atlas.dev/install.sh | sh

# Set up environment
echo "ANTHROPIC_API_KEY=your-key" > .env

# Create workspace
atlas workspace init my-workspace
cd my-workspace

# Start TUI
atlas tui
```

## 📁 Workspace Structure

```
my-workspace/
├── workspace.yml      # Signals, agents, job references
├── atlas.yml          # Platform configuration (auto-generated)
├── jobs/              # Detailed job specifications
│   ├── job1.yml
│   └── job2.yml
└── .atlas/            # Runtime data, cache, logs
```

## 🖥️ TUI Commands

**Navigation:**
- `Tab` / `j` / `k` - Navigate interface
- `gg` / `G` - Jump to top/bottom
- `Ctrl+D` / `Ctrl+U` - Page up/down
- `y` - Copy log entry

**Workspace:**
```bash
/workspace status        # Show workspace info
/workspace list          # List available workspaces
```

**Signals & Jobs:**
```bash
/signal list            # List configured signals
/signal trigger name    # Trigger signal manually
/ps                     # List active sessions
/session list           # Show session details
```

**Agents:**
```bash
/agent list             # Show workspace agents
/agent describe name    # Get agent details
```

**Configuration (Tab 3):**
```bash
/config create-job "description"    # AI-powered job creation
/config validate                    # Check workspace config
/config confirmations              # Review AI-generated conditions
```

## 📋 Job Creation

### Natural Language (Recommended)
```bash
# In TUI Tab 3:
/config create-job "When a GitHub PR is opened, review the code and post results to Slack"
```

### Manual Job File
```yaml
# jobs/my-job.yml
name: "my-workflow"
description: "Custom workflow description"

triggers:
  - signal: "github-webhook"
    condition: "event.action == 'opened'"

execution:
  strategy: "sequential"  # sequential | parallel | staged | conditional
  agents:
    - id: "agent1"
      role: "primary"
    - id: "agent2" 
      role: "secondary"

resources:
  estimated_duration_seconds: 300
  cost_limit: 5.00
```

## 🤖 Agent Types

### LLM Agent
```yaml
agents:
  ai-assistant:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Code analysis and review"
    tools: ["filesystem", "web-search"]
```

### Tempest Agent (First-party)
```yaml
agents:
  k8s-operator:
    type: "tempest"
    version: "1.0.0"
    source: "tempest://kubernetes-operator"
```

### Remote Agent (HTTP service)
```yaml
agents:
  external-api:
    type: "remote"
    endpoint: "https://api.service.com/v1/process"
    authentication:
      type: "bearer"
      token: "${API_TOKEN}"
```

## 📡 Signal Types

### HTTP Webhook
```yaml
signals:
  github-webhook:
    provider: "http-webhook"
    path: "/github"
    method: "POST"
```

### Kubernetes Events
```yaml
signals:
  k8s-events:
    provider: "k8s-events"
    namespace: "production"
    event_types: ["Warning", "Error"]
```

### Manual Trigger
```bash
# Trigger from CLI
atlas signal trigger webhook-name --data '{"key": "value"}'

# Trigger from TUI
/signal trigger webhook-name
```

## 🔧 Execution Strategies

### Sequential
```yaml
execution:
  strategy: "sequential"
  agents:
    - id: "step1"
    - id: "step2"  # Runs after step1
    - id: "step3"  # Runs after step2
```

### Parallel
```yaml
execution:
  strategy: "parallel"
  agents:
    - id: "task1"  # All run simultaneously
    - id: "task2"
    - id: "task3"
```

### Staged (Dependencies)
```yaml
execution:
  strategy: "staged"
  agents:
    - id: "analysis"
    - id: "processing"
      dependencies: ["analysis"]
    - id: "reporting"
      dependencies: ["processing"]
```

### Conditional
```yaml
execution:
  strategy: "conditional"
  agents:
    - id: "checker"
    - id: "fixer"
      condition: "checker.issues_found > 0"
```

## 🔍 Condition Examples

### Simple Conditions
```yaml
condition: "event.action == 'opened'"
condition: "metric.cpu_usage > 80"
condition: "status == 'failed'"
```

### Complex Conditions (JSONLogic)
```yaml
condition: |
  {
    "and": [
      {"==": [{"var": "event.action"}, "opened"]},
      {"in": [{"var": "event.label"}, ["bug", "urgent"]]}
    ]
  }
```

### Natural Language (AI-parsed)
```yaml
naturalLanguageCondition: "when CPU usage is above 80% and memory is low"
```

## 📊 Monitoring & Debugging

### Session Management
```bash
atlas ps                          # List active sessions
atlas session get <session-id>    # Get session details
atlas logs <session-id>           # View session logs
atlas session kill <session-id>   # Terminate session
```

### Workspace Status
```bash
atlas workspace status     # Show workspace health
atlas workspace validate   # Check configuration
atlas agent test <name>     # Test agent connectivity
```

### Performance
```bash
# In TUI:
/perf summary              # Performance overview
/perf cache-stats          # Cache hit/miss rates
/perf memory-usage         # Memory utilization
```

## 🔒 Security Best Practices

### Environment Variables
```bash
# .env file
ANTHROPIC_API_KEY=sk-ant-...
GITHUB_TOKEN=ghp_...
SLACK_WEBHOOK_URL=https://hooks.slack.com/...
```

### Secure Configurations
```yaml
# Reference environment variables
agents:
  github-client:
    type: "remote"
    authentication:
      token: "${GITHUB_TOKEN}"  # From environment
```

### Workspace Isolation
- Each workspace has isolated cache and memory
- Cross-workspace access is automatically blocked
- Agent permissions are workspace-scoped

## 🚨 Common Issues & Solutions

### "No workspace found"
```bash
# Initialize or navigate to workspace
atlas workspace init my-workspace
# OR
cd /path/to/workspace
```

### "ANTHROPIC_API_KEY not set"
```bash
echo "ANTHROPIC_API_KEY=your-key" > .env
export ANTHROPIC_API_KEY=your-key
```

### "Agent not found"
```bash
# Check workspace.yml agent configuration
atlas workspace validate
/agent list  # In TUI
```

### "Signal trigger failed"
```bash
# Test signal configuration
atlas signal test signal-name
/signal list  # Check signal status in TUI
```

### TUI Issues
```bash
# Restart TUI with debug info
deno task atlas tui --trace-leaks

# Check compilation
deno check src/cli.tsx
```

## 📚 Example Workflows

### Code Review Automation
```yaml
triggers:
  - signal: "github-webhook"
    condition: "event.action == 'opened'"
execution:
  strategy: "parallel"
  agents:
    - id: "security-scanner"
    - id: "code-quality-checker"
    - id: "performance-analyzer"
```

### Incident Response
```yaml
triggers:
  - signal: "k8s-events"
    condition: "event.type == 'Warning'"
execution:
  strategy: "sequential"
  agents:
    - id: "incident-triager"
    - id: "log-analyzer"
    - id: "slack-notifier"
```

### Deployment Pipeline
```yaml
triggers:
  - signal: "github-webhook"
    condition: "event.ref == 'refs/heads/main'"
execution:
  strategy: "staged"
  agents:
    - id: "test-runner"
    - id: "security-scanner"
      dependencies: ["test-runner"]
    - id: "deployer"
      dependencies: ["security-scanner"]
      condition: "previous_agents.all_passed == true"
```

## 🎯 Quick Start Checklist

- [ ] Install Atlas and set API key
- [ ] Create and navigate to workspace
- [ ] Configure basic signals and agents in `workspace.yml`
- [ ] Create first job using `/config create-job` in TUI
- [ ] Test with `/signal trigger` or external webhook
- [ ] Monitor execution with `/ps` and `/session list`
- [ ] Iterate and improve based on results

## 📖 More Resources

- **Full Guide**: `GETTING_STARTED.md`
- **Advanced Setup**: `WORKSPACE_SETUP_GUIDE.md`
- **Architecture**: `CLAUDE.md`
- **Examples**: `examples/workspaces/`