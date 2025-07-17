/**
 * Workspace reference resource for MCP server
 * Exposes a comprehensive workspace configuration reference
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ResourceContext } from "./types.ts";

// Embedded reference workspace YAML content
const referenceWorkspaceYaml = `# Atlas Workspace Configuration Example
# This file demonstrates all available configuration options for an Atlas workspace

version: "1.0"

workspace:
  name: "example-workspace"
  description: "Comprehensive example showing all Atlas workspace configuration options"

# ==============================================================================
# SIGNALS - How external events trigger jobs in your workspace
# ==============================================================================

signals:
  # CLI Signal - Triggered manually via command line
  cli-signal:
    description: "Manual trigger from CLI"
    provider: "cli"
    # CLI signals accept any JSON payload: atlas signal trigger cli-signal '{"message": "hello"}'

  # HTTP Webhook Signal - Receives external webhooks
  webhook-signal:
    description: "Receives webhooks from external services"
    provider: "http"
    path: "/webhook" # URL path: POST http://localhost:8080/signals/webhook
    method: "POST" # HTTP method (GET, POST, PUT, DELETE)
    headers: # Optional: Required headers for authentication
      authorization: "Bearer \${WEBHOOK_SECRET}"
    # Request body is passed as signal payload to jobs

  # Scheduled Signal - Runs on a cron schedule
  scheduled-signal:
    description: "Runs every day at 9 AM"
    provider: "schedule"
    schedule: "0 9 * * *" # Standard cron format
# timezone: "America/New_York"  # Optional: Default is UTC
# Schedule generates payload: { timestamp, scheduled_time }

# ==============================================================================
# JOBS - Workflows that execute when signals are triggered
# ==============================================================================

jobs:
  # Simple job with single agent
  simple-job:
    name: "simple-job"
    description: "Basic job that processes incoming signals"

    triggers:
      - signal: "cli-signal"
        # Optional: Add conditions using JsonLogic
        # condition:
        #   and:
        #     - { "==": [{ "var": "action" }, "process"] }
        #     - { "!=": [{ "var": "data" }, null] }

    execution:
      strategy: "sequential" # How agents run: sequential or parallel
      agents:
        - id: "processor"
          # input_source: "signal"  # Default: uses signal payload as input

  # Complex job with multiple agents
  complex-job:
    name: "complex-job"
    description: "Multi-agent workflow with data pipeline"

    triggers:
      - signal: "webhook-signal"
      - signal: "scheduled-signal" # Can be triggered by multiple signals

    execution:
      strategy: "sequential"
      agents:
        # First agent: Extract and validate data
        - id: "extractor"
          input_source: "signal"

        # Second agent: Enrich data with additional context
        - id: "enricher"
          input_source: "previous" # Uses output from previous agent

        # Third agent: Generate report from all data
        - id: "reporter"
          input_source: "all" # Receives all previous outputs as array
    # input_transform:        # Optional: Transform input before sending
    #   template: |
    #     Generate report for:
    #     {{#each inputs}}
    #     - {{this.summary}}
    #     {{/each}}

    # Optional: Configure supervision level
    supervision:
      level: "standard" # Options: minimal, standard, comprehensive
    # custom_instructions: "Focus on data quality and accuracy"

    # Optional: Configure memory/context
    memory:
      enabled: true
      fact_extraction: true # Extract facts for long-term memory
      working_memory_summary: true # Summarize for context window

    # Optional: Resource estimates
    resources:
      estimated_duration_seconds: 300 # Expected job duration
# max_tokens: 10000             # Token limit for job

# ==============================================================================
# AGENTS - AI agents that perform the actual work
# ==============================================================================

agents:
  # Basic LLM agent
  processor:
    type: "llm"
    model: "claude-3-5-haiku-latest" # Fast, efficient model
    purpose: "Process and respond to incoming requests"

    prompts:
      system: |
        You are a helpful assistant that processes incoming requests.
        Analyze the input data and provide a clear, structured response.
        Be concise but thorough in your analysis.

  # Agent with MCP tools
  extractor:
    type: "llm"
    model: "claude-3-7-sonnet-latest" # More capable model
    purpose: "Extract and validate data from various sources"

    prompts:
      system: |
        You are a data extraction specialist.
        Your job is to:
        1. Parse incoming webhook payloads
        2. Extract relevant fields
        3. Validate data format and completeness
        4. Structure data for downstream processing

        Output clean JSON with extracted data.

    tools:
      mcp: ["web-scraper", "json-validator"] # Attach MCP tools

  # Agent with context window optimization
  enricher:
    type: "llm"
    model: "claude-3-7-sonnet-latest"
    purpose: "Enrich data with additional context"

    prompts:
      system: |
        You receive extracted data and enrich it with additional context.
        Use available tools to fetch related information.
        Maintain data structure while adding enrichment fields.

    tools:
      mcp: ["database-lookup", "api-client"]

    # Optional: Fine-tune model parameters
    config:
      temperature: 0.3 # Lower = more deterministic
      max_tokens: 2000 # Response length limit
  # top_p: 0.9          # Nucleus sampling
  # frequency_penalty: 0 # Reduce repetition

  # Report generation agent
  reporter:
    type: "llm"
    model: "claude-3-7-sonnet-latest"
    purpose: "Generate comprehensive reports"

    prompts:
      system: |
        You are a report generation specialist.
        Create well-formatted reports that:
        - Summarize all processed data
        - Highlight key insights
        - Include relevant metrics
        - Provide actionable recommendations

# ==============================================================================
# TOOLS - MCP (Model Context Protocol) servers that provide capabilities
# ==============================================================================

tools:
  mcp:
    # Global MCP client configuration
    client_config:
      timeout: 30000 # Request timeout in ms
      retry_policy:
        max_attempts: 3
        backoff_ms: 1000
        max_backoff_ms: 30000

    servers:
      # Web scraping capabilities
      web-scraper:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-puppeteer"]
        tools:
          allowed: ["navigate", "screenshot", "extract_content"]

      # JSON validation
      json-validator:
        transport:
          type: "stdio"
          command: "python"
          args: ["-m", "mcp_json_validator"]

      # Database access
      database-lookup:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-postgres"]
          env:
            DATABASE_URL: "\${DATABASE_URL}"
        tools:
          allowed: ["query", "list_tables"] # Limit to read operations
          blocked: ["execute", "drop_table"] # Explicitly block dangerous operations

      # External API client
      api-client:
        transport:
          type: "http"
          url: "http://localhost:3000/mcp"
          headers:
            authorization: "Bearer \${API_TOKEN}"
        # HTTP transport supports REST-style MCP servers

# ==============================================================================
# ADVANCED CONFIGURATIONS (Usually not needed for simple workspaces)
# ==============================================================================

# Expose this workspace as an MCP server to other workspaces
# server:
#   mcp:
#     enabled: true
#     discoverable:
#       capabilities:
#         - "workspace_jobs_*"        # Expose job execution
#         - "workspace_sessions_read" # Allow session queries
#       jobs:
#         - "simple-job"              # Specific jobs to expose
#         - "report_*"                # Wildcard patterns
#     rate_limits:
#       requests_per_hour: 100
#       concurrent_sessions: 5
#     access_control:
#       require_auth: true
#       allowed_tokens:
#         - "\${WORKSPACE_ACCESS_TOKEN}"

# External data sources and contexts (future feature)
# resources:
#   - id: "api-docs"
#     type: "url"
#     url: "https://api.example.com/docs"
#     description: "API documentation"
#     refresh_interval: "24h"
#
#   - id: "config"
#     type: "file"
#     path: "./config/settings.json"
#     description: "Application configuration"

# Integration with external systems (future feature)
# integrations:
#   slack:
#     webhook_url: "\${SLACK_WEBHOOK_URL}"
#     channel: "#alerts"
#
#   github:
#     token: "\${GITHUB_TOKEN}"
#     repository: "org/repo"
`;

export function registerWorkspaceReferenceResource(
  server: McpServer,
  context: ResourceContext,
) {
  // Register resource
  server.registerResource(
    "workspace-reference",
    "atlas://reference/workspace",
    {
      name: "Workspace Configuration Reference",
      description: "Comprehensive reference showing all Atlas workspace configuration options",
      mimeType: "text/yaml",
    },
    () => {
      return {
        contents: [{
          uri: "atlas://reference/workspace",
          mimeType: "text/yaml",
          text: referenceWorkspaceYaml,
        }],
      };
    },
  );

  context.logger.info("Registered workspace reference resource");
}
