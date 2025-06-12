# Kubernetes Assistant Workspace

This Atlas workspace provides intelligent Kubernetes management capabilities by connecting to the k8s-deployment-demo main agent via the Agent Communication Protocol (ACP). The workspace enables natural language interaction with Kubernetes clusters through AI-powered agents.

## Overview

This workspace includes:

1. **Remote K8s Agent**: Connection to the k8s main agent running ReAct framework
2. **Local Assistant**: Fallback LLM agent for documentation and explanations  
3. **HTTP Signals**: REST API endpoints for various Kubernetes operations
4. **CLI Signals**: Command-line interface for direct operations
5. **Memory Management**: Workspace-level memory for operation history and patterns

## Architecture

```
┌─────────────────┐    ACP     ┌────────────────────┐
│                 │ Protocol   │                    │
│ Atlas Workspace │◄──────────►│ K8s Main Agent     │
│                 │            │ (ReAct + AI)       │
└─────────┬───────┘            └────────────────────┘
          │                             │
          │                             │
          ▼                             ▼
┌─────────────────┐            ┌────────────────────┐
│ HTTP/CLI        │            │ Kubernetes API     │
│ Signals         │            │ kubectl Tools      │
└─────────────────┘            └────────────────────┘
```

## Prerequisites

1. **K8s Main Agent**: The k8s-deployment-demo main agent must be running on port 8080
2. **Kubernetes Access**: kubectl configured with cluster access
3. **AI API Key**: Gemini API key set for the k8s agent
4. **Atlas**: Atlas platform installed and configured

## Quick Start

### 1. Start the K8s Main Agent

```bash
# In the k8s-deployment-demo directory
cd k8s-deployment-demo
export GEMINI_API_KEY="your_api_key_here"

# Start the main agent
make start-agents
# OR manually:
go run ./cmd/main-agent --debug --port 8080
```

### 2. Verify Agent Connection

```bash
# Test ACP connectivity
curl http://localhost:8080/health
curl http://localhost:8080/agent

# Should return agent metadata and capabilities
```

### 3. Start Atlas Workspace

```bash
# From the atlas root directory
cd atlas/examples/workspaces/k8s-assistant

# Start the workspace
atlas workspace serve
```

The workspace will start on `http://localhost:3001` with the following endpoints available.

## Available Endpoints

### Deployment Management

#### Create Deployment
```bash
curl -X POST http://localhost:3001/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Deploy nginx with 3 replicas and expose it as a service"
  }'
```

#### Scale Deployment
```bash
curl -X POST http://localhost:3001/scale \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Scale my nginx deployment to 5 replicas"
  }'
```

### Cluster Operations

#### Health Check
```bash
curl http://localhost:3001/health
```

#### List Resources
```bash
curl -X POST http://localhost:3001/list \
  -H "Content-Type: application/json" \
  -d '{
    "message": "List all pods in the default namespace"
  }'
```

#### Troubleshooting
```bash
curl -X POST http://localhost:3001/troubleshoot \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Check why my deployment is not ready"
  }'
```

#### General Assistance
```bash
curl -X POST http://localhost:3001/assist \
  -H "Content-Type: application/json" \
  -d '{
    "message": "How do I create a service mesh with Istio?"
  }'
```

## Example Use Cases

### 1. Deploy a Web Application

```bash
curl -X POST http://localhost:3001/deploy \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Create a deployment for httpd web server with 2 replicas, expose it on port 80, and create a LoadBalancer service"
  }'
```

### 2. Troubleshoot Pod Issues

```bash
curl -X POST http://localhost:3001/troubleshoot \
  -H "Content-Type: application/json" \
  -d '{
    "message": "My pod is in ImagePullBackOff state, help me fix it"
  }'
```

### 3. Scale Applications

```bash
curl -X POST http://localhost:3001/scale \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Increase replicas for my web-app deployment to handle more traffic"
  }'
```

### 4. Get Cluster Information

```bash
curl -X POST http://localhost:3001/list \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Show me all deployments and their status across all namespaces"
  }'
```

## CLI Usage

The workspace also supports CLI commands:

```bash
# Direct k8s operations
atlas signal trigger cli-k8s --message "Create a namespace called production"

# Deployment management
atlas signal trigger cli-deploy --message "Deploy Redis with persistent storage"
```

