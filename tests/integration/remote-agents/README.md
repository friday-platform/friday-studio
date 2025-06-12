# ACP Adapter Integration Tests

This directory contains integration tests for the ACP (Agent Communication Protocol) adapter
implementation. These tests verify that the `ACPAdapter` works correctly against a real ACP server.

## Overview

The integration test suite includes:

- **Test Server** (`test-server.ts`): A minimal ACP v0.2.0 compliant server for testing
- **Test Agents** (`agents.ts`): Simple test agents with different behaviors
- **Type Definitions** (`types.ts`): ACP protocol types for the test server
- **Integration Tests** (`acp-adapter-integration.test.ts`): Comprehensive test suite

## Test Architecture

```
┌─────────────────┐    HTTP/SSE    ┌─────────────────┐
│   ACPAdapter    │ ──────────────▶ │  ACPTestServer  │
│ (Code Under     │                │  (Local Test    │
│  Test)          │ ◀────────────── │   Server)       │
└─────────────────┘                └─────────────────┘
                                            │
                                            ▼
                                   ┌─────────────────┐
                                   │   Test Agents   │
                                   │ • echo          │
                                   │ • error         │
                                   │ • slow          │
                                   └─────────────────┘
```

## Test Coverage

### Core Functionality

- ✅ Health checks and connectivity
- ✅ Agent discovery and metadata retrieval
- ✅ Sync execution mode
- ✅ Async execution mode
- ✅ Streaming execution mode
- ✅ Session management
- ✅ Run cancellation

### Error Handling

- ✅ Server errors (500)
- ✅ Not found errors (404)
- ✅ Bad request errors (400)
- ✅ Network connection failures
- ✅ Timeout handling
- ✅ Agent processing errors

### Performance & Reliability

- ✅ Concurrent request handling
- ✅ Execution timing metadata
- ✅ Dynamic port allocation
- ✅ Proper resource cleanup

## Running the Tests

### Prerequisites

Ensure you have the required dependencies in your `deno.json`:

```json
{
  "imports": {
    "hono": "npm:hono@^4.0.0",
    "hono/cors": "npm:hono@^4.0.0/cors",
    "hono/http-exception": "npm:hono@^4.0.0/http-exception",
    "hono/streaming": "npm:hono@^4.0.0/streaming"
  }
}
```

### Run Integration Tests

```bash
# Run all ACP integration tests
deno test tests/integration/remote-agents/acp-adapter-integration.test.ts --allow-all

# Run with verbose output
deno test tests/integration/remote-agents/acp-adapter-integration.test.ts --allow-all -v

# Run specific test case
deno test tests/integration/remote-agents/acp-adapter-integration.test.ts --allow-all --filter="Sync execution"
```

### Run All Integration Tests

```bash
# Run all integration tests in the directory
deno test tests/integration/ --allow-all
```

## Test Server Features

The `ACPTestServer` provides:

### Test Agents

1. **Echo Agent** (`echo`)
   - Returns input with "Echo: " prefix
   - Supports all execution modes
   - Used for happy path testing

2. **Error Agent** (`error`)
   - Always throws processing errors
   - Used for error handling testing

3. **Slow Agent** (`slow`)
   - Introduces 2-second delays
   - Used for timeout testing

### Special Behaviors

- **Server Error Simulation**: Request agent name `"server-error"` triggers HTTP 500
- **Dynamic Port Allocation**: Automatically finds available ports 8000-9999
- **SSE Streaming**: Full Server-Sent Events implementation for streaming mode
- **Minimal State**: Static responses, no state management between tests

## Adding New Adapter Tests

To add integration tests for other adapters (A2A, custom):

1. **Create Protocol Directory**:
   ```
   tests/integration/remote-agents/
   ├── acp/                    # ACP-specific tests
   ├── a2a/                    # A2A-specific tests  
   └── custom/                 # Custom adapter tests
   ```

2. **Implement Test Server**:
   - Follow the `ACPTestServer` pattern
   - Implement the specific protocol's API
   - Use dynamic port allocation
   - Provide minimal test agents

3. **Create Integration Tests**:
   - Test core adapter functionality
   - Cover error scenarios
   - Verify protocol-specific features

## Debugging

### Server Logs

The test server logs all requests and responses:

```
🚀 ACP Test Server starting on port 8342
🛑 ACP Test Server stopped
```

### Test Timeouts

Tests have a 10-second timeout. For debugging slow tests:

```typescript
// Increase timeout for specific test
await t.step("Long running test", async () => {
  // Test implementation
}, { timeout: 30000 });
```

### Network Issues

If tests fail with connection errors:

1. Check if ports are available: `netstat -an | grep LISTEN`
2. Verify no firewall blocking: Test with `curl http://localhost:PORT/ping`
3. Check test server startup logs

## Architecture Benefits

This integration test architecture provides:

- **Real Protocol Testing**: Tests actual HTTP/SSE communication
- **Isolation**: Each test run uses different ports
- **Reusability**: Pattern can be extended for other adapters
- **Comprehensive Coverage**: Tests all execution modes and error cases
- **Fast Execution**: Minimal test server with static responses
- **Reliability**: Automatic cleanup and resource management

## Future Enhancements

Potential improvements for expanded testing:

- **Authentication Testing**: Add auth-enabled test server
- **Load Testing**: Concurrent request stress testing
- **Protocol Compliance**: Automated ACP spec validation
- **Performance Benchmarking**: Latency and throughput metrics
- **Fault Injection**: Network partition and failure simulation
