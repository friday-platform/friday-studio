# Web Analysis Workspace

This workspace demonstrates comprehensive web page analysis using Atlas with Playwright MCP
integration.

## Features Showcased

### 🏗️ **MCP Integration Architecture**

- **Workspace-level MCP registry** - Clean separation of platform and workspace MCP servers
- **AI SDK native integration** - Using `experimental_createMCPClient` with Playwright
- **Type-safe configuration** - Full Zod schema validation throughout the stack
- **Multi-step tool execution** - Agent orchestrates complex browser automation workflows

### 🌐 **Web Analysis Capabilities**

- Navigate to any website URL
- Capture screenshots for visual analysis
- Extract page titles, content, and links
- Analyze content quality and accessibility
- Generate comprehensive reports with recommendations

### 🛠️ **Technical Implementation**

- **Stdio MCP transport** - Running `npx @playwright/mcp@latest` as process
- **Tool filtering** - Configurable allowed/denied tool lists for security
- **Resource management** - Proper cleanup of browser processes and connections
- **Error handling** - Comprehensive error recovery and timeout management

## Quick Start

1. **Setup the workspace:**
   ```bash
   ./setup-workspace.sh
   ```

2. **Configure API keys:** Edit `.env` and add your Anthropic API key

3. **Start the Atlas server:**
   ```bash
   ./start-server.sh
   ```

4. **Trigger analysis:**
   ```bash
   ./trigger-signal.sh "https://example.com"
   ```

## Example Usage

### Basic Analysis

```bash
curl -X POST http://localhost:8080/analyze \
  -H "Content-Type: application/json" \
  -d '{"url": "https://news.ycombinator.com"}'
```

### Detailed Analysis

```bash
curl -X POST http://localhost:8080/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://github.com/anthropics/claude-code",
    "analysis_type": "detailed"
  }'
```

## Architecture Highlights

### MCP Server Configuration

```yaml
mcp_servers:
  playwright:
    transport:
      type: "stdio"
      command: "npx"
      args: ["@playwright/mcp@latest"]
    tools:
      allowed: ["navigate", "screenshot", "extract_text"]
      denied: ["delete_cookies", "clear_storage"]
    timeout_ms: 45000
```

### Agent Configuration

```yaml
agents:
  web-analyzer:
    type: "llm"
    model: "claude-3-5-sonnet-20241022"
    mcp_servers: ["playwright"] # References MCP server
    max_steps: 5 # Multi-step tool execution
    tool_choice: "auto" # AI decides when to use tools
```

## Expected Workflow

1. **Signal received** - HTTP POST with URL to analyze
2. **Agent activation** - LLM agent gets task and MCP server access
3. **Tool execution sequence:**
   - Navigate to URL
   - Capture screenshot
   - Extract page title and content
   - Analyze structure and links
4. **Report generation** - Comprehensive analysis with recommendations

## Troubleshooting

### MCP Server Issues

```bash
# Test MCP server directly
npx @playwright/mcp@latest --help

# Check if browsers are installed
npx playwright install
```

### Atlas Configuration

```bash
# Validate workspace configuration
deno task atlas config validate

# Check server logs
tail -f .atlas/logs/workspace.log
```
