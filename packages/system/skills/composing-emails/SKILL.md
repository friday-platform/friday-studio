---
name: composing-emails
description: General styling and tone guidelines for composing HTML emails. Use when writing email copy that will be rendered as HTML — covers the paragraph/heading/link block model, tone, subject lines, and how to handle data, URLs, and emphasis without markdown.
user-invocable: false
---

# Composing emails

## The block model

Emit content as an array of `{ tag, content }` blocks. Only three tags exist:

- **paragraph** → `<p>` body copy
- **heading** → `<h2>` section header
- **link** → `<a>` for URLs

No lists, tables, images, bold/italic, blockquotes, or code blocks. If you need emphasis, use a heading + paragraph. If you need a list, write each item as its own paragraph. All strings are HTML-escaped, so don't try to inject tags.

## Formatting rules

- No markdown. No `#` headings, no `**bold**`, no `- ` bullets — they render literally.
- No newlines inside a block's `content` — break into separate blocks instead.
- Preserve URLs from source data as `link` blocks, not inline in paragraph text.
- Format numbers, prices, and dates clearly inside paragraph copy (e.g. `$1,234.56`, `April 28, 2026`).

## Tone

- Professional but friendly
- Descriptive subject line — not "Update" or "FYI"
- Lead with the point; don't bury it under context
- One idea per paragraph

## Recipient sourcing

Always read the recipient address from a typed signal-payload field interpolated into the action prompt — never from upstream agent output. LLM agents will confabulate plausible-looking addresses when the field is absent rather than failing.

Wire it end-to-end:

1. **Signal schema** declares the recipient as a `required` field — caller can't trigger the job without it.

   ```yaml
   signals:
     send-alert:
       schema:
         type: object
         properties:
           notify_email: { type: string, format: email }
         required: [notify_email]
   ```

2. **Action prompt** interpolates from the signal payload (works in any step, including ones with `inputFrom` — see `writing-workspace-jobs` → "Signal payload threading"):

   ```yaml
   - type: agent
     agentId: emailer
     prompt: "Send the alert to {{inputs.notify_email}}"
   ```

3. **Email-sender agent system prompt** should refuse rather than guess: *"If the recipient address contains an unresolved `{{...}}` placeholder or is missing, call `failStep` with a reason. Never invent a recipient."*

The literal-placeholder check is the important part — the FSM engine intentionally leaves unresolved placeholders verbatim so authoring bugs stay visible. A guarded agent treats that as a hard stop.
