# Atlas Workspace Creation Guide

This guide helps you create Atlas workspaces by understanding user intent and mapping it to
appropriate configurations. Atlas workspaces can handle diverse automation needs - from simple
monitoring to complex data pipelines.

## Core Principle: Intent First, Implementation Second

When creating workspaces, focus on understanding what the user wants to accomplish rather than
forcing their needs into predefined patterns. Every automation task is unique, and Atlas is flexible
enough to handle creative combinations of triggers, processing, and outputs.

## CRITICAL: Atlas vs Other Automation Platforms

Atlas uses **AGENT-BASED architecture**, NOT step-based workflows. Avoid patterns from GitHub
Actions, Zapier, or n8n.

### ❌ NEVER USE These Patterns:

```yaml
# DON'T: Step-based workflow syntax (GitHub Actions style)
agents:
  earnings-monitor:
    steps:
      - id: "check-earnings-releases"
        uses: "web/searcher"
        with:
          query: "{{company}} earnings call transcript"
        foreach: "{{inputs.companies}}"
        as: "company"
      - id: "filter-new-transcripts"
        uses: "storage/query"

# DON'T: Complex nested execution logic
agents:
  monitor:
    execution:
      strategy: "complex"
      steps:
        - condition: "{{transcript.isNew}}"
          then:
            - uses: "ai/completion"
            - uses: "slack/post-message"

# DON'T: Tool invocation as pipeline steps
steps:
  - uses: "web/fetch"
  - uses: "ai/analyze"
  - uses: "slack/notify"
```

### ✅ USE Atlas Agent Architecture:

```yaml
# DO: Simple agent definitions with tools
agents:
  earnings-monitor:
    type: "llm"
    config:
      prompt: |
        Check for earnings call transcripts from AAPL, MSFT, GOOG, META.
        Search recent financial news and SEC filings.
        Extract key information and identify new transcripts.
      tools: ["web-browser"]

# DO: Agent chains in jobs
jobs:
  earnings-analysis:
    execution:
      strategy: "sequential"
      agents:
        - id: "earnings-monitor"
        - id: "ai-analyzer"
        - id: "slack-notifier"

# DO: Tools as MCP servers
tools:
  mcp:
    servers:
      slack:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-slack"]
```

**Key Differences:**

- **Agents are defined once** in `agents:` section, referenced by ID in jobs
- **No `steps[]`, `uses:`, or `foreach:` syntax** - use agent prompts instead
- **Tools are MCP servers**, not workflow steps
- **Simple agent chains**, not complex nested execution logic

## Understanding User Intent

Before diving into configurations, analyze what the user wants to accomplish:

1. **What triggers the action?** (time-based, event-based, manual)
2. **What data sources are involved?** (APIs, websites, databases)
3. **What processing is needed?** (AI analysis, data transformation, filtering)
4. **Where should results go?** (notifications, databases, other APIs)
5. **What credentials are required?** (API keys, webhooks, OAuth tokens)

## MANDATORY: Start With This Template

**ALWAYS** start workspace creation with this exact structure. Fill in the placeholders - never
invent new syntax:

```yaml
version: "1.0"

workspace:
  name: "[descriptive-workspace-name]"
  description: "[what this workspace accomplishes for the user]"

signals:
  [trigger-name]:
    provider: "[schedule|http]"
    description: "[when this triggers]"
    config:
# For schedule: schedule: "*/30 * * * *"
# For http: path: "/webhooks/[service]"

jobs:
  [job-name]:
    description: "[what this job does]"
    triggers:
      - signal: "[trigger-name]"
    execution:
      strategy: "sequential"
      agents:
        - id: "[agent-id-1]"
        - id: "[agent-id-2]"
          context:
            steps: "previous" # Gets previous agent's output

agents:
  [agent-id-1]:
    type: "llm"
    description: "[what this agent does]"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        [Specific instructions for this agent]
      tools: ["[tool-name]"]

  [agent-id-2]:
    type: "llm"
    description: "[what this agent does]"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        [Specific instructions for this agent]
      tools: ["[tool-name]"]

tools:
  mcp:
    servers:
      [tool-name]:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-[tool]"]
        # Add auth if required:
        # auth:
        #   type: "bearer"
        #   token_env: "[ENV_VAR_NAME]"
```

