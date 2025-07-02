# AI Topic Summarizer Workspace

An Atlas workspace for automated discovery and summarization of AI Agent projects on GitHub.

## Overview

This workspace automatically monitors GitHub for new AI Agent repositories and generates
comprehensive summaries every 30 minutes. It combines GitHub API integration with web search
capabilities to provide detailed analysis of emerging AI agent projects, frameworks, and tools.

## Features

- **Automated Discovery**: Scans GitHub every 30 minutes for new AI agent repositories
- **Comprehensive Analysis**: Evaluates code quality, innovation level, and market potential
- **Web Context**: Enhances GitHub data with web search for additional project context
- **Trend Tracking**: Identifies emerging patterns and technologies in the AI agent space
- **Historical Memory**: Maintains workspace memory for pattern recognition across sessions
- **Manual Triggers**: Supports on-demand research for specific topics or timeframes

## Architecture

### Agents

1. **github-researcher**:
   - GitHub API integration for repository discovery
   - Web search capabilities for additional context
   - Quality assessment and filtering
   - Structured data extraction

2. **topic-summarizer**:
   - Project classification and analysis
   - Trend identification and reporting
   - Comprehensive summary generation
   - Historical pattern recognition

### Jobs

- **github-ai-discovery**: Main automated workflow (every 30 minutes)
- **manual-research**: On-demand research for custom topics

### Signals

- **timer-github-scan**: Automated cron trigger (*/30 * * * *)
- **manual-scan**: HTTP endpoint for manual triggering

## Setup

### Prerequisites

1. **GitHub Personal Access Token**:
   ```bash
   export GITHUB_TOKEN="your_github_token"
   ```

2. **Tavily API Key** (for web search):
   ```bash
   export TAVILY_API_KEY="your_tavily_api_key"
   ```

### Installation

1. Navigate to the workspace directory:
   ```bash
   cd examples/topic-summarizer
   ```

2. Initialize and start the workspace:
   ```bash
   atlas init
   atlas daemon start
   ```

## Usage

### Automated Mode

The workspace runs automatically every 30 minutes, searching for new AI agent repositories and
generating summaries.

### Manual Triggers

#### Recent Projects (Last 24 hours)

```bash
curl -X POST http://localhost:3000/scan \
  -H "Content-Type: application/json" \
  -d '{"mode": "recent", "time_range": "24h"}'
```

#### Custom Topic Research

```bash
curl -X POST http://localhost:3000/scan \
  -H "Content-Type: application/json" \
  -d '{"mode": "custom", "topic": "multi-agent systems", "time_range": "7d"}'
```

#### Trending Projects

```bash
curl -X POST http://localhost:3000/scan \
  -H "Content-Type: application/json" \
  -d '{"mode": "trending", "min_stars": 10}'
```

## Search Criteria

The workspace focuses on discovering:

- **Conversational AI Agents**: Chatbots and interactive assistants
- **Autonomous Agents**: Task-execution and goal-oriented agents
- **Multi-Agent Systems**: Agent orchestration and coordination
- **LLM-Powered Tools**: Language model integration frameworks
- **AI Assistant Platforms**: Development libraries and platforms
- **Agent Frameworks**: Reusable agent architectures

## Output

### Summary Reports

Generated summaries include:

- **Executive Summary**: Key findings and trends
- **Featured Projects**: Detailed analysis of notable repositories
- **Innovation Analysis**: Unique features and technical approaches
- **Trend Identification**: Emerging patterns and technologies
- **Market Assessment**: Impact potential and development velocity

### Data Storage

- Reports saved in workspace memory for historical tracking
- Structured JSON data for programmatic access
- Markdown summaries for human readability

## Configuration

### Search Parameters

Modify `workspace.yml` to adjust:

- Search frequency (currently every 30 minutes)
- Repository quality thresholds
- Search keywords and filters
- Analysis depth and scope

### Agent Behavior

Customize agent prompts to:

- Focus on specific AI agent categories
- Adjust analysis criteria
- Modify output formats
- Change quality assessment parameters

## Memory and Learning

The workspace maintains memory across sessions to:

- Track previously analyzed repositories
- Identify recurring trends and patterns
- Improve quality assessment over time
- Build comprehensive market intelligence

## Monitoring

View workspace activity:

```bash
atlas ps                    # Active sessions
atlas logs topic-summarizer # Workspace logs
```

## API Integration

### GitHub API

Uses the official GitHub MCP server with these capabilities:

- Repository search and filtering
- Content analysis and README extraction
- Metadata collection (stars, forks, topics)
- Code structure evaluation

### Web Search

Integrates Tavily API for:

- Additional project context and mentions
- Blog posts and announcements
- Community discussions and reviews
- Market positioning and comparisons

## Extending the Workspace

### Adding New Data Sources

1. Configure additional MCP servers in `tools.mcp.servers`
2. Update agent tool permissions
3. Modify analysis prompts to incorporate new data

### Custom Analysis

1. Add new agent types for specialized analysis
2. Create additional jobs for different research workflows
3. Implement custom filtering and classification logic

## Troubleshooting

### Common Issues

1. **GitHub Rate Limits**: Ensure proper authentication and consider request throttling
2. **MCP Server Connectivity**: Verify environment variables and network access
3. **Memory Overflow**: Adjust retention settings for high-volume discovery

### Debug Mode

Enable detailed logging:

```bash
atlas daemon start --log-level debug
```

## Contributing

To enhance the workspace:

1. Fork and modify the workspace configuration
2. Test changes with manual triggers
3. Submit improvements via pull request
4. Document new features and configurations

## License

This workspace is part of the Atlas project and follows the same licensing terms.
