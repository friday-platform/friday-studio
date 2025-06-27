# Kubernetes Assistant Workspace

A demonstration of Atlas AI agent orchestration for Kubernetes management, combining multiple
specialized agents with **real-time event streaming** to provide intelligent cluster operations and
autonomous monitoring.

## Overview

This workspace demonstrates Atlas's advanced capabilities including:

- **Multi-Agent Coordination** - Orchestrates specialized AI agents
- **Built-in Signal Providers** - Real-time event streaming via direct Kubernetes API integration
- **Smart Event Routing** - Critical events trigger immediate responses, all events enable
  comprehensive monitoring
- **Production-Ready Architecture** - Circuit breakers, retry logic, and health monitoring

### Agent Architecture (DevOps Workflow)

1. **standalone-coordinator (Port 8085)** - K8s operations specialist that executes cluster tasks
   and returns structured results (NO Linear access)
2. **linear-writer** - Complete Linear integration agent that manages ticket lifecycle and processes
   K8s results
3. **DevOps Flow**: Linear ticket → linear-writer → standalone-coordinator → linear-writer → Linear
   update

### Signal Types

1. **HTTP Signals** - Direct API endpoints for user requests
2. **CLI Signals** - Command-line driven operations
3. **🆕 K8s Events Signals** - Built-in real-time Kubernetes Events streaming via Events API

## Quick Start (Atlas 2.0)

### 1. Setup Standalone Coordinator Agent

```bash
# Start your standalone coordinator agent on port 8085
# This should be your k8s management agent running at:
# http://localhost:8085

# Ensure your agent provides:
# - /health endpoint for health checks
# - ACP protocol support for agent communication
# - Kubernetes management capabilities
```

### 2. Setup and Start the Workspace (Atlas 2.0)

```bash
# Navigate to the workspace directory
cd atlas/examples/workspaces/k8s-assistant

# Run setup script to create necessary files
./setup.sh

# Start the workspace using Atlas 2.0 daemon architecture
./start-workspace.sh
```

**Atlas 2.0 Changes:**

- Uses centralized daemon architecture (no individual workspace servers)
- Atlas daemon runs on `http://localhost:8080`
- Workspaces are managed by the daemon, not standalone servers

### 3. Test the Setup

```bash
# Deploy a test application (nginx)
./scripts/deploy-nginx.sh

# Check for failed pods
./scripts/list-failed-pods.sh

# Run troubleshooting
./scripts/troubleshoot.sh
```

### 4. Monitor Progress (Atlas 2.0)

```bash
# List active sessions
atlas ps

# View workspace status
atlas workspace status k8s-assistant

# View workspace logs
atlas workspace logs k8s-assistant

# Check daemon status
atlas daemon status
```

## Project Structure

```
k8s-assistant/
├── workspace.yml           # Workspace configuration
├── start-workspace.sh      # Quick start script
├── setup.sh               # Setup script
├── test.sh               # Test script
├── scripts/              # Helper scripts
├── .atlas/              # Runtime data (gitignored)
└── README.md            # This documentation
```

## Configuration

The `workspace.yml` file defines:

- **Job Definitions** - Workflow specifications for different operation types
- **Agent Mappings** - Remote agent connections and capabilities
- **Signal Configurations** - HTTP, CLI, and built-in k8s-events endpoints
- **Memory Settings** - Operation history and patterns
- **Server Settings** - Port, logging, etc.

### Available Signals & Workflows (Atlas 2.0)

1. **`linear-webhook`** - DevOps workflow automation (PRIMARY)
   - **Type**: HTTP Signal Provider
   - **Endpoint**: `/webhooks/linear` (via daemon)
   - **Method**: POST
   - **Workflow**: Linear ticket → linear-writer → standalone-coordinator → linear-writer → Linear
     update
   - **Agent Flow**:
     - linear-writer: Process ticket, set In Progress
     - standalone-coordinator: Execute K8s operations (returns structured results)
     - linear-writer: Update Linear with results and status
   - **Triggers**:
     - DevOps issues (keywords: kubernetes, kubectl, deploy, scale, etc.)
     - DevOps comments (containing kubectl commands)
     - High-priority incidents assigned to Atlas

2. **`http-k8s`** - Direct Kubernetes operations (OPTIONAL)
   - **Type**: HTTP Signal Provider
   - **Path**: `/k8s`
   - **Method**: POST
   - **Agent**: standalone-coordinator (direct execution, no Linear integration)

3. **`cli-k8s`** - CLI interface for direct operations (OPTIONAL)
   - **Type**: CLI Signal Provider
   - **Command**: `k8s`
   - **Agent**: standalone-coordinator (direct execution, no Linear integration)

## How It Works (DevOps Workflow)

### Primary DevOps Workflow (Linear → K8s → Linear)

**Step 1: Linear Ticket Processing**

1. **Linear webhook triggered** - Issue created/updated with DevOps keywords
2. **linear-writer agent** - Analyzes ticket content for K8s operations needed
3. **Ticket updated** - Status set to "In Progress", comment added about automation

**Step 2: K8s Operations Execution**\
4. **standalone-coordinator agent** - Receives structured task from linear-writer 5. **K8s
execution** - Performs kubectl operations (deploy, scale, troubleshoot, etc.) 6. **Structured
results** - Returns JSON-formatted operation results (no Linear access)