**Template Rules:**

- Replace ALL `[placeholder]` values with actual content
- NEVER add `steps[]`, `uses:`, `foreach:`, or other non-Atlas syntax
- Keep the flat YAML structure - don't nest execution logic in agents
- Define each agent once in `agents:`, reference by ID in jobs
- Tools are MCP servers in `tools.mcp.servers`, not workflow steps

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

## Complete Working Examples

Use these concrete examples as starting points for common automation patterns:

### Tech Earnings Analysis Workspace

**User intent**: "Monitor for earnings call transcripts from major tech companies (AAPL, MSFT, GOOG,
META), analyze them with AI, and send summaries to Slack"

**Complete working configuration**:

```yaml
version: "1.0"

workspace:
  name: "tech-earnings-monitor"
  description: "Monitor tech earnings calls and send AI-generated summaries to Slack"

signals:
  check-earnings:
    provider: "schedule"
    description: "Check for new earnings transcripts every 8 hours"
    config:
      schedule: "0 */8 * * *"

jobs:
  earnings-analysis:
    description: "Find, analyze, and report on new earnings transcripts"
    triggers:
      - signal: "check-earnings"
    execution:
      strategy: "sequential"
      agents:
        - id: "earnings-fetcher"
        - id: "ai-analyzer"
          context:
            steps: "previous"
        - id: "slack-notifier"
          context:
            steps: "previous"

agents:
  earnings-fetcher:
    type: "llm"
    description: "Search for and extract new earnings call transcripts"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Search for recent earnings call transcripts from these companies: AAPL, MSFT, GOOG, META.

        For each company:
        1. Check SEC filings and financial news sites
        2. Look for Q1/Q2/Q3/Q4 earnings call transcripts
        3. Extract the full transcript text
        4. Include company symbol, date, and source URL

        Return results as JSON with company, date, transcript_text, and source_url fields.
      tools: ["web-browser"]

  ai-analyzer:
    type: "llm"
    description: "Analyze earnings transcripts with AI for key insights"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Analyze the earnings call transcript provided. Generate a comprehensive summary including:

        1. Key financial metrics vs expectations
        2. Notable strategic announcements
        3. Forward guidance and outlook
        4. Management sentiment and tone
        5. Potential market impact

        Format as a well-structured markdown report with clear sections and bullet points.
        Keep it professional but accessible.

  slack-notifier:
    type: "llm"
    description: "Send formatted analysis to Slack"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Send the earnings analysis to Slack with formatting:

        - Use markdown formatting for headers and emphasis
        - Include company ticker in the title
        - Add the analysis date and source
        - Keep the message concise but informative

        Format for Slack's markdown syntax.
      tools: ["slack"]

tools:
  mcp:
    servers:
      web-browser:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-puppeteer"]

      slack:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-slack"]
        auth:
          type: "bearer"
          token_env: "SLACK_TOKEN"

memory:
  enabled: true
  retention:
    max_age_days: 30 # Keep a month of transcript history
```

**Key Points:**

- **Sequential agent chain**: Fetcher → Analyzer → Notifier
- **Context flow**: Each agent builds on the previous one's output
- **Specific prompts**: Each agent has detailed, actionable instructions
- **Memory enabled**: Tracks what transcripts have been processed

### Stripe to HubSpot Customer Sync

**User intent**: "When Stripe sends a webhook for new customers, sync them to HubSpot with AI
enrichment"

**Complete working configuration**:

