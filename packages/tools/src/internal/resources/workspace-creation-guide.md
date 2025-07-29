# Atlas Workspace Creation Guide

This guide helps you create Atlas workspaces by understanding user intent and mapping it to
appropriate configurations. Atlas workspaces can handle diverse automation needs - from simple
monitoring to complex data pipelines.

## Core Principle: Intent First, Implementation Second

When creating workspaces, focus on understanding what the user wants to accomplish rather than
forcing their needs into predefined patterns. Every automation task is unique, and Atlas is flexible
enough to handle creative combinations of triggers, processing, and outputs.

## Understanding User Intent

Before diving into configurations, analyze what the user wants to accomplish:

1. **What triggers the action?** (time-based, event-based, manual)
2. **What data sources are involved?** (APIs, websites, databases)
3. **What processing is needed?** (AI analysis, data transformation, filtering)
4. **Where should results go?** (notifications, databases, other APIs)
5. **What credentials are required?** (API keys, webhooks, OAuth tokens)

## Choosing the Right Signal Type

Atlas supports two primary signal types - choose based on the triggering need:

- **`schedule`**: For time-based automation (cron expressions)

  - Use for: Daily reports, periodic monitoring, scheduled syncs
  - Example: "Check every 30 minutes", "Run at 9 AM daily"

- **`http`**: For webhook receivers and API endpoints
  - Use for: Third-party integrations, real-time events, form submissions
  - Example: "When Stripe sends a webhook", "Handle GitHub events"

## Authentication Requirements

Most integrations require credentials. When detecting authentication needs:

1. **Identify required credentials** based on the service:

   - API tokens (GitHub, Linear, most APIs)
   - OAuth tokens (Google, Microsoft services)
   - Webhook secrets (Stripe, GitHub webhooks)

2. **Ask for credentials conversationally**:

   ```
   To set up this integration, I'll need:
   • Your Stripe API key (find it at dashboard.stripe.com/apikeys)
   • A GitHub personal access token with repo permissions

   Please provide these when you're ready.
   ```

3. **Reference in configuration** using environment variables:
   ```yaml
   # Email notifications are handled by atlas_notify_email tool
   ```

## Example Patterns

Let's explore how different user intents map to Atlas components:

### Web Monitoring Pattern

**User intent**: "Monitor Nike for new shoe drops and rate their hype level"

**Key components**:

- **Signal**: Schedule-based (`*/30 * * * *` for every 30 minutes)
- **Agents**:
  - Web scraper (extracts product data)
  - Change detector (compares with previous data)
  - Notifier (sends email alerts)
- **Tools**: atlas_fetch, atlas_library_store, atlas_notify_email
- **Context flow**: Each agent passes results to the next

**Critical configuration elements**:

```yaml
signals:
  check-drops:
    provider: schedule
    config:
      schedule: "*/30 * * * *"

jobs:
  monitor-drops:
    execution:
      agents:
        - id: web-scraper
        - id: change-detector
          context:
            steps: previous # Gets scraper's output
        - id: notifier
          context:
            steps: previous # Gets detector's findings
```

**Agent prompt focus**: Be specific about data extraction, comparison logic, and output format.

### Multi-Aspect Analysis Pattern

**User intent**: "When I push code, analyze it for elegance, documentation, complexity, and product
alignment"

**Key components**:

- **Signal**: HTTP webhook from GitHub
- **Execution strategy**: Parallel (analyze multiple aspects simultaneously)
- **Agents**: Specialized reviewers for each aspect, plus a synthesizer
- **Context flow**: All reviewers → synthesizer

**Critical configuration elements**:

```yaml
jobs:
  analyze-code:
    execution:
      strategy: parallel # Run reviewers concurrently
      agents:
        - id: elegance-reviewer
        - id: documentation-reviewer
        - id: complexity-analyzer
        - id: vision-alignment-checker
        - id: report-synthesizer
          dependencies:
            [
              elegance-reviewer,
              documentation-reviewer,
              complexity-analyzer,
              vision-alignment-checker,
            ]
          context:
            steps: all # Receives all analyses
```

**Agent specialization**: Each agent focuses on one aspect with specific evaluation criteria in
their prompts.

### API Integration Pattern

**User intent**: "Sync Stripe customers to HubSpot with AI enrichment"

