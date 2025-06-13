# Playwright MCP Example

This example demonstrates how to integrate the
[Microsoft Playwright MCP server](https://github.com/microsoft/playwright-mcp) with Atlas using the
Model Context Protocol (MCP) adapter.

## Overview

This workspace showcases:

- **MCP Protocol Integration**: Using Atlas's MCP adapter to communicate with external MCP servers
- **Browser Automation**: Leveraging Playwright's web automation capabilities through MCP
- **Hybrid Agent Workflows**: Combining browser automation with LLM analysis
- **Tool Safety**: Demonstrating tool allowlisting and denylisting for security

## Architecture

```
┌─────────────────┐    HTTP/MCP     ┌──────────────────┐    stdio    ┌─────────────────────┐
│   Atlas MCP     │ ◄─────────────► │  Wrapper Server  │ ◄─────────► │ Playwright MCP      │
│   Adapter       │                 │  (server.ts)     │             │ (@microsoft/...)    │
└─────────────────┘                 └──────────────────┘             └─────────────────────┘
```

The wrapper server (`server.ts`) acts as a bridge between Atlas's HTTP-based MCP adapter and the
Playwright MCP server, which communicates over stdio.

## Prerequisites

1. **Node.js and npm**: Required for running the Playwright MCP server
2. **Deno**: Required for running the Atlas workspace and wrapper server
3. **Playwright browsers**: Will be installed automatically by the Playwright MCP

## Setup

1. **Install Playwright MCP globally**:
   ```bash
   npm install -g @microsoft/playwright-mcp
   ```

2. **Install Playwright browsers** (if not already installed):
   ```bash
   npx playwright install
   ```

## Running the Example

### Step 1: Start the Wrapper Server

The wrapper server bridges Atlas MCP adapter with Playwright MCP:

```bash
# Start the wrapper server
./start-server.sh
```

Or manually from the project root:

```bash
deno task example-playwright-mcp-server
```

The server will start on `http://localhost:8001` and automatically connect to the Playwright MCP
server.

### Step 2: Test the Wrapper Server

Verify the wrapper is working:

```bash
# Health check
curl http://localhost:8001/ping

# List available Playwright tools
curl http://localhost:8001/tools

# Test a simple navigation
curl -X POST http://localhost:8001/execute \
  -H "Content-Type: application/json" \
  -d '{"tool":"navigate","arguments":{"url":"https://example.com"}}'
```

### Step 3: Run Atlas Workspace

In a separate terminal, start the Atlas workspace:

```bash
# Navigate to the workspace directory
cd examples/workspaces/playwright-mcp

# Start Atlas workspace server
atlas workspace serve
```

### Step 4: Trigger Analysis Jobs

Test the integrated workflow:

```bash
# Trigger webpage analysis
atlas signal trigger manual-analysis --payload '{"url": "https://example.com"}'

# Trigger UI interaction test
atlas signal trigger ui-test --payload '{
  "url": "https://example.com", 
  "actions": [{"type": "click", "selector": "a[href=\"#\"]"}]
}'
```

## Available Playwright Tools

The Playwright MCP server provides these browser automation tools:

- **navigate**: Navigate to a URL
- **screenshot**: Take a screenshot of the current page
- **click**: Click on an element
- **fill**: Fill form inputs
- **extract_text**: Extract text content from elements
- **get_page_title**: Get the page title
- **wait_for_element**: Wait for elements to appear

## Workspace Configuration

The workspace defines two main jobs:

### webpage-analysis

Combines browser automation with AI analysis:

1. **playwright-browser** agent navigates and captures page data
2. **web-analyst** LLM agent analyzes the content for insights

### ui-interaction-test

Performs UI testing workflows:

1. **playwright-browser** agent executes UI interactions
2. Takes before/after screenshots for validation

## Security Features

The workspace demonstrates MCP security features:

- **Tool Allowlisting**: Only approved Playwright tools can be executed
- **Tool Denylisting**: Dangerous operations like `exec` and `shell` are blocked
- **Timeout Configuration**: 60-second timeout for browser operations

## Development

### Extending the Wrapper

To add custom functionality to the wrapper server:

1. Modify `server.ts` to add new HTTP endpoints
2. Implement additional MCP protocol features (resources, prompts)
3. Add custom authentication or rate limiting

### Custom Job Creation

Create new jobs by:

1. Adding job definitions to `workspace.yml`
2. Defining agent roles and instructions
3. Creating corresponding signals for triggering

## Troubleshooting

### Common Issues

1. **Playwright MCP not found**:
   ```bash
   npm install -g @microsoft/playwright-mcp
   ```

2. **Browser not installed**:
   ```bash
   npx playwright install chromium
   ```

3. **Connection refused**:
   - Ensure wrapper server is running on port 8001
   - Check firewall settings

4. **Tool execution timeout**:
   - Increase `timeout_ms` in workspace.yml
   - Check browser performance

### Debug Mode

Enable debug logging:

```bash
DEBUG=* deno task example-playwright-mcp-server
```

## Next Steps

This example provides a foundation for:

- **E2E Testing Workflows**: Automated browser testing with AI validation
- **Web Scraping Pipelines**: Intelligent content extraction and analysis
- **Accessibility Auditing**: Automated accessibility testing with AI insights
- **Performance Monitoring**: Browser-based performance testing with analysis

## Related Examples

- `remote-agents/`: Basic ACP protocol integration
- Other MCP examples: Coming soon

## Resources

- [Playwright MCP Server](https://github.com/microsoft/playwright-mcp)
- [Model Context Protocol Specification](https://modelcontextprotocol.io/)
- [Atlas MCP Adapter Documentation](../../../docs/MCP_ADAPTER_IMPLEMENTATION_PLAN.md)