## Agent Configuration

### K8s Main Agent

- **Endpoint**: `http://localhost:8080`
- **Protocol**: ACP (Agent Communication Protocol)
- **Timeout**: 60 seconds (for complex k8s operations)
- **Retries**: 2 attempts
- **Circuit Breaker**: Opens after 3 failures, stays open for 2 minutes

### Local Assistant

- **Model**: Claude 3.5 Sonnet
- **Purpose**: Fallback support, documentation, explanations
- **Tools**: computer_use enabled

## Memory and Learning

The workspace maintains memory of:

- **Deployment History**: Previous deployment configurations and outcomes
- **Troubleshooting Patterns**: Common issues and their resolutions
- **Successful Configurations**: Working setups for future reference
- **Error Resolutions**: How past errors were resolved

Memory is retained for 7 days with up to 500 entries.

## Advanced Configuration

### Authentication (Production)

For production environments, enable authentication:

```yaml
agents:
  k8s-main-agent:
    auth:
      type: "bearer"
      token_env: "K8S_AGENT_TOKEN"
```

### Custom Timeouts

Adjust timeouts for complex operations:

```yaml
acp:
  timeout_ms: 120000  # 2 minutes for complex deployments
  max_retries: 3
```

### Circuit Breaker Tuning

Modify circuit breaker settings:

```yaml
monitoring:
  circuit_breaker:
    failure_threshold: 5
    timeout_ms: 300000  # 5 minutes
    half_open_max_calls: 1
```

## Integration Examples

### With CI/CD Pipeline

```bash
# Deploy from CI/CD
curl -X POST http://localhost:3000/deploy \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ATLAS_TOKEN" \
  -d '{
    "message": "Deploy application version $BUILD_VERSION with rolling update strategy"
  }'
```

### With Monitoring Systems

```bash
# Automated troubleshooting triggered by alerts
curl -X POST http://localhost:3000/troubleshoot \
  -H "Content-Type: application/json" \
  -d '{
    "message": "High memory usage detected in production namespace, investigate and suggest optimizations"
  }'
```

## Troubleshooting

### Connection Issues

1. **Agent Not Found**:
   ```bash
   # Verify k8s agent is running
   curl http://localhost:8080/health
   ```

2. **Timeout Errors**:
   - Increase timeout in workspace.yml
   - Check cluster connectivity
   - Verify kubectl access

3. **ACP Protocol Errors**:
   - Check agent logs for detailed error messages
   - Verify ACP compatibility

### Performance Optimization

1. **Adjust Timeouts**: Increase for complex operations
2. **Tune Circuit Breaker**: Adjust thresholds based on cluster size
3. **Memory Management**: Configure retention based on usage patterns

## Development

### Adding New Signals

1. Define new signal in `workspace.yml`:

```yaml
signals:
  http-custom:
    description: "Custom Kubernetes operation"
    provider: "http"
    path: "/custom"
    method: "POST"
    jobs:
      - name: "custom-operation"
        execution:
          strategy: "sequential"
          agents:
            - id: "k8s-main-agent"
```

### Extending Agent Capabilities

The k8s main agent supports various tools:
- Kubernetes Deployment creation/management
- Pod operations and monitoring
- Service configuration
- Namespace management
- Health checks and validation

## Security Considerations

1. **Network Security**: Ensure proper firewall rules
2. **Authentication**: Use tokens in production
3. **RBAC**: Configure appropriate Kubernetes RBAC
4. **API Keys**: Secure AI API keys properly

## Monitoring and Logging

- **Atlas Logs**: Check workspace execution logs
- **Agent Logs**: Monitor k8s agent debug output  
- **Kubernetes Events**: Watch cluster events for deployment status
- **Circuit Breaker**: Monitor failure patterns and recovery

## Next Steps

1. **Production Deployment**: Configure authentication and security
2. **Custom Tools**: Extend the k8s agent with additional tools
3. **Integration**: Connect with existing monitoring and CI/CD systems
4. **Scaling**: Deploy multiple agent instances for high availability

This workspace provides a foundation for intelligent Kubernetes management through natural language interaction, leveraging the power of AI agents and the flexibility of the Atlas platform. 