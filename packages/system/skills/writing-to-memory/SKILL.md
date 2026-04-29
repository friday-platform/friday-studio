---
name: writing-to-memory
description: "How to read and write Friday memory stores correctly: store selection, terse entry format, large-content artifact pattern, retrieval, and what's auto-injected into the system prompt."
user-invocable: false
---

# Writing to Memory

## How memory is injected

At the start of every turn, the 20 most recent entries from each narrative store are injected into your system prompt as:

```xml
<memory workspace="zesty_mushroom" store="preferences">
- Always archive newsletters from substack.com (2026-04-15)
- GitHub CI failures → keep unread
</memory>
```

Each block is labeled with `workspace` and `store` so you know exactly what you're reading. You do not need to call `memory_read` to access this content — it's already there.

For explicit lookup, time-filtering, or reading beyond the 20-entry window:
```
memory_read(memoryName="preferences", since="2026-01-01T00:00:00Z", limit=50)
```

To remove a stale entry: `memory_remove(memoryName, entryId)`.

## Store selection

Check `<memory_stores>` in your workspace context for what's available. Pick the store that best matches the content — do not default to `notes` without considering the alternatives.

| Store | Type | Use for |
|---|---|---|
| `notes` | short_term | In-progress state, working context, things that will expire |
| `memory` | long_term | Durable facts — what was built, decided, observed |
| `preferences` | long_term | User standing instructions, formatting rules, explicit preferences |
| custom | any | Domain-specific; declared via `upsert_memory_own` |

If the right store doesn't exist yet, call `upsert_memory_own` to declare it before writing. A store must exist in `workspace.yml` (or the active draft) before `memory_save` will accept it.

## Entry format

**Write terse entries.** Memory is injected on every turn — verbose entries waste tokens and dilute signal.

Rules:
- One fact per entry. Never bundle unrelated things.
- Keep entries under ~100 chars. Longer content belongs in an artifact (see below).
- Write the fact directly — no preamble ("The user told me that...", "I noticed that...").
- Suffix time-sensitive facts with `(YYYY-MM-DD)`.
- Never duplicate. Call `memory_read` first if unsure whether a fact is already stored; update via `memory_remove` + `memory_save` rather than appending a conflicting entry.

✅ Good:
```
Always archive newsletters from substack.com
GitHub CI failures → keep unread
Q1 email analysis → art_abc123 (2026-04-29)
Prefers CSV over JSON for data exports
```

❌ Avoid:
```
The user mentioned that they would like newsletters from substack.com to be archived automatically in the future because they find them distracting
```

## Large content → artifact reference pattern

Anything over ~500 chars (result sets, reports, structured data, analyses) must not go directly into memory — it will bloat every future turn's system prompt.

**Step 1 — save the content as an artifact:**
```
artifacts_create(type="document", title="Q1 email analysis", content=<full content>)
→ { id: "art_abc123" }
```

**Step 2 — save a terse reference to memory:**
```
memory_save(memoryName="memory", text="Q1 email analysis → art_abc123 (2026-04-29)")
```

**Step 3 — retrieve later:**
When you see `→ art_abc123` in an injected memory entry, call `artifacts_get(id="art_abc123")` to load the full content on demand.

This keeps the injection window lean while making large results durable across sessions.

## Availability

`memory_save`, `memory_read`, `memory_remove`, and the artifact tools are available in all execution contexts:

- Workspace-chat and delegated sub-agents
- `type: "llm"` workspace agents
- FSM jobs (LLM action steps)
- `type: "user"` SDK agents (via the `atlas-platform` MCP server)
