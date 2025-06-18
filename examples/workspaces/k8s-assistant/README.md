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

### Agent Architecture

1. **k8s-main-agent (Port 8080)** - Primary AI agent handling user requests and Kubernetes
   operations
2. **local-assistant** - LLM-based fallback agent for documentation and support
3. **Built-in k8s-events signal provider** - Direct Kubernetes API integration for real-time event
   monitoring

### Signal Types

1. **HTTP Signals** - Direct API endpoints for user requests
2. **CLI Signals** - Command-line driven operations
3. **🆕 K8s Events Signals** - Built-in real-time Kubernetes Events streaming via Events API

## Quick Start

### 1. Setup K8s Agent Demo (Main Agent Only)

```bash
# Clone the k8s-agent-demo repository
git clone git@github.com:tempestteam/k8s-agent-demo.git
cd k8s-agent-demo

# Set API key
export GEMINI_API_KEY="your_api_key_here"
# OR
export AI_API_KEY="your_api_key_here"

# Start only the main agent (monitor agent no longer needed)
make start-main-agent
```

### 2. Setup and Start the Workspace

```bash
# Navigate to the workspace directory
cd atlas/examples/workspaces/k8s-assistant

# Run setup script to create necessary files
./setup.sh

# Start the workspace
./start-workspace.sh
```

The workspace will start on `http://localhost:3001`

### 3. Test the Setup

```bash
# Deploy a test application (nginx)
./scripts/deploy-nginx.sh

# Check for failed pods
./scripts/list-failed-pods.sh

# Run troubleshooting
./scripts/troubleshoot.sh
```

### 4. Monitor Progress

```bash
# List active sessions
atlas ps

# View session details
atlas logs <session-id>
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

### Available Signals

1. **`http-k8s`** - Unified HTTP endpoint for all Kubernetes operations
   - **Type**: HTTP Signal Provider
   - **Path**: `/k8s`
   - **Method**: POST
   - **Agents**: k8s-main-agent only

2. **`cli-k8s`** - CLI interface for direct operations
   - **Type**: CLI Signal Provider
   - **Command**: `k8s`
   - **Agents**: k8s-main-agent only

3. **🆕 `k8s-events`** - Real-time Kubernetes event streaming
   - **Type**: K8s Events Signal Provider (built-in)
   - **Source**: Direct Kubernetes Events API watch integration
   - **Authentication**: Local kubeconfig (`~/.kube/config`)
   - **Scope**: Kubernetes Events in default namespace (or all namespaces)
   - **Event Types**: ADDED, MODIFIED, DELETED Events
   - **Agents**: k8s-main-agent → local-assistant (sequential)
   - **Configuration**: Events-only watching with flexible auth options (kubeconfig, service
     account, direct API)

## How It Works

### User-Initiated Operations (HTTP/CLI Signals)

1. **Signal Triggered** - User sends request via HTTP or CLI
2. **Main Agent Processes** - Analyzes request using ReAct framework
3. **Local Assistant Supports** - Provides documentation and fallback
4. **Memory Updates** - Stores successful patterns and resolutions

### Real-Time Event Monitoring (K8s Events Signals)

1. **Built-in Events Provider** - Atlas directly connects to Kubernetes Events API using watch
   endpoints
2. **Event Monitoring**:
   - **Kubernetes Events Only** → Watches cluster Events (pod failures, deployments, etc.)
   - **Real-time Streaming** → Direct HTTP streaming from K8s Events API
3. **Atlas Processing** - K8s Events trigger k8s-main-agent → local-assistant workflow
4. **Simple Configuration** - Events-only watching with local kubeconfig support

## Available Endpoints

### K8s Operations (Direct API endpoint)

```bash
# Create deployment
curl -X POST http://localhost:3001/k8s \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Deploy nginx with 3 replicas"
  }'

# Scale deployment
curl -X POST http://localhost:3001/k8s \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Scale nginx to 5 replicas"
  }'
```

# List resources

curl -X POST http://localhost:3001/k8s\
-H "Content-Type: application/json"\
-d '{ "message": "List all pods in default namespace" }'

# Troubleshoot issues

curl -X POST http://localhost:3001/k8s\
-H "Content-Type: application/json"\
-d '{ "message": "Check why my deployment is not ready" }'

### K8s Events Signal Testing (Real-time Events)

The k8s-events signal automatically processes Kubernetes events. To test:

```bash
# Create a failing deployment to trigger events
kubectl create deployment test-fail --image=invalid:latest

# Monitor Atlas logs to see k8s events signal processing
atlas logs --follow

# Create/delete pods to see real-time events
kubectl run test-pod --image=nginx --restart=Never
kubectl delete pod test-pod
```

### Health Check

```bash
# Check workspace health
curl http://localhost:3001/health

# Check main agent health (monitor agent no longer needed)
curl http://localhost:8080/health
```

## CLI Usage

```bash
# Direct k8s operations via HTTP signal
deno run --allow-all --unstable-broadcast-channel --unstable-worker-options ../../../src/cli.tsx signal trigger http-k8s --port 3001 --data '{"message": "Create a namespace called production"}'

# Alternative using CLI signal
deno run --allow-all --unstable-broadcast-channel --unstable-worker-options ../../../src/cli.tsx signal trigger cli-k8s --port 3001 --data '{"message": "Deploy Redis with persistent storage"}'
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
