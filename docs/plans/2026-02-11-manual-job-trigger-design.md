# Manual Job Trigger UI

## Problem Statement

Users cannot manually trigger workspace jobs from the web UI. Jobs configured
with scheduled or file-watch signals require waiting for their automatic
triggers, and HTTP signal jobs require manual API calls. Users need a one-click
way to run any job directly from the workspace page.

## Solution

Add job cards to the workspace page main content area (below the description)
showing each runnable job with a "Run Now" button. Clicking the button opens a
confirmation dialog that handles signal selection and payload input before
triggering the signal via the existing API.

## User Stories

1. As a workspace user, I want to see all runnable jobs on my workspace page, so
   that I know what actions are available
2. As a workspace user, I want to trigger a job with one click when no payload
   is required, so that I don't have to use the API directly
3. As a workspace user, I want to provide payload data through a form when a
   signal requires it, so that I can trigger jobs with the correct input
4. As a workspace user, I want to select which signal to use when a job has
   multiple triggers, so that I can choose the appropriate trigger method
5. As a workspace user, I want to see a confirmation dialog before running a
   job, so that I don't accidentally trigger work
6. As a workspace user, I want to see required fields clearly marked in the
   payload form, so that I know what input is mandatory
7. As a workspace user, I want a success notification with a link to the new
   session after triggering, so that I can follow the execution without losing
   my place
8. As a workspace user, I want to see an error notification if triggering fails,
   so that I know something went wrong
9. As a workspace user, I want to manually trigger a scheduled job without
   waiting for the cron, so that I can test or run it on demand
10. As a workspace user, I want to manually trigger a file-watch job without
    making file changes, so that I can re-run it when needed

## Implementation Decisions

### Job Cards in Main Content Area

- Rendered below the workspace description, above artifacts/sessions
- Each card shows: job title (bold, inline with button), "Run Now" button, job
  description below
- Only jobs with at least one trigger are shown (no triggers = not runnable from
  UI)
- Job data comes from `workspace.config.jobs` which is already loaded via the
  layout loader

### "Run Job?" Confirmation Dialog

Three variants based on job configuration:

**Single trigger, no schema:**

- Dialog title: "Run {job title}?"
- Confirmation message only
- Run / Cancel buttons

**Single trigger, with schema:**

- Dialog title: "Run {job title}?"
- Form fields derived from signal's `schema.properties`
- Required fields marked from schema's `required` array
- Run / Cancel buttons

**Multiple triggers:**

- Dialog title: "Run {job title}?"
- Radio group for signal selection (signal name + description as labels)
- Selecting a radio reveals that signal's form fields below (if any)
- Run / Cancel buttons

### Form Field Type Mapping

Signal schemas use JSON Schema types. Field mapping:

| JSON Schema type | Input widget    |
| ---------------- | --------------- |
| `string`         | Text input      |
| `number`         | Number input    |
| `integer`        | Number input    |
| `boolean`        | Checkbox        |
| (unknown/absent) | Text input      |

### API Integration

- Trigger endpoint: `POST /api/workspaces/:workspaceId/signals/:signalId`
- Payload: `{ payload: <form data as object> }`
- Response includes `sessionId` for linking to the new session

### Post-Trigger Behavior

- Close dialog on successful trigger
- Show success toast with clickable link to the new session
- Show error toast on failure
- User stays on workspace page

### Signal Selection Logic

- All provider types (http, schedule, fs-watch, system) are supported for manual
  triggering via the existing API endpoint
- Trigger conditions are evaluated server-side and do not affect the UI

## Out of Scope

- References section (shown in screenshot but explicitly excluded)
- Editing job/signal configuration from the UI
- Real-time job execution status in the dialog
- Payload validation beyond required field marking (server validates)
- Condition display or filtering in the UI

## Further Notes

- The existing sidebar already lists jobs and signals by name. Once the main
  content cards are in place, consider whether the sidebar job list is redundant.
- The `workspace.config` data is already available on the page — no new API
  calls needed for rendering job cards. Only the trigger action requires an API
  call.
- Use the existing `Dialog` component (`$lib/components/dialog`). It provides
  `Root`, `Trigger`, `Content`, `Title`, `Description`, `Button`, `Cancel`, and
  `Close` sub-components. See `link-auth-modal.svelte` for the form-in-dialog
  pattern: form goes in the `footer` snippet, `Dialog.Button` with
  `closeOnClick={false}` for submit, `Dialog.Cancel` for cancel, and the
  `children(open)` snippet gives access to the open store for programmatic
  close after successful trigger.
