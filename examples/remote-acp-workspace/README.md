# Remote ACP Agent Demo Workspace

This workspace demonstrates Atlas's remote agent capabilities using the Agent Communication Protocol
(ACP). It showcases how to configure, authenticate, and orchestrate external AI agents alongside
local agents.

## Features Demonstrated

### 🌐 Remote Agent Configuration

- **ACP Protocol Support**: Integration with ACP v0.2.0 compliant servers
- **Multiple Authentication Methods**: Bearer tokens, API keys, and basic auth
- **Circuit Breaker Pattern**: Automatic failure detection and recovery
- **Health Monitoring**: Continuous health checks with configurable intervals

### 🔧 Agent Types Configured

1. **external-chat-agent** (`remote/acp`)
   - General purpose conversational AI
   - Bearer token authentication
   - Synchronous execution mode
   - Input/output schema validation

2. **analytics-agent** (`remote/acp`)
   - Data analysis and insights generation
   - API key authentication
   - Asynchronous execution for long-running tasks
   - Extended timeout for complex analysis

3. **local-llm-agent** (`llm`)
   - Local Claude integration for comparison
   - Fallback option when remote agents unavailable

### 📋 Job Orchestration Patterns

1. **Simple Remote Execution**
   - Single remote agent processing
   - Basic request/response pattern

2. **Multi-Agent Sequential**
   - Remote analytics → Local summarization
   - Data flows between agents

3. **Parallel Processing**
   - Multiple remote agents working simultaneously
   - Results aggregated automatically

4. **Staged with Fallback**
   - Primary: Remote agent processing
   - Fallback: Local agent if remote fails

## Configuration Requirements

### Environment Variables

Create a `.env` file with your remote agent credentials:

```bash
# Remote agent authentication tokens
EXTERNAL_CHAT_TOKEN="your-bearer-token-here"
ANALYTICS_API_KEY="your-api-key-here"

# Atlas configuration
ANTHROPIC_API_KEY="your-anthropic-key-for-local-llm"
```

### Remote ACP Servers

This demo assumes you have access to ACP-compliant servers at:

- `https://api.example.com` (chat agent)
- `https://analytics.example.com` (analytics agent)

Replace these with your actual ACP server endpoints.

## Usage Examples

### Start the Workspace

```bash
# Navigate to this directory
cd examples/remote-acp-workspace

# Start Atlas workspace server
atlas workspace serve
```

### Test Remote Agents

```bash
# Test single remote agent
curl -X POST http://localhost:3000/process \\
  -H "Content-Type: application/json" \\
  -d '{"query": "What are the benefits of AI agent orchestration?"}'

# Test comprehensive analysis
curl -X POST http://localhost:3000/analyze \\
  -H "Content-Type: application/json" \\
  -d '{"data": [1,2,3,4,5], "context": "sales figures"}'

# Test via CLI
atlas signal trigger cli-test --payload '{"test": "multi-agent processing"}'
```

### Monitor Agent Health

```bash
# Check workspace status (includes remote agent health)
atlas ps

# View logs for remote agent interactions
tail -f ~/.atlas/logs/workspaces/remote-acp-demo/workspace.log
```

## Architecture Highlights

### Circuit Breaker Protection

Remote agents are protected by circuit breakers that:

- Open after 5 consecutive failures
- Stay open for 60 seconds
- Test recovery with 3 half-open calls

### Authentication Management

- Secure credential handling via environment variables
- Support for multiple auth methods per workspace
- Automatic token refresh capabilities (when supported by ACP server)

### Monitoring & Observability

- Real-time health checks every 60 seconds
- Performance metrics collection
- Structured logging with remote agent context
- Circuit breaker state tracking

## Extending This Example

### Adding More Remote Agents

```yaml
agents:
  my-custom-agent:
    type: "remote"
    protocol: "acp"
    endpoint: "https://my-server.com"
    auth:
      type: "bearer"
      token_env: "MY_CUSTOM_TOKEN"
    acp:
      agent_name: "my-agent"
      default_mode: "stream" # For real-time responses
```

### Custom Job Configurations

```yaml
jobs:
  custom-workflow:
    description: "Custom multi-stage workflow"
    execution:
      strategy: "conditional"
      agents:
        - id: "my-custom-agent"
          condition: "data.type == 'analysis'"
        - id: "external-chat-agent"
          condition: "data.type == 'conversation'"
```

### Advanced Monitoring

```yaml
agents:
  monitored-agent:
    # ... basic config ...
    monitoring:
      enabled: true
      circuit_breaker:
        failure_threshold: 3 # More sensitive
        timeout_ms: 30000 # Faster recovery
      health_check_interval: 30000 # Check every 30s
```

## Troubleshooting

### Common Issues

1. **Authentication Failures**
   - Verify environment variables are set
   - Check token expiration
   - Ensure correct auth type configuration

2. **Connection Timeouts**
   - Increase `timeout_ms` in ACP configuration
   - Check network connectivity to remote servers
   - Verify firewall/proxy settings

3. **Circuit Breaker Activation**
   - Check remote server health
   - Review failure threshold settings
   - Monitor logs for error patterns

### Debug Mode

Enable detailed logging:

```bash
# Set debug logging level
export ATLAS_LOG_LEVEL=debug

# Start workspace with verbose output
atlas workspace serve --log-level debug
```

## Security Best Practices

1. **Credential Management**
   - Use environment variables for tokens
   - Rotate credentials regularly
   - Implement least-privilege access

2. **Network Security**
   - Use HTTPS endpoints only
   - Validate SSL certificates
   - Consider VPN/private networks for sensitive data

3. **Input Validation**
   - Enable schema validation
   - Sanitize user inputs
   - Implement rate limiting

## Performance Optimization

1. **Connection Pooling**
   - Reuse HTTP connections
   - Configure appropriate timeouts
   - Monitor connection metrics

2. **Parallel Execution**
   - Use parallel job strategies where appropriate
   - Balance load across multiple remote agents
   - Cache frequently accessed results

3. **Circuit Breaker Tuning**
   - Adjust thresholds based on SLA requirements
   - Monitor failure patterns
   - Implement gradual backoff strategies
