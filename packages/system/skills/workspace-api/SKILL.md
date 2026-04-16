# Workspace API

Create and manage workspaces by calling the daemon HTTP API via the `run_code` tool.

## Creating a Workspace

Use `run_code` with language `bash` to call the daemon API:

```bash
curl -s -X POST http://localhost:8080/api/workspaces/create \
  -H 'Content-Type: application/json' \
  -d '{
    "config": {
      "version": "1.0",
      "workspace": {
        "name": "WORKSPACE_NAME",
        "description": "WORKSPACE_DESCRIPTION"
      },
      "memory": {
        "own": [
          { "name": "user-profile", "type": "long_term", "strategy": "narrative" },
          { "name": "notes", "type": "long_term", "strategy": "narrative" },
          { "name": "scratchpad", "type": "scratchpad", "strategy": "narrative" }
        ]
      }
    },
    "workspaceName": "WORKSPACE_NAME"
  }'
```

Replace `WORKSPACE_NAME` and `WORKSPACE_DESCRIPTION` with the user's values.

The response returns `{ "workspace": { "id": "...", "name": "...", ... } }` on success.

## Standard Memory Configuration

Always include the standard memory config unless the user specifies otherwise:
- `user-profile` (long_term, narrative) — persistent user preferences
- `notes` (long_term, narrative) — general notes and context
- `scratchpad` (scratchpad, narrative) — temporary working memory

## Adding Agents

To include agents in the workspace, add an `agents` key to the config:

```json
"agents": {
  "agent-id": {
    "name": "Agent Name",
    "description": "What this agent does",
    "instructions": "Detailed instructions for the agent"
  }
}
```

## Adding Signals

To add triggers (HTTP webhooks, cron schedules):

```json
"signals": {
  "signal-id": {
    "description": "When this fires",
    "schema": {
      "type": "object",
      "properties": {
        "input_field": { "type": "string", "description": "Field description" }
      }
    }
  }
}
```

## Adding Jobs

To add FSM pipelines that run on signals:

```json
"jobs": {
  "job-id": {
    "title": "Job Title",
    "triggers": [{ "signal": "signal-id" }],
    "steps": [
      { "agent": "agent-id", "instructions": "What to do in this step" }
    ]
  }
}
```

## Listing Workspaces

```bash
curl -s http://localhost:8080/api/workspaces | python3 -m json.tool
```

## Getting Workspace Details

```bash
curl -s http://localhost:8080/api/workspaces/WORKSPACE_ID | python3 -m json.tool
```

## Workflow

1. Ask the user what they want the workspace to do
2. Determine a good name and description
3. Use `run_code` with bash to call the create API
4. Parse the response and confirm the workspace was created
5. Share the workspace ID so they can find it in the sidebar

## Tips

- Keep workspace names short and kebab-case friendly (the API auto-sanitizes)
- For simple data tracking / note-taking workspaces, just name + description + memory is enough
- For automation, add agents + signals + jobs
- The user can always edit the workspace.yml later from the workspace edit page
