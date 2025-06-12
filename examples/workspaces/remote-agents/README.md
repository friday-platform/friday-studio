# Remote ACP Workspace Example

This workspace demonstrates how to configure and use remote agents with Atlas using a local Agent Communication Protocol (ACP) server.

## Overview

This example includes:

1. **Local ACP Server**: A simple Hono-based server implementing ACP v0.2.0
2. **Example Agents**: Echo and Chat agents for testing
3. **Workspace Configuration**: Complete Atlas workspace setup using remote agents
4. **Job Definitions**: Various execution patterns and strategies

## Quick Start

### 1. Start the ACP Server

```bash
# From the atlas root directory
deno task example-acp-server
```

The server will start on `http://localhost:8000` with two agents:
- **echo**: Analyzes and echoes user input with statistics
- **chat**: Provides conversational responses

### 2. Test the ACP Server

```bash
# Health check
curl http://localhost:8000/ping

# List available agents
curl http://localhost:8000/agents

# Get agent details
curl http://localhost:8000/agents/echo
curl http://localhost:8000/agents/chat

# Test echo agent
curl -X POST http://localhost:8000/runs \
  -H "Content-Type: application/json" \
  -d '{
    "agent_name": "echo",
    "input": [
      {
        "role": "user",
        "parts": [
          {
            "content_type": "text/plain",
            "content": "Hello, echo agent!"
          }
        ]
      }
    ],
    "mode": "sync"
  }'

# Test chat agent with streaming
curl -X POST http://localhost:8000/runs \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{
    "agent_name": "chat",
    "input": [
      {
        "role": "user", 
        "parts": [
          {
            "content_type": "text/plain",
            "content": "How are you doing today?"
          }
        ]
      }
    ],
    "mode": "stream"
  }'
```

### 3. Use with Atlas

```bash
# Start Atlas workspace (in another terminal)
cd examples/remote-acp-workspace
atlas workspace serve

# Test via HTTP signals
curl -X POST http://localhost:3000/echo \
  -H "Content-Type: application/json" \
  -d '{"message": "Test echo functionality"}'

curl -X POST http://localhost:3000/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello chat agent!"}'

# Test dual agent processing
curl -X POST http://localhost:3000/dual \
  -H "Content-Type: application/json" \
  -d '{"message": "Process with both agents"}'
```

## File Structure

```
examples/remote-acp-workspace/
├── README.md           # This documentation
├── workspace.yml       # Atlas workspace configuration
├── server.ts          # ACP server implementation
├── agents.ts          # Agent implementations (echo, chat)
└── types.ts           # ACP protocol type definitions
```

## ACP Server Implementation

### Features

- **Full ACP v0.2.0 Compliance**: Implements all required endpoints
- **Multiple Execution Modes**: Sync, async, and streaming support
- **Agent Discovery**: List and describe available agents
- **Event Streaming**: Server-Sent Events for real-time updates
- **Error Handling**: Proper ACP error responses
- **Session Management**: Basic session tracking

### Available Agents

#### Echo Agent (`/agents/echo`)
- Analyzes input text (word count, sentiment)
- Provides detailed statistics
- Returns processed echo response

#### Chat Agent (`/agents/chat`)
- Conversational responses
- Context-aware replies
- Keyword-based response generation

### Server Endpoints

```
GET  /ping                 - Health check
GET  /agents               - List agents (with pagination)
GET  /agents/{name}        - Get agent details
POST /runs                 - Create run (sync/async/stream)
GET  /runs/{run_id}        - Get run status
POST /runs/{run_id}/cancel - Cancel run
GET  /runs/{run_id}/events - List run events
```

## Workspace Configuration

The `workspace.yml` demonstrates:

### Remote Agent Configuration

```yaml
agents:
  echo-agent:
    type: "remote"
    protocol: "acp"
    endpoint: "http://localhost:8000"
    acp:
      agent_name: "echo"
      default_mode: "sync"
      timeout_ms: 30000
```

### Job Execution Strategies

- **Sequential**: Echo then chat processing
- **Parallel**: Both agents run simultaneously
- **Staged**: Remote agents with local LLM fallback

### Signal Configurations

- **HTTP Endpoints**: `/echo`, `/chat`, `/dual`
- **CLI Commands**: `test-acp`

## Development

### Adding New Agents

1. Create agent class in `agents.ts`:
```typescript
export class MyAgent implements BaseAgent {
  getMetadata(): Agent {
    return {
      name: "my-agent",
      description: "My custom agent",
      // ... metadata
    };
  }

  async processMessage(input: Message[]): Promise<Message[]> {
    // Process logic
  }

  async *processMessageStream(input: Message[]): AsyncGenerator<MessagePart> {
    // Streaming logic
  }
}
```

2. Register in agent registry:
```typescript
export const agents = new Map<string, BaseAgent>([
  ["echo", new EchoAgent()],
  ["chat", new ChatAgent()],
  ["my-agent", new MyAgent()], // Add here
]);
```

### Extending the Server

The server is built with Hono and can be extended with:
- Authentication middleware
- Rate limiting
- Request validation
- Database persistence
- Advanced session management

## Testing Different Modes

### Synchronous Mode
```bash
curl -X POST http://localhost:8000/runs \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"echo","input":[...],"mode":"sync"}'
```

### Asynchronous Mode
```bash
curl -X POST http://localhost:8000/runs \
  -H "Content-Type: application/json" \
  -d '{"agent_name":"echo","input":[...],"mode":"async"}'

# Then poll for results
curl http://localhost:8000/runs/{run_id}
```

### Streaming Mode
```bash
curl -X POST http://localhost:8000/runs \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"agent_name":"chat","input":[...],"mode":"stream"}'
```

## Error Handling

The server implements proper ACP error responses:

```json
{
  "code": "not_found",
  "message": "Agent 'nonexistent' not found"
}
```

Error codes:
- `server_error`: Internal server errors
- `invalid_input`: Invalid request format
- `not_found`: Agent or run not found

## Performance

- **Memory Storage**: All data stored in memory (restart clears)
- **Concurrent Requests**: Hono handles multiple simultaneous requests
- **Streaming**: Real-time event streaming with proper backpressure

## Security Notes

- **No Authentication**: Local server has no auth for simplicity
- **CORS Enabled**: Allows cross-origin requests
- **Input Validation**: Basic validation on agent names and request format

## Next Steps

1. **Add Authentication**: Implement bearer token or API key auth
2. **Persistent Storage**: Replace in-memory storage with database
3. **Advanced Agents**: Create more sophisticated agent implementations
4. **Production Deployment**: Deploy server with proper monitoring
5. **Schema Validation**: Add JSON Schema validation for inputs/outputs

## Troubleshooting

### Server Won't Start
- Check if port 8000 is available
- Verify Deno installation and permissions

### Atlas Can't Connect
- Ensure ACP server is running on port 8000
- Check firewall/network settings
- Verify workspace.yml endpoint configuration

### Agent Errors
- Check server logs for detailed error messages
- Verify agent names match exactly (case-sensitive)
- Test agents directly via curl before using with Atlas

## Architecture Benefits

This example demonstrates the power of Atlas's remote agent architecture:

1. **Protocol Agnostic**: Easy to add other protocols (A2A, custom HTTP)
2. **Fault Tolerant**: Circuit breakers and fallback strategies
3. **Observable**: Comprehensive logging and monitoring
4. **Scalable**: Can connect to multiple remote agent providers
5. **Secure**: Proper authentication and validation patterns

The local ACP server serves as a foundation for understanding how to integrate Atlas with any ACP-compliant agent system, from simple demonstration agents to production AI services.