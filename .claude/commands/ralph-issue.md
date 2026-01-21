---
description: Add a QA-discovered issue to an existing PRD.json for Ralph to pick up
---

Add a task to the existing PRD for a QA-discovered issue.

**Issue:** $ARGUMENTS

## Process

### 1. Load Context

Read these files:
- `scripts/ralph/PRD.json` - existing tasks, verification patterns, task IDs
- Design doc from `PRD.json → meta.designDoc` - architectural context

If PRD.json doesn't exist, stop and tell the user to run `/ralph-prd` first.
If design doc is missing, warn but continue (infer from codebase).

### 2. Infer Task Details

From the issue description and codebase:
- **anchor**: Which file is most relevant? Check if description mentions components, routes, or modules.
- **tier**: Infer from anchor path:
  - `apps/atlasd/routes/` → api
  - `apps/web-client/` → frontend
  - Everything else → backend
- **verification**: Copy patterns from existing PRD tasks for the same tier.
- **acceptanceCriteria**: What would "fixed" look like?

If you can't infer something critical, ask ONE clarifying question.

### 3. TDD Judgment

**Include `tdd` field when:**
- Pure logic bug (validation, calculation, parsing)
- Domain logic error
- Utility function broken
- A regression test would catch this in the future

**Omit `tdd` field when:**
- UI/styling glitch
- Config or wiring issue
- Integration problem
- The fix is obvious and a test wouldn't add value

### 4. Generate Task

Create a task object matching the existing PRD schema:

```json
{
  "id": "task-N",
  "description": "Clear description of what to fix",
  "anchor": "path/to/relevant/file.ts",
  "tier": "backend|api|frontend",
  "tdd": {
    "red": "Specific failing test to write",
    "green": "Minimal fix to pass",
    "refactor": "Optional cleanup"
  },
  "verification": ["commands", "from", "existing", "PRD"],
  "acceptanceCriteria": ["What fixed looks like"],
  "passes": false
}
```

Task ID: increment from highest existing ID in PRD.

### 5. Show and Confirm

Display the generated task object. Wait for user feedback.

If user requests changes, update the task and show again.
If user confirms (or says nothing negative), write to PRD.json.

### 6. Write to PRD

Append the task to `PRD.json → tasks[]` array. Display confirmation:

```
Added task-N to scripts/ralph/PRD.json
```

Do NOT commit - user will commit when ready (may batch multiple issues).
