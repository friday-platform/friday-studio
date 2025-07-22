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

   - Webhook URLs (Discord, Slack webhooks)
   - API tokens (GitHub, Linear, most APIs)
   - OAuth tokens (Google, Microsoft services)
   - Webhook secrets (Stripe, GitHub webhooks)

2. **Ask for credentials conversationally**:

   ```
   To set up this integration, I'll need:
   • Your Stripe API key (find it at dashboard.stripe.com/apikeys)
   • A Discord webhook URL (from your channel settings)
   • A GitHub personal access token with repo permissions

   Please provide these when you're ready.
   ```

3. **Reference in configuration** using environment variables:
   ```yaml
   tools:
     mcp:
       servers:
         discord:
           auth:
             type: bearer
             token_env: DISCORD_WEBHOOK_URL
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
  - Notifier (sends Discord alerts)
- **Tools**: web-browser, discord
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
- **Tools**: hubspot integration

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

Atlas provides these built-in MCP tools:

**Core Tools**:

- `web-browser` - Web scraping and browsing
- `email` - Send email notifications
- `filesystem` - Read/write files (with restrictions)

{{AVAILABLE_TOOLS}}

### Choosing Between Web Scraping and APIs

**Use Web Scraping when**:

- No official API exists
- API is limited or requires paid access
- You need data exactly as displayed to users
- Real-time updates aren't critical

**Use APIs when**:

- Official API is available
- You need real-time data
- Structured data is important
- Rate limits are generous

### Handling Missing Tools

When a required tool doesn't exist:

1. **Check if web scraping works**:

   ```yaml
   agents:
     data-fetcher:
       config:
         prompt: |
           Visit example.com/data and extract the information.
           Look for data in <div class="results"> elements.
         tools: ["web-browser"]
   ```

2. **Use HTTP requests directly**:

   ```yaml
   agents:
     api-caller:
       config:
         prompt: |
           Make a GET request to https://api.example.com/v1/data
           Headers: Authorization: Bearer ${API_TOKEN}
           Parse the JSON response and extract relevant fields.
         tools: ["web-browser"] # Can make HTTP requests
   ```

3. **Combine multiple tools**:
   ```yaml
   agents:
     complex-integration:
       config:
         prompt: |
           1. Fetch data from the website
           2. Process and transform the data
           3. Send summary via email
         tools: ["web-browser", "email"]
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

### Discord Notifications

```yaml
tools:
  mcp:
    servers:
      discord:
        transport:
          type: stdio
          command: npx
          args: ["-y", "@modelcontextprotocol/server-discord"]
        auth:
          type: bearer
          token_env: DISCORD_WEBHOOK_URL
```

Usage in agent:

```yaml
agents:
  notifier:
    config:
      prompt: |
        Send a Discord message to the webhook with:
        - Bold title: **New Alert**
        - Timestamp and details
        - Color: red for errors, green for success
      tools: ["discord"]
```

### Database Access

```yaml
tools:
  mcp:
    servers:
      postgres:
        transport:
          type: stdio
          command: npx
          args: ["-y", "@modelcontextprotocol/server-postgres"]
        env:
          DATABASE_URL: "postgresql://user:pass@localhost/db"
        tools:
          deny: ["execute_raw_sql"] # Safety first
```

### Web Scraping

```yaml
tools:
  mcp:
    servers:
      web-browser:
        transport:
          type: stdio
          command: npx
          args: ["-y", "@modelcontextprotocol/server-puppeteer"]
        config:
          headless: true
          timeout: 30000
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

{{WORKSPACE_REFERENCE}}