**Key components**:

- **Signal**: HTTP webhook with validation
- **Trigger condition**: Filter for specific event types
- **Agent pipeline**: Validator → Mapper → Syncer
- **Tools**: atlas_fetch (for API calls), atlas_library_store (cache data), atlas_notify_email (error alerts)

**Critical configuration elements**:

```yaml
signals:
  stripe-webhook:
    provider: http
    config:
      path: /webhooks/stripe
    schema: # Validate webhook structure
      type: object
      required: ["type", "data"]

jobs:
  sync-customer:
    triggers:
      - signal: stripe-webhook
        condition:
          prompt: "Only trigger when the webhook type is customer.created or customer.updated"
```

**Conditional triggering**: Use natural language conditions to filter which events trigger the job.

## Data Flow Patterns

Atlas supports several execution patterns for complex workflows:

### Sequential Processing (Chaining)

Agents execute one after another, each building on previous results:

```yaml
jobs:
  process-data:
    execution:
      strategy: sequential
      agents:
        - id: fetcher
          # Gets raw data
        - id: transformer
          context:
            steps: previous # Receives fetcher's output
        - id: analyzer
          context:
            steps: previous # Receives transformer's output
        - id: reporter
          context:
            steps: all # Receives all previous outputs
```

### Parallel Processing (Fan-out)

Multiple agents work simultaneously on the same input:

```yaml
jobs:
  analyze-content:
    execution:
      strategy: parallel
      agents:
        - id: sentiment-analyzer
        - id: keyword-extractor
        - id: summary-generator
        - id: report-compiler
          dependencies:
            [sentiment-analyzer, keyword-extractor, summary-generator]
          context:
            steps: all # Waits for and receives all outputs
```

### Conditional Execution

Route to different agents based on conditions:

```yaml
jobs:
  route-webhook:
    triggers:
      - signal: incoming-webhook
        condition:
          prompt: "Only run when the webhook type is 'alert'"

  process-lead:
    triggers:
      - signal: incoming-webhook
        condition:
          prompt: "Only run when the webhook type is 'lead'"
```

### Context Preservation

Control what data flows between agents:

- `signal: true` - Include original trigger data
- `steps: "previous"` - Only previous agent's output
- `steps: "all"` - All previous agents' outputs
- `steps: "none"` - No context from other agents
- `agents: ["agent1", "agent2"]` - Specific agents' outputs

## Understanding Prompts: Supervisor vs Agent

Atlas uses two distinct types of prompts that serve different purposes:

### Job-Level Prompt (Supervisor Guidance)

The top-level `prompt` in a job guides the Atlas supervisor in orchestrating the overall workflow:

```yaml
jobs:
  analyze-data:
    prompt: |
      Analyze incoming customer feedback to identify trends and insights.
      Focus on extracting actionable recommendations for the product team.
      Ensure all negative feedback is properly categorized and escalated.
```

This prompt describes the **business goal** and overall objective. The supervisor uses this to
understand the job's purpose and coordinate agents accordingly.

### Agent-Level Prompts (Technical Instructions)

Each agent has its own prompt with specific, technical instructions for that step:

```yaml
agents:
  sentiment-analyzer:
    config:
      prompt: |
        You are a sentiment analysis expert. For each feedback item:
        1. Classify sentiment as positive, neutral, or negative
        2. Extract key themes and topics
        3. Rate urgency on a 1-5 scale
        Return results as structured JSON.
```

These prompts provide **detailed technical instructions** for individual tasks.

**Key distinction**: Use job prompts for "what we're trying to achieve" and agent prompts for "how
to do this specific step."

## Writing Effective Agent Prompts

Prompt quality directly impacts workspace effectiveness. Follow these guidelines:

### 1. Be Specific About the Task

```yaml
# Good - Clear, specific instructions
prompt: |
  Extract product information from the Nike website:
  - Product name and SKU
  - Price and available sizes
  - Release date and time
  - Product images (main and alternate views)
  Use CSS selectors when possible for reliable extraction.

# Avoid - Vague instructions
prompt: |
  Get data from the website and process it.
```

### 2. Define Expected Output Format

```yaml
prompt: |
  Analyze the sales data and return a JSON object with:
  {
    "total_revenue": number,
    "top_products": [{"name": string, "revenue": number}],
    "growth_rate": number (percentage),
    "anomalies": [{"type": string, "description": string}]
  }
```