**Step 3: Linear Results Processing & Update** 7. **linear-writer agent** - Receives structured
results from standalone-coordinator 8. **Results formatting** - Converts technical data to
user-friendly Linear comments 9. **Ticket completion** - Status updated to Done/Escalated,
comprehensive results posted 10. **Memory storage** - Successful patterns and resolutions stored for
learning

**Key Separation**: standalone-coordinator handles ONLY K8s operations, linear-writer handles ALL
Linear interactions

### Direct Operations (Optional)

- **HTTP API**: Direct K8s operations via `/k8s` endpoint
- **CLI Interface**: Command-line driven operations via `atlas signal trigger`

## Available Endpoints (Atlas 2.0)

### DevOps Workflow Triggers

```bash
# Trigger DevOps workflow with K8s issue
curl -X POST http://localhost:8080/signals/linear-webhook \
  -H "Content-Type: application/json" \
  -H "Linear-Event: Issue" \
  -d '{
    "action": "create",
    "data": {
      "type": "Issue",
      "title": "Deploy nginx to production namespace",
      "description": "Need to deploy nginx with 3 replicas to production namespace with proper resource limits"
    }
  }'

# Trigger via DevOps comment
curl -X POST http://localhost:8080/signals/linear-webhook \
  -H "Content-Type: application/json" \
  -H "Linear-Event: Comment" \
  -d '{
    "action": "create",
    "data": {
      "type": "Comment",
      "body": "kubectl scale deployment nginx --replicas=5"
    }
  }'
```

### CLI DevOps Triggers

```bash
# Trigger DevOps workflow via CLI
atlas signal trigger linear-webhook --workspace k8s-assistant --data '{
  "action": "create",
  "data": {
    "type": "Issue",
    "title": "Kubernetes deployment issue",
    "description": "kubectl get pods shows failing pods in default namespace"
  }
}'

# Direct K8s operation (optional)
atlas signal trigger http-k8s --workspace k8s-assistant --data '{
  "message": "Deploy nginx with 3 replicas"
}'
```

### Test Workflows

```bash
# Test simple Linear integration
curl -X POST http://localhost:8080/signals/linear-webhook \
  -H "Content-Type: application/json" \
  -H "Linear-Event: Issue" \
  -d '{
    "action": "create",
    "data": {
      "type": "Issue",
      "title": "Test Linear MCP integration"
    }
  }'
```

### Health Check (Atlas 2.0)

```bash
# Check Atlas daemon health
curl http://localhost:8080/health

# Check daemon status via CLI
atlas daemon status

# Check workspace status
atlas workspace status k8s-assistant

# Check standalone coordinator agent health
curl http://localhost:8085/health
```

## CLI Usage (Atlas 2.0)

```bash
# Trigger Linear webhook signal
atlas signal trigger linear-webhook --workspace k8s-assistant --data '{
  "action": "create",
  "data": {
    "type": "Issue",
    "title": "Test from CLI"
  }
}'

# List active sessions
atlas ps

# Check workspace status
atlas workspace status k8s-assistant

# View workspace logs
atlas workspace logs k8s-assistant

# Stop daemon when done
atlas daemon stop
```

### Enabling K8s Operations (Optional)

To enable the K8s operations that are currently commented out:

1. Uncomment the desired jobs and agents in `workspace.yml`
2. Restart the workspace: `./start-workspace.sh`
3. Use the signals:

```bash
# Would work after uncommenting http-k8s signal
# atlas signal trigger http-k8s --workspace k8s-assistant --data '{"message": "Create a namespace called production"}'

# Would work after uncommenting cli-k8s signal  
# atlas signal trigger cli-k8s --workspace k8s-assistant --data '{"message": "Deploy Redis with persistent storage"}'
```

## Customization

To modify the workspace:

1. Edit agent configurations in `workspace.yml`
2. Add new signals for custom operations
3. Configure memory retention settings
4. Adjust circuit breaker parameters
5. Restart the workspace server

## Security Considerations

1. **Authentication** - Enable bearer tokens in production
2. **RBAC** - Configure appropriate Kubernetes permissions
3. **API Keys** - Secure AI API keys properly
4. **Network** - Ensure proper firewall rules
5. **Kubeconfig Security** - Protect kubeconfig files and limit access
6. **TLS Validation** - Use proper certificates in production (avoid `insecure: true`)

## Troubleshooting

- **"Agent not found"** - Verify k8s-agent-demo is running
- **"Timeout errors"** - Check cluster connectivity
- **"ACP errors"** - Verify agent compatibility
- **"Memory issues"** - Check retention settings

## Next Steps

1. **Production Setup** - Configure authentication and security
2. **Custom Tools** - Extend agent capabilities
3. **Integration** - Connect with monitoring systems
4. **Scaling** - Deploy multiple agent instances

## Additional Resources

- [Atlas Documentation](../../../docs/)
- [K8s Events Provider Source](../../../src/core/providers/builtin/k8s-events.ts)
- [K8s Auth Manager Source](../../../src/core/providers/builtin/k8s-auth.ts)
- [Unit Tests](../../../tests/unit/providers/)

This workspace demonstrates how Atlas can orchestrate multiple AI agents to provide intelligent
Kubernetes management, combining the power of AI with the flexibility of the Atlas platform.
