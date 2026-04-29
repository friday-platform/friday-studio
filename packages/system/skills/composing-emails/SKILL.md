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