```yaml
version: "1.0"

workspace:
  name: "stripe-hubspot-sync"
  description: "Sync new Stripe customers to HubSpot with AI-enhanced profiles"

signals:
  stripe-webhook:
    provider: "http"
    description: "Receive webhooks from Stripe"
    config:
      path: "/webhooks/stripe"
    schema:
      type: "object"
      properties:
        type:
          type: "string"
        data:
          type: "object"
      required: ["type", "data"]

jobs:
  customer-sync:
    description: "Sync new Stripe customers to HubSpot with enrichment"
    triggers:
      - signal: "stripe-webhook"
        condition:
          prompt: "Only process customer.created and customer.updated events"
    execution:
      strategy: "sequential"
      agents:
        - id: "stripe-validator"
        - id: "ai-enricher"
          context:
            steps: "previous"
        - id: "hubspot-syncer"
          context:
            steps: "previous"

agents:
  stripe-validator:
    type: "llm"
    description: "Validate and extract customer data from Stripe webhook"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Extract customer information from the Stripe webhook payload:

        Required fields:
        - Customer ID
        - Email address
        - Name (if available)
        - Created date
        - Subscription info (if any)

        Validate that all required fields are present.
        Return structured JSON with customer data.

        Skip processing if this is a test webhook or missing required fields.

  ai-enricher:
    type: "llm"
    description: "Enrich customer profile with AI-generated insights"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Enhance the customer profile with intelligent insights:

        Based on the customer's email domain and available data:
        1. Identify likely company size (startup, SMB, enterprise)
        2. Suggest industry category
        3. Estimate customer lifetime value tier
        4. Generate personalized onboarding recommendations

        Add these insights to the customer data structure.

  hubspot-syncer:
    type: "llm"
    description: "Create or update contact in HubSpot"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Sync the enriched customer data to HubSpot:

        1. Check if contact already exists (by email)
        2. Create new contact or update existing one
        3. Set appropriate properties:
           - Source: "Stripe Integration"
           - Lead score based on AI insights
           - Industry and company size
           - Custom fields for Stripe data

        Handle errors gracefully and log sync status.
      tools: ["hubspot"]

tools:
  mcp:
    servers:
      hubspot:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-hubspot"]
        auth:
          type: "bearer"
          token_env: "HUBSPOT_ACCESS_TOKEN"
```

**Key Points:**

- **HTTP webhook trigger**: Responds to real-time Stripe events
- **Conditional processing**: Only handles specific event types
- **AI enrichment**: Adds intelligent insights to customer data
- **Error handling**: Validates data at each step

### Nike Shoe Drop Monitor

**User intent**: "Monitor Nike for new shoe drops and send Discord notifications with hype analysis"

**Complete working configuration**:

```yaml
version: "1.0"

workspace:
  name: "nike-drop-monitor"
  description: "Monitor Nike releases and analyze hype level for Discord alerts"

signals:
  check-drops:
    provider: "schedule"
    description: "Check Nike every 30 minutes for new releases"
    config:
      schedule: "*/30 * * * *"

jobs:
  monitor-releases:
    description: "Find new Nike drops and analyze hype level"
    triggers:
      - signal: "check-drops"
    execution:
      strategy: "sequential"
      agents:
        - id: "nike-scraper"
        - id: "hype-analyzer"
          context:
            steps: "previous"
        - id: "discord-notifier"
          context:
            steps: "previous"

agents:
  nike-scraper:
    type: "llm"
    description: "Scrape Nike website for new product releases"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Monitor Nike's upcoming releases page and SNKRS app for new drops:

        1. Visit nike.com/launch and upcoming releases
        2. Extract product details: name, SKU, price, release date
        3. Get product images (main photo)
        4. Check if this is a new release (not seen before)

        Use proper headers to avoid blocking:
        - User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36
        - Accept-Language: en-US,en;q=0.9

        Return only NEW releases as JSON array.
      tools: ["web-browser"]

  hype-analyzer:
    type: "llm"
    description: "Analyze potential hype level of new releases"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Analyze the hype potential for each Nike release:

        Consider these factors:
        1. Brand collaboration (Off-White, Travis Scott = HIGH hype)
        2. Limited edition or rare colorways
        3. Retro Jordan releases (especially OG colorways)
        4. Price point (under $200 = more accessible)
        5. Social media buzz and influencer mentions

        Rate each shoe 1-10 for hype level and explain reasoning.
        Include resale value prediction.

  discord-notifier:
    type: "llm"
    description: "Send formatted alerts to Discord"
    config:
      provider: "anthropic"
      model: "claude-3-7-sonnet-latest"
      prompt: |
        Send Discord webhook with new Nike drops:

        Format:
        - HIGH for high hype (8-10), MEDIUM for medium (5-7), LOW for low (1-4)
        - Include product name, price, release date
        - Add hype analysis summary
        - Include product image if available
        - Use Discord embed format for clean display
      tools: ["discord"]

tools:
  mcp:
    servers:
      web-browser:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-puppeteer"]

      discord:
        transport:
          type: "stdio"
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-discord"]
        auth:
          type: "bearer"
          token_env: "DISCORD_WEBHOOK_URL"

memory:
  enabled: true
  retention:
    max_age_days: 14 # Track releases for 2 weeks
```