### 3. Include Error Handling

```yaml
prompt: |
  Fetch data from the API endpoint.
  If you receive a 429 rate limit error, wait 60 seconds and retry.
  If authentication fails (401), report the issue clearly.
  For network errors, retry up to 3 times with exponential backoff.
```

### 4. Provide Context and Constraints

```yaml
prompt: |
  You are analyzing financial data for a public company.
  Ensure all calculations follow GAAP standards.
  Do not make predictions beyond the data provided.
  Flag any suspicious patterns that might indicate errors.
```

### 5. Handle Library Content Appropriately

When agents work with library content, include guidance about streaming for large content:

```yaml
prompt: |
  Process the research results from the library.

  IMPORTANT: When retrieving library content:
  1. First use atlas_library_get with includeContent=false to check size_bytes
  2. For items ≤100KB: Use atlas_library_get with includeContent=true
  3. For items >100KB: Use atlas_library_get_stream to avoid prompt overflow
  4. The streaming tool sends content via notifications in manageable chunks

  Analyze the content and extract key insights...
```

## Defining Success and Error Conditions

Make your workspaces self-validating by defining explicit success and error criteria:

### Success Conditions

Define what constitutes successful job completion:

```yaml
jobs:
  generate-report:
    success:
      condition:
        prompt: "Success when the report contains at least 5 insights and includes visualizations"
      schema: # Optional: validate output structure
        type: object
        properties:
          insights:
            type: array
            minItems: 5
          visualizations:
            type: array
        required: ["insights", "visualizations"]
```

### Error Conditions

Catch and handle specific failure scenarios:

```yaml
jobs:
  sync-data:
    error:
      condition:
        prompt: "Error if more than 10% of records fail to sync or if critical fields are missing"
```

### Common Patterns

**Data Quality Validation**:

```yaml
success:
  condition:
    prompt: "Success when all required fields are present and data passes validation rules"
```

**Processing Thresholds**:

```yaml
error:
  condition:
    prompt: "Error if processing takes longer than 5 minutes or memory usage exceeds limits"
```

**Business Logic Validation**:

```yaml
success:
  condition:
    prompt: "Success when the total calculated matches the sum of line items within 0.01"
```

These conditions help Atlas determine job outcomes programmatically, enabling better error handling
and workflow reliability.

## Enabling Workspace Memory

When users want workspaces to "remember" information across runs, enable memory persistence:

### When to Enable Memory

Enable memory for use cases like:

- "Remember what products we've already seen"
- "Learn from past customer interactions"
- "Track changes over time"
- "Build up knowledge about our systems"

### Basic Memory Configuration

```yaml
memory:
  enabled: true
  scope: "workspace" # Memory is scoped to this workspace
```

### Memory with Retention Policies

Control how long information is retained:

```yaml
memory:
  enabled: true
  scope: "workspace"
  retention:
    max_age_days: 30 # Remove entries older than 30 days
    max_entries: 1000 # Keep only the most recent 1000 entries
    cleanup_interval_hours: 24 # Run cleanup daily
```

### Memory for Specific Use Cases

**Change Detection**:

```yaml
memory:
  enabled: true
  retention:
    max_age_days: 7 # Keep a week of history for comparison
```

**Customer Interaction History**:

```yaml
memory:
  enabled: true
  retention:
    max_age_days: 90 # Keep 3 months of interaction data
    max_entries: 10000 # Support high volume
```

**Learning and Optimization**:

```yaml
memory:
  enabled: true
  retention:
    max_age_days: 365 # Keep a year of learning data
```

Memory is automatically available to agents through the Atlas runtime - no special tools needed.

## Tool Selection Guide

### Currently Available Tools

**IMPORTANT: Tool Context Distinction**

There are two distinct tool contexts in Atlas:

1. **Conversation Agent Tools** (for orchestration):
   - `atlas_workspace_*` - Create, list, update, delete workspaces
   - `atlas_todo_*` - Memory and context management
   - `read_atlas_resource` - Access knowledge and patterns

2. **Workspace Tools** (for execution - listed below):
   - `atlas_notify_email` - Send email notifications
   - `web_fetch` - Make HTTP requests
   - `tavily_search` - Web research and data extraction
   - `atlas_bash` - System operations and commands

