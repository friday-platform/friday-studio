import type { Skill } from "../index.ts";

export const workspaceCreationSkill = {
  id: "workspace-creation",
  description:
    "Use when user wants to create a workspace — data trackers, automations, monitoring, scheduled tasks, or workflows. Covers workspace planning and creation.",
  instructions: `# Workspace Creation

## When to Use
- User says: "track my X", "log my X", "manage my X", "keep a list of X"
- User says: "monitor X", "automate Y", "alert when Z", "schedule X"
- User wants to store and manage data through conversation
- User wants recurring/scheduled tasks
- User needs persistent automation

## When NOT to Use
- One-off queries ("what's the weather")
- Questions about capabilities
- Using existing workspaces (use workspace_signal_trigger instead)

## Required Tools
- workspace-planner: generates plan artifact (auto-displayed to user)
- fsm-workspace-creator: creates workspace from artifact
- workspace_describe: get workspace details after creation

## Resources (Persistent State)

Workspaces can store persistent data in two ways:

**Table resources** — workspace-scoped database tables that persist between runs.
Agents read/write them via SQL. Good for lists, logs, trackers, inventories, or
any data that must survive across separate job runs. This is Friday's built-in
storage — no external service needed.

**External refs** — connections to external services like Google Sheets, Notion,
Airtable. Friday can link to an existing resource the user already has, or
create a new one in that service on first run.

### When to ask about storage

Ask a storage question whenever the use case involves data that persists between
runs. Signals: "track", "log", "list", "database", "inventory", "portfolio",
"history", "record". Even when the primary ask sounds like monitoring or alerting,
check whether there's underlying state that needs to persist (e.g., "track my
portfolio and alert on moves" — the portfolio holdings are persistent state).

When asking, **always offer Friday's built-in table storage first**, then
external services as an alternative. Do NOT only suggest external services.

When the user mentions an external service:
- If they provide a URL or say "I already have a [Notion database]", configure
  an external ref linking to the existing resource.
- If they say "store in Notion" or "put this in a Google Sheet" without
  referencing an existing resource, configure an external ref with creation
  intent — Friday will create the resource on first run via the service's API.

## Workflow (follow exactly)

### Step 1: Classify Intent

Determine whether this is **data management** or **automation**:

**Data management** — user wants to track, log, list, or manage data through
conversation. Signals: "track my X", "manage my X", "log my X", "keep a list of
X". No external services, no scheduled triggers, no notifications. The workspace
IS the chat — the user interacts with their data by talking to it.

**Automation** — user wants scheduled tasks, monitoring, alerts, or multi-service
workflows. Signals: "monitor X", "alert when X", "every day do X", "sync X to
Y", "send me a report".

Some requests are **hybrid** — data management PLUS automation (e.g., "track my
food and send me a weekly summary on Slack"). Treat these as automation with a
data storage component.

### Step 2: Gather Requirements

**For data management workspaces**, ask only about data:
1. What data do you want to track? What fields matter?
2. Do you want to store it in Friday (built-in, no external service needed), or
   in an external service like Notion or Google Sheets?

Do NOT ask about triggers, frequency, output destinations, or services — these
are chat-first workspaces with no automation. Do NOT frame the interaction as
"on-demand triggering" or mention signals/webhooks.

**For automation workspaces** (and hybrid), ask about:
1. Trigger: how/when should this start?
2. Frequency: how often? (if recurring)
3. Data: does this need to track or store anything over time? Suggest storing it
   as a table in Friday (built-in, no external service needed), or connecting to
   an external service like Google Sheets or Notion — either linking to an
   existing resource or having Friday create a new one.
   Example phrasing: "Do you want to store [the data] in Friday so it persists
   between runs, or would you prefer an external service like Notion or Google
   Sheets? I can connect to one you already have or create a new one."
4. Output: where should results go? (email, Slack, etc.)
5. Services: what APIs/integrations needed?

### Step 3: Generate Plan
Call workspace-planner with complete user intent.

**For data management workspaces**, frame the intent clearly:
- Describe the data and its schema
- Say "store in Friday" (or the chosen external service)
- Do NOT mention triggers, signals, webhooks, or on-demand submission
- Do NOT say "the user triggers it manually" — that implies a signal

Example good intent: "Track daily food intake. Store in Friday with columns:
food_name, quantity, meal_type (breakfast/lunch/dinner/snack), logged_at. No
external services."

Example bad intent: "Create a food tracker with on-demand logging. The user
triggers it manually by submitting what they ate. The signal should accept..."

Returns: {planSummary, artifactId, revision}
The plan is automatically displayed to the user — do NOT call display_artifact.
Present planSummary to user and wait for approval.

### Step 4: Get Approval
NEVER create without explicit approval.
Wait for: "yes", "proceed", "go ahead", "create it"

**On approval (user says yes):**
- The artifactId is in workspace-planner's response
- Go directly to Step 5
- DO NOT call workspace-planner again

**On change request (user asks for modifications):**
- Call workspace-planner with SAME artifactId + user's changes
- This creates a revision, not a new plan
- Return to Step 3 to show updated plan

### Step 5: Create Workspace
IMMEDIATELY after approval, call fsm-workspace-creator with {artifactId}.
Do NOT re-plan. The plan was already approved.

### Step 6: Handle Creation Errors

If fsm-workspace-creator fails:

**"Missing integrations" or error has missingCredentials array:**
The error includes structured data for recovery:
- missingCredentials: array of {provider, service} objects
- suggestedAction: "connect_service"

IMMEDIATELY call connect_service for each missing provider:
1. Parse missingCredentials from the error response
2. For each credential, call connect_service(provider)
3. If connect_service returns an error, follow its guidance before retrying
4. Wait for OAuth/install completion
5. Retry fsm-workspace-creator with the SAME artifactId
6. DO NOT re-plan - credentials won't appear via re-planning

Example: If missingCredentials = [{provider: "google-calendar", service: "Google Calendar"}]
→ Call connect_service("google-calendar")
→ After user completes OAuth, retry fsm-workspace-creator

**"registration failed" or other errors:**
- Report the error clearly
- Ask if user wants to try again or modify the plan
- DO NOT automatically re-plan

CRITICAL: Never call workspace-planner after creation failure unless user explicitly asks to change requirements.

## Configuration Requirements

ALWAYS include specific values in workspace-planner intent, except credential
account details (which account to use is picked at plan approval time via a
credential picker):
- Slack: "Send to #channel-name" (not "send to Slack")
- Email destination: "Email to user@domain.com"
- Schedule: "Run every 30 minutes"
- Files: Include full paths like /Users/name/file.csv
- Resources: describe what data to store and its structure
  (e.g., "Track grocery items with name, quantity, category, and purchased status")
- Services: refer by capability ("Google Calendar", "Linear"), omit credential
  labels or account identifiers

## Environment Variables After Creation

After workspace created:
- Platform services (email, web search) need NO user credentials
- Only external services need credentials
- Check \${VAR_NAME} patterns in workspace config

## Test Policy

When user says "test" or "try":
1. Create with ephemeral=true
2. Trigger the job
3. Show results
4. Ask if they want permanent

## Critical Rules

- NEVER invent credential names
- NEVER skip approval step
- ALWAYS preserve file paths from attachments
- ALWAYS include specific channels/addresses in config`,
} as const satisfies Skill;
