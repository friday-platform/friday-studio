---
name: using-elicitations
description: |
  Asks the user mid-run from inside an FSM action or Python `type: user`
  agent via the elicitation tools — `request_tool_access` for allowlist
  approvals and `request_human_input` for HITL (human-in-the-loop)
  decisions, approvals, confirmations, and disambiguation. Use when a job
  needs the user to choose, approve, or supply input before the action
  can continue. Covers simple multiple choice, nested per-item choice,
  prompt formatting, and how to consume the answer.
---

# Using elicitations

Elicitations pause a running FSM action (or Python `type: user` agent), surface a prompt to the user in the Activity feed, and resume the same tool call with the user's answer. Two tools, one mechanism.

- `request_tool_access(toolName, reason)` — ask for permission to call a tool not in the action's allowlist. Fixed options: Allow once, Allow always, Deny.
- `request_human_input(question, options?)` — ask the user a question. Flat options for simple choice, free-form text when options omitted, or grouped per-item options for nested choice.

Both tools **block** until the user answers, declines, or the elicitation expires. The terminal answer comes back as the tool's return value, and the action continues from there in the same run.

## Choosing between them

| Need | Tool |
|---|---|
| Permission to call a tool you don't have | `request_tool_access` |
| A user decision between alternatives | `request_human_input` (with `options`) |
| Free-form user text | `request_human_input` (no `options`) |
| Approval before a destructive side effect | `request_human_input` with `[Confirm, Cancel]` |
| One choice for each of several items | `request_human_input` with grouped options |

Never substitute a prose menu for `request_human_input`. An `outputTo` action that prints choices and waits for a future user message will fail — the action only resumes through the elicitation answer envelope.

## Formatting the question

The `question` field renders as plain text with whitespace preserved. The UI does not parse markdown.

- No `**bold**`, no `#` headings, no `- ` bullets, no fenced code. They render literally.
- Lead with a short top-level title and a one-line description of what the user is choosing.
- Keep the question itself terse — the action's verbose context belongs in the action's prose output, not the prompt body.
- Newlines are preserved; use them to separate sections, never markdown.

Bad — markdown that renders as raw characters:

```
**Pick an action:**
- Archive
- Keep
```

Good — plain text, short intro, options carry the choice copy:

```
Pick an action for this receipt.
```

## Simple multiple choice

One question, one answer. Flat `options` array, each `{ label, value }`. `label` is shown to the user; `value` is what the agent receives back.

```json
{
  "question": "Send the invoice now?",
  "options": [
    { "label": "Send now", "value": "send" },
    { "label": "Save as draft", "value": "draft" },
    { "label": "Cancel", "value": "cancel" }
  ]
}
```

The answer comes back as `{ status: "answered", answer: "send" }`. Branch on `answer` and continue. On `status: "declined"` or `"expired"`, stop safely and explain what was blocked.

Do not pass `multi_select`, `default`, `required`, or any other fields — the schema rejects them. For multiple independent selections, use grouped nested choice below.

## Nested multiple choice — one decision per item

When the user must pick one action for each of several items (the inbox-triage shape), encode the item index in both label and value. The UI groups the options into one choice set per item and returns the selected values as a JSON-array answer string.

Question body — short intro, then numbered items with detail lines:

```
Review your inbox — select an action for each email.

[1] Subject: Your receipt
    From: billing@example.com
    Date: May 7, 2026
    Preview: Monthly subscription paid

[2] Subject: Meetup reminder
    From: events@example.com
    Date: May 7, 2026
    Preview: Quarterly community meetup tomorrow
```

Detail line keys the parser recognises: `Subject:`, `From:`, `Date:`, `Preview:`. Use them — the UI lifts those values into the per-item header. Anything else under a `[N]` block is shown as supporting text.

Options — one entry per (item, action). `label` is `[N] ActionLabel — Title`. `value` is `N:action`:

```json
{
  "label": "[1] Archive — Receipt",
  "value": "1:archive"
}
```

A full grouped call:

```json
{
  "question": "Review your inbox — select an action for each email.\n\n[1] Subject: ...\n[2] Subject: ...",
  "options": [
    { "label": "[1] Archive — Receipt", "value": "1:archive" },
    { "label": "[1] Keep — Receipt", "value": "1:keep" },
    { "label": "[1] Delete — Receipt", "value": "1:delete" },
    { "label": "[2] Archive — Meetup reminder", "value": "2:archive" },
    { "label": "[2] Keep — Meetup reminder", "value": "2:keep" },
    { "label": "[2] Delete — Meetup reminder", "value": "2:delete" }
  ]
}
```

