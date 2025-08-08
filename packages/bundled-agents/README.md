# Bundled Agents

Pre-installed agents that ship with Atlas and are available to all workspaces.

## What This Is

Bundled agents are common integrations like Slack, GitHub, and Jira that come ready-to-use with Atlas. They're compiled into the Atlas binary and available immediately without any setup.

## How It Works

- **Pre-installed**: Available in every Atlas installation
- **Immutable**: Cannot be modified at runtime  
- **Universal access**: Work in all workspaces (unlike system agents)
- **Lazy loading**: Agent code loads when first used, not at startup

## Architecture

Bundled agents fit into Atlas's agent hierarchy:

| Agent Type | Visibility | Source | Mutability |
|-----------|-----------|--------|------------|
| System | System workspaces only | Built into Atlas | Immutable |
| **Bundled** | **All workspaces** | **Pre-installed with Atlas** | **Immutable** |
| SDK | All workspaces | Runtime registration | Runtime-defined |
| YAML | All workspaces | .agent.yml files | File-based |
| LLM | Session-specific | workspace.yml | Per-session |

## Adding New Bundled Agents

Add agents to the `bundledAgents` array in `src/index.ts`. They can be:

- YAML agent definitions (converted at build time)
- TypeScript SDK agents (already in correct format)

Both types are loaded through the `BundledAgentAdapter` and made available through Atlas's unified MCP server.

## Examples

Common bundled agents include:
- Slack communication expert
- GitHub operations (PRs, issues, security scans)  
- Jira project management
- Security analysis tools

Each agent handles natural language requests within their domain and provides specialized tools and knowledge.