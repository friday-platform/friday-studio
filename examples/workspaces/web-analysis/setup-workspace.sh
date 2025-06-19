#!/bin/bash

# Setup workspace for web analysis with Playwright MCP integration

echo "🕷️  Setting up Atlas workspace for Web Analysis with Playwright MCP..."

# Check Node.js availability for Playwright MCP
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is required for Playwright MCP server"
    echo "   Please install Node.js from: https://nodejs.org/"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo "❌ npm is required for Playwright MCP server"
    echo "   Please install npm (usually comes with Node.js)"
    exit 1
fi

# Check if we're in the correct directory
if [[ ! -f "workspace.yml" ]]; then
    echo "❌ workspace.yml not found. Are you in the web-analysis workspace directory?"
    exit 1
fi

echo "📦 Installing Playwright MCP server..."

# Create package.json for Playwright MCP
cat > package.json << 'EOF'
{
  "name": "atlas-web-analysis-workspace",
  "version": "1.0.0",
  "description": "Atlas workspace for web analysis using Playwright MCP",
  "type": "module",
  "scripts": {
    "mcp-playwright": "npx @playwright/mcp@latest",
    "test-mcp": "npx @playwright/mcp@latest --help"
  },
  "dependencies": {
    "@playwright/mcp": "latest"
  },
  "devDependencies": {
    "playwright": "latest"
  }
}
EOF

# Install Playwright MCP and dependencies
echo "📦 Installing dependencies..."
npm install

# Install Playwright browsers
echo "🌐 Installing Playwright browsers (this may take a few minutes)..."
npx playwright install

# Verify Playwright MCP installation
echo "🔍 Verifying Playwright MCP installation..."
if npx @playwright/mcp@latest --help > /dev/null 2>&1; then
    echo "✅ Playwright MCP server installed successfully!"
else
    echo "❌ Playwright MCP installation failed"
    echo "   Try running: npm install @playwright/mcp@latest"
    exit 1
fi

# Create .atlas directory structure
mkdir -p .atlas/{sessions,logs,screenshots}

# Generate workspace ID
WORKSPACE_ID=$(node -e "console.log(crypto.randomUUID())")

# Create workspace metadata
cat > .atlas/workspace.json << EOF
{
  "id": "$WORKSPACE_ID",
  "name": "Web Analysis with Playwright MCP",
  "description": "Comprehensive web page analysis using Playwright MCP server for browser automation",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")",
  "version": "1.0.0",
  "mcp_servers": {
    "playwright": {
      "status": "configured",
      "transport": "stdio",
      "command": "npx @playwright/mcp@latest",
      "capabilities": ["navigate", "screenshot", "extract_text", "get_page_title", "get_page_links"]
    }
  }
}
EOF

# Check for .env file
if [ ! -f .env ]; then
    echo "📝 Creating .env file..."
    cat > .env << 'EOF'
# Atlas Environment Variables for Web Analysis Workspace

# Anthropic Claude API Key (Required for LLM agent)
# Get from: https://console.anthropic.com/
ANTHROPIC_API_KEY=your_anthropic_api_key_here

# Optional: OpenAI API Key for alternative models
# Get from: https://platform.openai.com/api-keys
OPENAI_API_KEY=your_openai_api_key_here

# Optional: Google AI API Key
# Get from: https://aistudio.google.com/app/apikey
GOOGLE_API_KEY=your_google_api_key_here

# Playwright configuration
PLAYWRIGHT_HEADLESS=true
PLAYWRIGHT_TIMEOUT=30000

# Web analysis settings
WEB_ANALYSIS_SCREENSHOT_DIR=.atlas/screenshots
WEB_ANALYSIS_MAX_PAGES=10
EOF
    echo "⚠️  Please update .env with your Anthropic API key"
fi

# Update .gitignore
if [ -f .gitignore ]; then
    grep -q "^\.env$" .gitignore || echo ".env" >> .gitignore
    grep -q "^\.atlas/$" .gitignore || echo ".atlas/" >> .gitignore
    grep -q "^\*\.log$" .gitignore || echo "*.log" >> .gitignore
    grep -q "^node_modules/$" .gitignore || echo "node_modules/" >> .gitignore
    grep -q "^package-lock\.json$" .gitignore || echo "package-lock.json" >> .gitignore
else
    cat > .gitignore << 'EOF'
.env
.atlas/
*.log
node_modules/
package-lock.json
EOF
fi

# Create a test script to verify MCP integration
cat > test-mcp-integration.sh << 'EOF'
#!/bin/bash

echo "🧪 Testing Playwright MCP integration..."

# Test if MCP server starts properly
echo "1. Testing MCP server startup..."
timeout 10s npx @playwright/mcp@latest --help || {
    echo "❌ MCP server failed to start"
    exit 1
}

echo "✅ MCP server startup test passed"

# Test Atlas configuration
echo "2. Testing Atlas configuration..."
if command -v atlas &> /dev/null; then
    atlas config validate || {
        echo "⚠️  Atlas configuration validation failed (this may be normal if Atlas is not installed)"
    }
else
    echo "⚠️  Atlas CLI not found - configuration validation skipped"
fi

echo "✅ MCP integration test completed"
echo ""
echo "🕷️  Playwright MCP server is ready!"
echo "   You can now start the Atlas workspace server."
EOF

chmod +x test-mcp-integration.sh

# Create README for this workspace
cat > README.md << 'EOF'
# Web Analysis Workspace

This workspace demonstrates comprehensive web page analysis using Atlas with Playwright MCP integration.

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

2. **Configure API keys:**
   Edit `.env` and add your Anthropic API key

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
    mcp_servers: ["playwright"]  # References MCP server
    max_steps: 5                 # Multi-step tool execution
    tool_choice: "auto"          # AI decides when to use tools
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
EOF

echo "✅ Web Analysis workspace setup complete!"
echo ""
echo "📊 Workspace Details:"
echo "   ID: $WORKSPACE_ID"
echo "   Configuration: workspace.yml"
echo "   MCP Server: Playwright (@playwright/mcp@latest)"
echo "   Transport: stdio"
echo ""
echo "🚀 Next steps:"
echo "1. Update .env with your Anthropic API key"
echo "2. Run: ./start-server.sh"
echo "3. Test with: ./trigger-signal.sh \"https://example.com\""
echo ""
echo "📖 See README.md for detailed usage instructions"