Requirements for the grouping to fire:

- At least two items (`[1]`, `[2]`).
- At least two actions per item.
- Every option value is `N:action` where `N` matches an item index in the question.
- Every option label starts with `[N]` matching the same index.

If any constraint fails, the UI falls back to a flat radio list of all options — usable, but the per-item structure is lost.

The answer comes back in `answer.value` as a JSON array string:

```
"[\"1:archive\",\"2:keep\"]"
```

Parse it before acting:

```ts
const picks: string[] = JSON.parse(answer.value);
for (const pick of picks) {
  const [idx, action] = pick.split(":");
  // dispatch (idx, action)
}
```

Optional per-item comments arrive in `answer.note` as `[N] free text`. Treat as advisory context, not as a parallel command stream.

When per-item input is complex (free-form text, multiple fields), ask one item at a time instead of flattening. The grouped contract is for one choice per item, nothing more.

## Handling tool-access requests

`request_tool_access(toolName, reason)` returns one of:

| `reason` | `granted` | What it means |
|---|---|---|
| `bypass` | true | Workspace/daemon has `dangerouslySkipAllowlist`; proceed silently |
| `persistent_allow` | true | The user previously chose Allow always for this tool |
| `answered` | true/false | User picked Allow once / Allow always / Deny |
| `pending_user_approval` | false | Elicitation created but not yet answered (rare — usually you wait) |
| `declined` | false | User declined |
| `expired` | false | Elicitation TTL elapsed |
| `unknown_tool` | false | `toolName` not in the runtime catalog — do not retry |

Rules:

- Only request access to tools you know exist. If you don't know the name, call `list_capabilities` or `list_mcp_tools` first. An `unknown_tool` response means stop guessing.
- The `reason` field is shown to the user verbatim. Make it specific to the moment ("Need fs_write_file to save the patch we just drafted"), not generic ("Need write access").
- On `granted: true`, continue in the same action and finish normally.
- On `granted: false`, do not retry the underlying tool. Acknowledge what was blocked and either route around it or stop safely.

Authoring rule: only declare `request_tool_access` on actions that can produce a useful denial outcome (partial result, clear explanation). Don't list it as a generic escape hatch.

## Handling human-input answers

`request_human_input` blocks until terminal, then returns:

```ts
{
  ok: boolean,
  status: "answered" | "declined" | "expired",
  elicitationId: string,
  answer?: string,
  note?: string,
}
```

- `status: "answered"` → branch on `answer`. For grouped prompts, `JSON.parse(answer)` first.
- `status: "declined"` or `"expired"` → halt the side effect, summarise what was skipped, and finish the action without faking the answer.

Python `type: user` agents call the same primitive through `ctx.tools.call("request_human_input", {"question": ..., "options": [...]})` with the same return shape.

## Lifecycle and timeouts

- Elicitation TTL inherits the parent job's `config.timeout` (override per-job with `jobs.<name>.elicitations.timeout`). Default is 30 minutes.
- The same `(question, options, sessionId, actionId)` re-uses any still-pending elicitation rather than creating a duplicate. Accidental retries are idempotent.
- Expired prompts move to a read-only Activity log entry; the user cannot answer them retroactively, and acting on one does not reify the timed-out job.

## Gotchas

- The `question` field renders plain — markdown becomes literal characters. Use newlines and short prose, not formatting tokens.
- `options` is flat. There is no `multi_select`, no `default`, no nested option objects. Encode item grouping in label/value strings.
- Grouped options need at least two items and at least two actions per item or the UI falls back to a flat list.
- `request_tool_access` is for permission, not for asking the user what tool to use. If the underlying problem is "which provider", that is a `request_human_input` question with options like `[Gmail, Outlook]`, not a tool-access request.
- An `outputTo` LLM action must complete in one execution. Without `request_human_input`, the action cannot wait for a user reply — the run will end without the answer.
- Don't call `request_human_input` with no options when you actually expect a fixed choice. Either provide options (so the UI renders buttons) or expect free-form text — pick one.
- Per-item comments in `answer.note` are advisory. Do not parse them for primary commands — those go in `answer.value`.
