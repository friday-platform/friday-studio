---
name: writing-to-memory
description: "How to read and write Friday memory stores correctly: store selection, terse entry format, large-content artifact pattern, and what's auto-injected into the system prompt."
---

# Writing to Memory

## Memory tool surface

Three verbs, one canonical name each across every caller (chat, FSM `type: llm` actions, `type: atlas` / `type: user` agents):

| Verb | Tool | Notes |
|---|---|---|
| Save an entry | `save_memory_entry({ memoryName, text, metadata? })` | Appends; persists across sessions. |
| Read entries | `list_memory_entries({ memoryName, query?, since?, until?, metadata?, limit?, cursor? })` | Newest-first by default; `truncate` caps each entry's text at 500 chars. |
| Remove an entry | `delete_memory_entry({ memoryName, entryId })` | Idempotent. |

Same verb-first pattern for artifacts: `create_artifact` / `get_artifact` / `parse_artifact` / `display_artifact`.

**Repair note:** these tools were renamed from `memory_save` / `memory_read` / `memory_remove` (and `artifacts_create` / `artifacts_get`) in 2026-05. Installed Python agents that hard-coded the old names need a grep-and-replace — see `@friday/repairing-workspaces-agents` for the recipe.

## Narrative is the only memory strategy

Friday memory is markdown narrative stores — append-only, auto-injected into agent prompts, queryable via `list_memory_entries`. There is no separate retrieval, dedup, or kv backend; if a user asks for "vector search over my notes" or "KV-style lookup", surface the limitation instead.

For everything narrative covers — preferences, standing instructions, durable facts, working notes, anything you want the agent to remember and reference next turn — declare a narrative store and you're done.

## How memory is injected

At the start of every turn, the 20 most recent entries from each narrative store are injected into your system prompt as:

```xml
<memory workspace="zesty_mushroom" store="preferences">
- Always archive newsletters from substack.com (2026-04-15)
- GitHub CI failures → keep unread
</memory>
```

Each block is labeled with `workspace` and `store` so you know exactly what you're reading. You do not need to call `list_memory_entries` to access this content — it's already there.

For explicit lookup, time-filtering, or reading beyond the 20-entry window:
```
list_memory_entries(memoryName="preferences", since="2026-01-01T00:00:00Z", limit=50)
```

To remove a stale entry: `delete_memory_entry(memoryName, entryId)`.

## Store selection

Check `<memory_stores>` in your workspace context for what's available. Pick the store that best matches the content — do not default to `notes` without considering the alternatives.

| Store | Type | Default lifecycle | Use for |
|---|---|---|---|
| `notes` | short_term | **ephemeral, session-bound** — auto-deleted at session-complete | In-progress state, working context, things that don't need to persist |
| `memory` | long_term | **durable** | Facts the agent should remember next turn / next session — what was built, decided, observed |
| `preferences` | long_term | **durable** | User standing instructions, formatting rules, explicit preferences |
| custom | any | follows `type:` default; override with `ttl:` | Domain-specific; declared via `upsert_memory_own` |

`type: short_term` is genuinely short-term: notes you write during a session don't survive past it unless you explicitly write the same content to a long_term store. `type: long_term` persists across sessions until explicitly removed via `delete_memory_entry`. Override per-store via `memory.own[].ttl: <duration>` in workspace.yml when you want a specific TTL different from the type default.

If the right store doesn't exist yet, call `upsert_memory_own` to declare it before writing. A store must exist in `workspace.yml` (or the active draft) before `save_memory_entry` will accept it.

## Entry format

**Write terse entries.** Memory is injected on every turn — verbose entries waste tokens and dilute signal.

Rules:
- One fact per entry. Never bundle unrelated things.
- Keep entries under ~100 chars. Longer content belongs in an artifact (see below).
- Write the fact directly — no preamble ("The user told me that...", "I noticed that...").
- Suffix time-sensitive facts with `(YYYY-MM-DD)`.
- Never duplicate. Call `list_memory_entries` first if unsure whether a fact is already stored; update via `delete_memory_entry` + `save_memory_entry` rather than appending a conflicting entry.

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