**Critical**: When users ask about workspace tools (like `atlas_notify_email`), the conversation agent should respond with workspace creation capability, NOT claim the tool doesn't exist.

All tools for Atlas workspaces are provided by the MCP Atlas server. Configure it in your workspace with:

```yaml
tools:
  mcp:
    servers:
      atlas-platform:
        transport:
          type: "http"
          url: "http://localhost:8080/mcp"
        tools:
          allow:
            [
              "atlas_library_list",
              "atlas_library_get",
              "atlas_library_store",
              "atlas_library_stats",
              "atlas_library_templates",
              "atlas_workspace_list",
              "atlas_workspace_create",
              "atlas_workspace_delete",
              "atlas_workspace_describe",
              "atlas_session_describe",
              "atlas_session_cancel",
              "atlas_jobs_list",
              "atlas_jobs_describe",
              "atlas_signals_list",
              "atlas_signals_trigger",
              "atlas_agents_list",
              "atlas_agents_describe",
              "atlas_glob",
              "atlas_grep",
              "atlas_ls",
              "atlas_read",
              "atlas_write",
              "tavily_search",
              "tavily_extract",
              "tavily_crawl",
              "atlas_bash",
              "atlas_notify_email",
            ]
        client_config:
          timeout: "30s"
```

**Tool Categories and Selection Criteria:**

**ALWAYS select ONLY the specific tools your workspace actually needs**

- **Library Tools**: `atlas_library_list`, `atlas_library_get`, `atlas_library_get_stream`, `atlas_library_store`, `atlas_library_stats`, `atlas_library_templates`
  - Use when: Storing knowledge, templates, persistent data between runs
  - **Library Retrieval Strategy**:
    - Use `atlas_library_get` with `includeContent=false` to check `size_bytes`
    - Use `atlas_library_get` with `includeContent=true` for items ≤100KB
    - Use `atlas_library_get_stream` for items >100KB
    - The 100KB threshold prevents prompt overflow while maximizing efficiency
- **Workspace Management**: `atlas_workspace_list`, `atlas_workspace_create`, `atlas_workspace_delete`, `atlas_workspace_describe`
  - Use when: Workspace introspection, management, or creation workflows
- **Session Control**: `atlas_session_describe`, `atlas_session_cancel`
  - Use when: Session management, monitoring, or control needed
- **Job Management**: `atlas_jobs_list`, `atlas_jobs_describe`
  - Use when: Job introspection or management needed
- **Signal Management**: `atlas_signals_list`, `atlas_signals_trigger`
  - Use when: Signal management or triggering needed
- **Agent Management**: `atlas_agents_list`, `atlas_agents_describe`
  - Use when: Agent introspection needed
- **File Operations**: `atlas_glob`, `atlas_grep`, `atlas_ls`, `atlas_read`, `atlas_write`
  - Use when: Reading files, writing reports, searching codebases, file management
- **Web Operations**: `tavily_search`, `tavily_extract`, `tavily_crawl`
  - Use when: Web search, content extraction, website crawling, research tasks
- **System Operations**: `atlas_bash`
  - Use when: Running commands, git operations, system integrations, deployments
- **Notifications**: `atlas_notify_email`
  - Use when: Sending alerts, reports, status updates via email

### Tool Selection Priority: Atlas-Platform First, Selective Access

**ALWAYS prefer atlas-platform MCP server tools** with ONLY the specific tools needed:

#### 1. Use Atlas-Platform Tools First

The atlas-platform MCP server provides powerful tools that handle most automation needs:

```yaml
# Configure atlas-platform MCP server with ONLY needed tools
tools:
  mcp:
    servers:
      atlas-platform:
        transport:
          type: "http"
          url: "http://localhost:8080/mcp"
        tools:
          allow: ["atlas_glob", "atlas_read", "atlas_write"] # Only what's needed

agents:
  data-processor:
    config:
      prompt: |
        Process the CSV files in the data directory and generate a summary report.
      tools: ["atlas-platform"]
```

**Common atlas-platform tool patterns**:

