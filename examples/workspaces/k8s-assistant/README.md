# Kubernetes Assistant Workspace

A demonstration of Atlas AI agent orchestration for Kubernetes management, combining multiple specialized agents to provide intelligent cluster operations and autonomous monitoring.

## Overview

This workspace shows how Atlas coordinates multiple AI agents for Kubernetes management:

1. **Main Agent** - Handles user requests and generates Kubernetes deployments
2. **Evaluator Agent** - Validates and evaluates deployments
3. **Monitor Agent** - Provides real-time event monitoring
4. **Local Assistant** - Provides documentation and fallback support

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
# Run quick start script to verify setup
./scripts/quick-start.sh

# Deploy a test application
./scripts/deploy-nginx.sh

# Check deployment status
./scripts/troubleshoot.sh deployments
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

## How It Works

1. **Signal Triggered** - User sends request via HTTP or CLI
2. **Main Agent Processes** - Analyzes request using ReAct framework
3. **Evaluator Validates** - Checks deployment configuration
4. **Monitor Watches** - Observes cluster events in real-time
5. **Local Assistant Supports** - Provides documentation and fallback
6. **Memory Updates** - Stores successful patterns and resolutions

## Available Endpoints

### Deployment Management

```bash
# Create deployment
curl -X POST http://localhost:3001/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Deploy nginx with 3 replicas"
  }'

# Scale deployment
curl -X POST http://localhost:3001/scale \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Scale nginx to 5 replicas"
  }'
```

### Cluster Operations

```bash
# Health check
curl http://localhost:3001/health

# List resources
curl -X POST http://localhost:3001/list \
  -H "Content-Type: application/json" \
  -d '{
    "message": "List all pods in default namespace"
  }'

# Troubleshoot issues
curl -X POST http://localhost:3001/troubleshoot \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Check why my deployment is not ready"
  }'
```

## CLI Usage

```bash
# Direct k8s operations
atlas signal trigger cli-k8s --message "Create a namespace called production"

# Deployment management
atlas signal trigger cli-deploy --message "Deploy Redis with persistent storage"
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

This workspace demonstrates how Atlas can orchestrate multiple AI agents to provide intelligent Kubernetes management, combining the power of AI with the flexibility of the Atlas platform. 