**Step 1 — call `create_artifact` with the content inline:**
```
create_artifact(
  data={type:"file", content:"<full content>", originalName:"q1-analysis.md"},
  title="Q1 email analysis",
  summary="..."
)
→ { artifactId: "art_abc123" }
```

The storage layer hashes the bytes (SHA-256), sniffs the mime type from
the magic bytes if you don't pass `mimeType`, and writes to the JetStream
Object Store named by hash — identical bytes dedup automatically. No
filesystem hop, no `write_file → create_artifact(path)` two-step.

For binary content over a JSON wire (e.g. images returned by a tool),
base64-encode the bytes and pass `contentEncoding: "base64"`:
```
create_artifact(
  data={type:"file", content:"<base64>", contentEncoding:"base64", mimeType:"image/png", originalName:"chart.png"},
  ...
)
```

**Step 2 — save a terse reference to memory:**
```
save_memory_entry(memoryName="memory", text="Q1 email analysis → art_abc123 (2026-04-29)")
```

**Step 3 — retrieve later:**
When you see `→ art_abc123` in an injected memory entry, call `get_artifact(id="art_abc123")` to load the full content on demand.

This keeps the injection window lean while making large results durable across sessions.

### Memory references promote artifacts to durable

FSM-emitted artifacts default to **ephemeral** with a grace window (default 24h after job completion); a background sweeper deletes them once the window closes. **An artifact stays durable iff something references it before the sweep**: a `save_memory_entry` text containing the artifact ID, a `display_artifact` call, or an `aiSummary.keyDetails[].url` pointing at it.

So step 2 above isn't just bookkeeping — it's the durability decision. If you don't `save_memory_entry` a reference (or surface the artifact some other way), it'll be gone in 24h.

If you *want* something gone — intermediate working state — write the artifact and never reference it. The sweeper handles cleanup. Don't try to manage lifetimes manually.

### Recent artifacts auto-inject into prompts

Per-session artifact context auto-injects into LLM prompts as
`<retrieved_content provenance="artifact:..." origin="..." fetched_at="...">`
blocks at action start (chat: per-chat-session; FSM: per-FSM-session). The block carries each artifact's **summary**, not its content — the LLM sees a 1-line digest plus the artifactId. If a digest looks relevant, call `parse_artifact(artifactId)` to load the content.

Practical implication for `summary` field: when you `create_artifact`, write a useful 1-2 sentence summary. The LLM's later turns rely on it to decide whether to expand the artifact.

## Availability

`save_memory_entry`, `list_memory_entries`, `delete_memory_entry`, the `state_*` tools, the
`artifacts_*` tools, and `webfetch` are wired into every execution context with
`workspaceId` auto-injected from the runtime scope. You never pass
`workspaceId` — the runtime overrides it (defense in depth: a foreign
workspaceId in args is replaced before the tool runs).

**Authoring rule for FSM `type: llm` actions: do NOT redeclare these in
the action's `tools:` array.** They are auto-injected on top of any
allowlist you provide. Listing `save_memory_entry` or `create_artifact` in
`tools:` is harmless but adds noise. To genuinely lock an action down
to "memory + artifacts only," declare `tools: []` (empty) — the
auto-injected built-ins still work, the workspace MCP catalog gets
narrowed away.

| Context | Tool surface | Call shape |
|---|---|---|
| Workspace-chat / conversation | direct tool call | `save_memory_entry({ memoryName, text })` |
| `type: "llm"` workspace agents | LLM tool call | `save_memory_entry({ memoryName, text })` |
| `type: "atlas"` SDK agents | `tools.execute(...)` | `{ memoryName, text }` |
| FSM LLM action steps | LLM tool call | `save_memory_entry({ memoryName, text })` |
| `type: "user"` Python/TS agents | `ctx.tools.call(name, args)` | `ctx.tools.call("save_memory_entry", { memoryName, text })` |

Stores must be declared in `workspace.yml` under `memory.own` (or reachable
via an `rw` mount). Undeclared stores are rejected with the list of declared
ones.

**User-agent footgun:** `ctx.tools.call(...)` raises `ToolCallError` on
validation failure (e.g. store not declared, narrative-only constraint).
*Never* swallow with `except Exception` — surface the error via `err()` or
fall through to your own retry. The autopilot family of bugs all started
with a swallowed `ToolCallError` masking a silent write loss.
