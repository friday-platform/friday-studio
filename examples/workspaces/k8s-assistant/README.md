# Kubernetes Assistant Workspace

A demonstration of Atlas AI agent orchestration for Kubernetes management, combining multiple
specialized agents with **real-time event streaming** to provide intelligent cluster operations and autonomous monitoring.

## Overview

This workspace demonstrates Atlas's advanced capabilities including:

- **Multi-Agent Coordination** - Orchestrates specialized AI agents
- **Stream Signal Providers** - Real-time event streaming from external monitor agents  
- **Smart Event Routing** - Critical events trigger immediate responses, all events enable comprehensive monitoring
- **Production-Ready Architecture** - Circuit breakers, retry logic, and health monitoring

### Agent Architecture

1. **k8s-main-agent (Port 8080)** - Primary AI agent handling user requests and Kubernetes operations
2. **k8s-monitor-agent (Port 8082)** - Real-time event monitoring **configured as signal provider**
3. **local-assistant** - LLM-based fallback agent for documentation and support

### Signal Types

1. **HTTP Signals** - Direct API endpoints for user requests
2. **CLI Signals** - Command-line driven operations
3. **🆕 Stream Signals** - Real-time event streaming from monitor agent via SSE

## Quick Start

### 1. Clone and Setup K8s Agent Demo

```bash
# Clone the k8s-agent-demo repository
git clone git@github.com:tempestteam/k8s-agent-demo.git
cd k8s-agent-demo

# Set API key
export GEMINI_API_KEY="your_api_key_here"
# OR
export AI_API_KEY="your_api_key_here"

# Build and run
make start-agents
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
└── MONITOR_AGENT_PLAN.md # Monitor agent integration plan
```

## Configuration

The `workspace.yml` file defines:

- **Agent Mappings** - Remote agent connections and capabilities
- **Signal Configurations** - HTTP and CLI endpoints
- **Memory Settings** - Operation history and patterns
- **Server Settings** - Port, logging, etc.

### Available Signals

1. **`http-k8s`** - Unified HTTP endpoint for all Kubernetes operations
   - **Type**: HTTP Signal Provider
   - **Path**: `/signal/http-k8s`
   - **Method**: POST
   - **Agents**: k8s-main-agent → local-assistant (sequential)

2. **`cli-k8s`** - CLI interface for direct operations
   - **Type**: CLI Signal Provider
   - **Command**: `k8s`
   - **Agents**: k8s-main-agent only

3. **🆕 `k8s-events`** - Real-time Kubernetes event streaming
   - **Type**: Stream Signal Provider
   - **Source**: k8s-monitor-agent via SSE endpoint (`/events/stream`)
   - **Endpoint**: `http://localhost:8082`
   - **Event Types**: Pod failures, deployment issues, node problems
   - **Routing**: Critical events → main agent, all events → Atlas monitoring
   - **Agents**: k8s-main-agent → local-assistant (sequential)
   - **Filters**: Configurable by resource type and event severity

## How It Works

### User-Initiated Operations (HTTP/CLI Signals)
1. **Signal Triggered** - User sends request via HTTP or CLI
2. **Main Agent Processes** - Analyzes request using ReAct framework  
3. **Local Assistant Supports** - Provides documentation and fallback
4. **Memory Updates** - Stores successful patterns and resolutions

### Real-Time Event Monitoring (Stream Signals)
1. **Monitor Agent Watches** - k8s-monitor-agent observes cluster events in real-time
2. **Smart Event Routing**:
   - **Critical Events** → Sent directly to main agent for immediate response
   - **All Events** → Streamed to Atlas via SSE for comprehensive monitoring
3. **Atlas Processing** - Stream signal triggers k8s-main-agent → local-assistant workflow
4. **Unified Response** - Coordinated handling prevents duplicate actions

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
```

### Stream Signal Testing (Real-time Events)

The k8s-events stream signal automatically processes Kubernetes events. To test:

```bash
# Create a failing deployment to trigger events
kubectl create deployment test-fail --image=invalid:latest

# Monitor Atlas logs to see stream signal processing
atlas logs --follow

# Check SSE endpoint directly (optional)
curl -H "Accept: text/event-stream" http://localhost:8082/events/stream
```

### Health Check

```bash
# Check workspace health
curl http://localhost:3001/health

# Check monitor agent health
curl http://localhost:8082/health
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

- [Monitor Agent Integration Plan](MONITOR_AGENT_PLAN.md)
- [Debug Guide](DEBUG_GUIDE.md)
- [Agent Architecture Analysis](AGENT_ARCHITECTURE_ANALYSIS.md)

This workspace demonstrates how Atlas can orchestrate multiple AI agents to provide intelligent
Kubernetes management, combining the power of AI with the flexibility of the Atlas platform.