**Key Points:**

- **Scheduled monitoring**: Checks every 30 minutes automatically
- **Change detection**: Only processes new releases
- **AI-powered analysis**: Intelligent hype level assessment
- **Rich notifications**: Formatted Discord messages with context

## Context Flow Between Agents

Control how data flows between agents in your job execution:

### Sequential Processing (Default)

Most jobs use sequential processing where each agent builds on the previous one:

```yaml
jobs:
  process-data:
    execution:
      strategy: "sequential"
      agents:
        - id: "data-fetcher"
        - id: "data-transformer"
          context:
            steps: "previous" # Gets fetcher's output
        - id: "final-reporter"
          context:
            steps: "all" # Gets all previous outputs
```

### Context Options

- `steps: "previous"` - Only previous agent's output (most common)
- `steps: "all"` - All previous agents' outputs
- `signal: true` - Include original trigger data
- `agents: ["agent1", "agent2"]` - Specific agents' outputs

### Conditional Job Triggering

Use different jobs for different webhook types:

```yaml
jobs:
  handle-alerts:
    triggers:
      - signal: "incoming-webhook"
        condition:
          prompt: "Only run when the webhook type is 'alert'"

  handle-leads:
    triggers:
      - signal: "incoming-webhook"
        condition:
          prompt: "Only run when the webhook type is 'lead'"
```

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

### 5. **MANDATORY: Require Data Source Attribution**

**CRITICAL**: All agents that fetch, retrieve, or access external data MUST include source
attribution in their outputs. This prevents hallucination and provides user transparency.

````yaml
prompt: |
  Fetch the latest product reviews from Amazon and analyze sentiment.

  **MANDATORY OUTPUT REQUIREMENTS**:
  - Include data source URLs for all information
  - Show timestamps when data was retrieved
  - Document which tools were used to access each data source
  - Specify the total number of records processed from each source

  **OUTPUT FORMAT**:
  ```json
  {
    "analysis": { /* your analysis */ },
    "data_sources": [
      {
        "source": "Amazon Product Reviews API",
        "url": "https://api.amazon.com/products/B08N5WRWNW/reviews",
        "tool_used": "amazon-api",
        "retrieved_at": "2024-01-15T14:30:00Z",
        "record_count": 150,
        "status": "success"
      }
    ]
  }
````

**IMPORTANT**: If you cannot access the required data sources, explicitly state:

- Which data sources you attempted to access
- What tools you tried to use
- The specific error or limitation encountered
- That your response contains no external data

````
#### Why Data Source Attribution Matters

1. **User Trust**: Users can verify information and understand data origins
2. **Hallucination Prevention**: Clear attribution prevents agents from fabricating data
3. **Debugging**: When data seems incorrect, users can check the actual sources
4. **Compliance**: Many domains require data provenance for regulatory reasons

#### Enforce Attribution in All Data-Heavy Domains

```yaml
# Financial Analysis
prompt: |
  Analyze stock performance with data from Yahoo Finance.
  Include source URLs, timestamps, and tool names for all financial data.

# Web Scraping
prompt: |
  Extract product information from e-commerce sites.
  Document which CSS selectors were used and which pages were accessed.

# API Integration
prompt: |
  Fetch user metrics from Google Analytics.
  Show API endpoints called, response codes, and data freshness timestamps.

# Database Queries
prompt: |
  Generate sales reports from the customer database.
  Include table names, query execution times, and row counts processed.
````

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
