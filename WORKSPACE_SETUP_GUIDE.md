# Atlas Workspace Setup & Job Creation Guide

This guide covers the advanced workspace setup and job creation features implemented in Atlas, including the natural language job creation system and workspace configuration assistant.

## 📋 Table of Contents

- [Workspace Architecture Overview](#workspace-architecture-overview)
- [Job Definition System](#job-definition-system)
- [Natural Language Job Creation](#natural-language-job-creation)
- [Configuration Assistant (TUI)](#configuration-assistant-tui)
- [Advanced Job Patterns](#advanced-job-patterns)
- [Security and Cache Management](#security-and-cache-management)
- [Performance Optimization](#performance-optimization)

## 🏗️ Workspace Architecture Overview

Atlas workspaces follow a hierarchical configuration model:

```
workspace/
├── workspace.yml          # User configuration (signals, agents, job references)
├── atlas.yml              # Platform configuration (supervisors, planning)
├── jobs/                  # Job specification files
│   ├── code-review.yml
│   ├── deployment.yml
│   └── monitoring.yml
└── .atlas/                # Runtime data and cache
    ├── cache/
    ├── logs/
    └── memory/
```

### Configuration Separation

**workspace.yml** (User-managed):
```yaml
workspace:
  name: "Development Team"
  id: "dev-team-workspace"

signals:
  github-webhook:
    provider: "http-webhook"
    path: "/github"

agents:
  code-reviewer:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"

jobs:
  code-review: "jobs/code-review.yml"
```

**atlas.yml** (Platform-managed):
```yaml
planning:
  workspace_supervisor:
    enabled: true
    model: "claude-3-5-sonnet-20241022"
    
  session_supervisor:
    enabled: true
    model: "claude-3-5-sonnet-20241022"

runtime:
  server:
    port: 8080
    host: "localhost"
  
  persistence:
    type: "file"
    path: ".atlas"
```

## 📋 Job Definition System

### Job Specification Schema

Jobs are defined using YAML files with the following structure:

```yaml
name: "deployment-pipeline"
description: "Automated deployment with safety checks"

# Trigger configuration
triggers:
  - signal: "github-webhook"
    condition: "event.action == 'closed' && event.pull_request.merged == true"
    naturalLanguageCondition: "when a pull request is merged to main branch"

# Execution strategy
execution:
  strategy: "staged"  # sequential | parallel | staged | conditional
  agents:
    - id: "security-scanner"
      role: "security-validation"
    - id: "deployment-manager"
      role: "deployment-execution"
      dependencies: ["security-scanner"]

# Session customization
session_prompts:
  planning: "You are managing a production deployment. Prioritize safety and rollback capabilities."
  execution: "Execute deployment steps with comprehensive logging and health checks."
  evaluation: "Verify deployment success and system stability."

# Resource constraints
resources:
  estimated_duration_seconds: 600
  cost_limit: 10.00
  max_retries: 2

# Success criteria
success_criteria:
  type: "all"
  conditions:
    - description: "Deployment completed successfully"
    - description: "Health checks passed"
    - description: "No error logs in monitoring"
```

### Multi-Agent Types

Atlas supports three agent types in job execution:

#### 1. LLM Agents
```yaml
agents:
  ai-reviewer:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    purpose: "Code review and analysis"
    tools: ["filesystem", "git", "web-search"]
    prompts:
      system: "You are an expert code reviewer focusing on security and performance."
```

#### 2. Tempest Agents (First-party)
```yaml
agents:
  k8s-operator:
    type: "tempest"
    version: "1.2.0"
    source: "tempest://kubernetes-operator"
    config:
      cluster_endpoint: "${K8S_ENDPOINT}"
      auth_method: "service-account"
```

#### 3. Remote Agents (HTTP services)
```yaml
agents:
  external-scanner:
    type: "remote"
    endpoint: "https://api.security-scanner.com/v1/scan"
    authentication:
      type: "bearer"
      token: "${SCANNER_API_TOKEN}"
    schema:
      input: "scan-request.json"
      output: "scan-result.json"
```

## 🤖 Natural Language Job Creation

Atlas includes an AI-powered system that converts natural language descriptions into structured job configurations.

### Using Natural Language in the TUI

```bash
# Start the TUI
atlas tui

# Navigate to the Workspace Config tab (Tab 3)
# Use the natural language job creation command:
/config create-job "When a GitHub issue is labeled 'bug', assign it to the on-call engineer and create a Slack notification"
```

### Natural Language Parsing Process

1. **Intent Recognition**: AI analyzes the description to identify:
   - Trigger conditions (signals and events)
   - Required agents and their roles  
   - Execution flow and dependencies
   - Success criteria and constraints

2. **Entity Extraction**: The system identifies:
   - Signal types (`github-webhook`, `slack-notification`)
   - Agent capabilities needed (`issue-manager`, `notification-sender`)
   - Execution patterns (`sequential`, `parallel`, `conditional`)

3. **Structured Generation**: Creates proper job YAML with:
   - Workspace-scoped agent references
   - Safe condition expressions (using JSONLogic)
   - Appropriate execution strategies
   - Resource estimates

### Example Natural Language Inputs

**Simple Workflow**:
```
"Send a Slack message when a deployment completes"
```

Generated job:
```yaml
name: "deployment-notification"
triggers:
  - signal: "deployment-webhook"
    condition: "event.status == 'completed'"
execution:
  strategy: "sequential"
  agents:
    - id: "slack-notifier"
      role: "notification"
```

**Complex Multi-Agent Workflow**:
```
"When a production error occurs, analyze the logs with AI, check system metrics, create a GitHub issue, and notify the team in Slack with a summary"
```

Generated job:
```yaml
name: "production-error-response"
triggers:
  - signal: "error-monitoring"
    condition: "event.severity == 'critical' && event.environment == 'production'"
execution:
  strategy: "staged"
  agents:
    - id: "log-analyzer"
      role: "analysis"
    - id: "metrics-checker"
      role: "monitoring"
    - id: "github-manager"
      role: "issue-creation"
      dependencies: ["log-analyzer", "metrics-checker"]
    - id: "slack-notifier"
      role: "team-notification"
      dependencies: ["github-manager"]
```

### Condition Parsing with AI

Atlas uses AI to convert natural language conditions into safe, executable expressions:

**Natural Language**: *"when CPU usage is above 80% and memory is low"*

**Generated JSONLogic**:
```json
{
  "and": [
    { ">": [{ "var": "metrics.cpu_usage" }, 80] },
    { "<": [{ "var": "metrics.memory_available" }, { "var": "metrics.memory_threshold" }] }
  ]
}
```

## 🖥️ Configuration Assistant (TUI)

The Atlas TUI includes a dedicated "Workspace Config" tab with AI-powered configuration assistance.

### Accessing the Configuration Assistant

1. Start the TUI: `atlas tui`
2. Navigate to Tab 3 (Workspace Config)
3. Use configuration commands with `/config` prefix

### Available Commands

#### Create Jobs from Natural Language
```bash
/config create-job "Description of the workflow you want to create"
```

#### Validate Workspace Configuration
```bash
/config validate
```
Checks for:
- Invalid agent references
- Missing signal configurations
- Malformed job specifications
- Security issues

#### Manage Condition Confirmations
```bash
/config confirmations
```
Review and approve AI-generated conditions that need human confirmation.

### Configuration Assistant Features

#### 1. Workspace Context Analysis
The assistant automatically analyzes your current workspace to understand:
- Available signals and their payload structures
- Configured agents and their capabilities
- Existing jobs and patterns
- Workspace-specific naming conventions

#### 2. Intelligent Job Creation
- **Agent Selection**: Automatically matches job requirements to available agents
- **Execution Strategy**: Determines optimal execution patterns (sequential, parallel, staged)
- **Resource Estimation**: Provides duration and cost estimates
- **Error Handling**: Includes appropriate fallback and retry logic

#### 3. Validation and Safety
- **Security Checks**: Validates all generated configurations for security issues
- **Agent Verification**: Ensures referenced agents exist and are properly configured
- **Signal Validation**: Checks that signal references are valid and accessible

#### 4. Human-in-the-Loop Confirmation
For complex conditions that the AI cannot parse with high confidence:
```
⚠️ Condition requires confirmation:
Original: "when deployment fails and more than 5 users are affected"
Parsed: {"and": [{"==": [{"var": "deployment.status"}, "failed"]}, {">": [{"var": "incident.affected_users"}, 5]}]}
Confidence: 72%

Options:
1. Approve as-is
2. Edit condition
3. Use natural language fallback
```

## 🔧 Advanced Job Patterns

### Conditional Execution
```yaml
execution:
  strategy: "conditional"
  agents:
    - id: "security-scanner"
      role: "security-check"
    - id: "vulnerability-fixer"
      role: "remediation"
      condition: "previous_agent.vulnerabilities_found > 0"
    - id: "compliance-reporter"
      role: "reporting"
      condition: "security_scanner.compliance_score < 0.8"
```

### Iterative Refinement
```yaml
execution:
  strategy: "iterative"
  max_iterations: 3
  agents:
    - id: "code-generator"
      role: "implementation"
    - id: "test-runner"
      role: "validation"
    - id: "quality-checker"
      role: "evaluation"
  
  refinement_criteria:
    - "test_coverage >= 80%"
    - "quality_score >= 8.0"
    - "no_critical_issues == true"
```

### Cross-Job Dependencies
```yaml
name: "integration-test-suite"
dependencies:
  - job: "unit-tests"
    status: "completed"
    timeout_minutes: 10
  - job: "deployment-staging"
    status: "completed"

triggers:
  - signal: "job-completion"
    condition: "all_dependencies_met == true"
```

## 🔒 Security and Cache Management

### Cache Sharing Security

Atlas implements secure cache sharing between WorkspaceSupervisor and SessionSupervisor with multiple protection layers:

#### 1. Workspace Isolation
```typescript
// Cache keys are workspace-scoped to prevent collisions
const secureKey = `plan:${workspaceId}:${jobName}`;

// Access validation prevents cross-workspace leakage
function validateWorkspaceAccess(requestingId: string, supervisorId: string): boolean {
  return requestingId === supervisorId;
}
```

#### 2. Data Sanitization
```typescript
// Sensitive data is automatically removed from cached plans
const sensitiveFields = [
  'workspaceSecrets', 'privateKeys', 'authTokens', 'apiKeys',
  'passwords', 'credentials', 'internalConfig'
];
```

#### 3. Input Validation
```typescript
// Plan keys are validated to prevent injection attacks
const validKeyPattern = /^[a-zA-Z0-9\-_:]+$/;
const maxKeyLength = 256;
```

### Cache Performance Optimization

The cache sharing system provides significant performance improvements:

- **Zero LLM Calls**: Precomputed plans eliminate 10-15 second planning delays
- **Instant Plan Lookup**: Cached execution plans load in milliseconds
- **Resource Efficiency**: Avoids redundant LLM API calls and planning computation

## ⚡ Performance Optimization

### Precomputed Plan Caching

Atlas precomputes execution plans during workspace initialization:

```yaml
# atlas.yml - Configure plan precomputation
planning:
  precomputation:
    enabled: true
    cache_duration_hours: 24
    background_refresh: true
  
  cache_sharing:
    enabled: true
    security_validation: true
    workspace_isolation: true
```

### Signal Analysis Optimization

Fast signal processing using precomputed patterns:

```yaml
# Precomputed signal patterns eliminate 20-second LLM calls
signal_analysis:
  precomputed_patterns:
    - signal_type: "github-webhook"
      conditions:
        - pattern: "pull_request.opened"
          job: "code-review"
          confidence: 0.95
        - pattern: "release.published"  
          job: "deployment"
          confidence: 0.98
```

### Memory Optimization

Efficient memory management across supervisor hierarchy:

- **Hierarchical Memory**: WorkspaceSupervisor → SessionSupervisor → Agents
- **Streaming Memory**: Real-time processing for large datasets
- **Memory Scoping**: Agent, session, and workspace-level memory isolation
- **Automatic Cleanup**: TTL-based memory expiration and cleanup

### Monitoring and Analytics

Built-in performance monitoring:

```bash
# View performance metrics in TUI
/perf summary
/perf cache-stats
/perf memory-usage

# CLI performance analysis  
atlas analytics --workspace my-workspace --metrics performance,cache,memory
```

## 🎯 Best Practices

### Job Design
1. **Clear Descriptions**: Use descriptive job names and detailed descriptions
2. **Appropriate Agents**: Match agent capabilities to job requirements
3. **Resource Limits**: Set realistic duration and cost constraints
4. **Error Handling**: Include fallback strategies and retry logic

### Configuration Management
1. **Version Control**: Keep workspace.yml and jobs/ in version control
2. **Environment Variables**: Use environment variables for secrets and config
3. **Validation**: Regularly run `/config validate` to catch issues
4. **Documentation**: Comment complex conditions and workflows

### Performance
1. **Cache Utilization**: Use job specifications to enable plan caching
2. **Agent Reuse**: Design jobs to reuse agents efficiently
3. **Condition Optimization**: Use simple conditions when possible for better caching
4. **Resource Monitoring**: Monitor job execution times and costs

### Security
1. **Secret Management**: Never commit secrets to workspace configuration
2. **Agent Permissions**: Use least-privilege agent configurations
3. **Input Validation**: Validate all external inputs and webhook payloads
4. **Access Control**: Implement proper workspace access controls

This comprehensive system transforms Atlas from a basic agent orchestration platform into a sophisticated, AI-powered workflow automation system that can understand natural language descriptions and convert them into secure, efficient execution plans.