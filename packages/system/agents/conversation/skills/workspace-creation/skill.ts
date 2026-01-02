import type { Skill } from "../index.ts";

export const workspaceCreationSkill = {
  id: "workspace-creation",
  description:
    "Use when user wants to create automations, monitoring, scheduled tasks, or workflows. Covers workspace planning and creation.",
  instructions: `# Workspace Creation

## When to Use
- User says: "monitor X", "automate Y", "alert when Z", "schedule X"
- User wants recurring/scheduled tasks
- User needs persistent automation

## When NOT to Use
- One-off queries ("what's the weather")
- Questions about capabilities
- Using existing workspaces (use atlas_workspace_signal_trigger instead)

## Required Tools
- workspace-planner: generates plan artifact
- fsm-workspace-creator: creates workspace from artifact
- display_artifact: shows plan to user
- atlas_workspace_describe: get workspace details after creation

## Workflow (follow exactly)

### Step 1: Gather Requirements
Ask about (use numbered list):
1. Trigger: how/when should this start?
2. Frequency: how often? (if recurring)
3. Output: where should results go?
4. Services: what APIs/integrations needed?

### Step 2: Generate Plan
Call workspace-planner with complete user intent.
Returns: {planSummary, artifactId, revision}

### Step 3: Show Plan
Call display_artifact with artifactId.
Present planSummary to user.

### Step 4: Get Approval
NEVER create without explicit approval.
Wait for: "yes", "proceed", "go ahead", "create it"
If user wants changes: call workspace-planner again with same artifactId + changes.

### Step 5: Create Workspace
Only after approval: call fsm-workspace-creator with {artifactId}

## Configuration Requirements

ALWAYS include specific values in workspace-planner intent:
- Slack: "Send to #channel-name" (not "send to Slack")
- Email: "Email to user@domain.com"
- Schedule: "Run every 30 minutes"
- Files: Include full paths like /Users/name/file.csv

## Environment Variables After Creation

After workspace created:
- Atlas services (email, web search) need NO user credentials
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