- **File operations**: `atlas_read`, `atlas_write`, `atlas_list`, `atlas_glob`, `atlas_grep`
- **Web requests**: `atlas_fetch` (handles both APIs and web scraping)
- **System commands**: `atlas_bash` (for git, builds, system operations)
- **Notifications**: `atlas_notify_email`
- **Workspace management**: `atlas_workspace_create`, `atlas_workspace_list`
- **Session control**: `atlas_session_describe`, `atlas_session_cancel`

#### 2. External MCP Tools (When Atlas-Platform Tools Insufficient)

Only use external MCP tools when atlas-platform tools can't handle the specific integration:

**AVOID external MCP servers if Atlas tools can handle the need:**

- ❌ External web scraping MCP when Tavily tools provide comprehensive web research
- ❌ External filesystem MCP when `atlas_read`/`atlas_write` sufficient
- ❌ External email service when `atlas_notify_email` sufficient
- ❌ External search engines when Tavily provides AI-powered search

```yaml
# Example: Web research using Tavily instead of external web scraping MCP
tools:
  mcp:
    servers:
      atlas-platform:
        transport:
          type: "http"
          url: "http://localhost:8080/mcp"
        tools:
          allow: ["tavily_search", "tavily_extract", "atlas_library_store"]

agents:
  research-analyzer:
    config:
      prompt: |
        Use Tavily to research and analyze web content:
        1. Search for relevant information with tavily_search
        2. Extract detailed content from URLs with tavily_extract
        3. Store findings with atlas_library_store
      tools: ["atlas-platform"]
```

#### 3. Web Scraping vs APIs (Last Resort)

**Use Tavily tools for web research and content extraction**:

```yaml
agents:
  research-agent:
    config:
      prompt: |
        Use Tavily to research GitHub repositories and issues:
        1. Search for relevant repositories with tavily_search
        2. Extract detailed content with tavily_extract
        3. Crawl documentation with tavily_crawl
      tools: ["tavily_search", "tavily_extract", "tavily_crawl"]
```

**Use Tavily for comprehensive web research**:

- AI-powered search with content filtering
- Intelligent content extraction from URLs
- Website crawling for systematic data gathering
- Built-in summarization and answer generation

### Handling Missing Functionality

When you need functionality not directly available:

1. **Try atlas-platform tools first**:

   ```yaml
   agents:
     data-fetcher:
       config:
         prompt: |
           Use tavily_search to find relevant data on example.com
           Use tavily_extract to get specific content from URLs
           Return structured JSON data with insights
         tools: ["tavily_search", "tavily_extract"]
   ```

2. **Combine atlas-platform tools for complex workflows**:

   ```yaml
   agents:
     file-processor:
       config:
         prompt: |
           1. Find all CSV files using atlas_glob
           2. Read each file with atlas_read
           3. Process data and write results with atlas_write
           4. Send completion notification with atlas_notify_email
         tools: ["atlas_glob", "atlas_read", "atlas_write", "atlas_notify_email"]
   ```

3. **Use system commands when needed**:
   ```yaml
   agents:
     git-automation:
       config:
         prompt: |
           1. Check git status and commit changes
           2. Push to remote repository
           3. Create deployment tag
         tools: ["atlas_bash"]
   ```

## Common Error Patterns & Solutions

Present errors with both task impact and technical details:

### Website Access Blocked

**What happened**: "Couldn't fetch Nike's product data - got HTTP 403 Forbidden at 14:23 UTC"\
**Why it failed**: "Nike's Cloudflare protection is blocking automated requests without proper
headers"\
**How to fix**:

```yaml
agents:
  scraper:
    config:
      prompt: |
        When fetching from Nike, include these headers:
        - User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
        - Accept-Language: en-US,en;q=0.9
        - Accept: text/html,application/xhtml+xml
```

### Webhook Authentication Failed

**What happened**: "Stripe webhook processing failed - couldn't verify the payload signature"\
**Why it failed**: "The webhook secret doesn't match what Stripe expects (401 Unauthorized)"\
**How to fix**:

```
Add to your .env file:
STRIPE_WEBHOOK_SECRET=whsec_... (get from stripe.com/webhooks)

The secret should start with 'whsec_' for live mode or 'whsec_test_' for test mode.
```

### Processing Taking Too Long

**What happened**: "Data analysis stopped after 30 seconds without completing"\
**Why it failed**: "The agent hit the default timeout while processing 10,000+ records"\
**How to fix**:

```yaml
agents:
  analyzer:
    config:
      timeout: "300s" # Increase to 5 minutes
      prompt: |
        Process data in batches of 1000 records.
        Log progress every 30 seconds.
```

### API Rate Limits Hit

**What happened**: "GitHub API stopped responding after 47 requests"\
**Why it failed**: "Hit the 60 requests/hour limit for unauthenticated access"\
**How to fix**:

```yaml
# Add authentication to increase limit to 5000/hour
tools:
  mcp:
    servers:
      github:
        auth:
          type: bearer
          token_env: GITHUB_TOKEN

# Or add delays between requests
agents:
  github-monitor:
    config:
      prompt: |
        Wait 65 seconds between API calls to stay under rate limit.
        Check X-RateLimit-Remaining header and adjust timing.
```

### Missing Required Data

**What happened**: "Couldn't create HubSpot contact - missing email address"\
**Why it failed**: "The Stripe customer object didn't include an email field"\
**How to fix**:

```yaml
agents:
  data-mapper:
    config:
      prompt: |
        Check for required fields before creating contacts:
        - If email is missing, skip this customer
        - Log skipped records with reason
        - Continue processing other customers
```

## Tool Configuration Examples

### Email Notifications

Use the built-in `atlas_notify_email` tool for notifications:

```yaml
agents:
  notifier:
    config:
      prompt: |
        Send an email notification with:
        - Subject: Alert - New Event
        - Body with timestamp and details
        - Priority level for urgent alerts
      tools: ["atlas_notify_email"]
```

### Database Access

For database operations, use external MCP servers designed for specific database types, or access via API endpoints when available.

### Web Research and Content Extraction

Use Tavily tools for comprehensive web research and content analysis:

```yaml
agents:
  web-researcher:
    config:
      prompt: |
        1. Search for information with tavily_search using specific queries
        2. Extract content from specific URLs with tavily_extract
        3. Crawl websites systematically with tavily_crawl
        4. Generate insights from collected data
      tools: ["tavily_search", "tavily_extract", "tavily_crawl"]
```

## Best Practices

### Focus on User Goals

- **Lead with intent**: Understand what the user wants to achieve before choosing tools
- **Stay flexible**: Don't force tasks into predefined patterns
- **Think creatively**: Combine tools and agents in novel ways to solve unique problems

### Configuration Quality

- **Define schemas**: Signal schemas validate input at runtime - always use them
- **Clear naming**: Use descriptive names that reflect business purpose, not technical details
- **Document intent**: Descriptions should explain the "why" behind each component
- **CRITICAL - Numeric Values**: Always use unquoted numbers in YAML for numeric fields like `temperature: 0.1` and `max_tokens: 2000`. NEVER use quoted strings like `temperature: "0.1"` as this will cause validation errors. The schema requires actual numbers, not string representations.

### Security & Credentials

- **Environment variables**: Never hardcode secrets - always use .env files
- **Clear credential requests**: Tell users exactly where to find API keys and tokens
- **Validate authentication**: Test credentials early in the workflow to fail fast

### Error Handling

- **User-friendly messages**: Explain both what went wrong and how to fix it
- **Graceful degradation**: Continue processing other items when one fails
- **Actionable guidance**: Provide specific steps users can take to resolve issues

### Development Process

1. **Start with the simplest working version**
2. **Test each component individually**
3. **Add complexity incrementally**
4. **Validate configurations frequently**

## Debugging Guidance

When helping users debug issues:

1. **Present the problem clearly**: "Your Nike monitor failed at 15:47 UTC"
2. **Explain the technical cause**: "Got HTTP 403 - Cloudflare is blocking requests"
3. **Provide actionable solutions**: "Add these headers to your scraper configuration..."
4. **Suggest preventive measures**: "Consider rotating User-Agent strings"

Remember: Every automation is unique. Focus on understanding the user's specific needs and crafting
a solution that elegantly addresses their requirements using Atlas's flexible architecture.

## Full workspace.yml reference

For complete configuration examples and all available options, use:

```
read_atlas_resource({ uri: "atlas://reference/workspace" })
```

This provides the comprehensive workspace.yml reference with all signal types, job definitions, agent configurations, tool configurations, memory settings, success/error conditions, schemas, and best practices.
