# Bundled-Agent Discovery — Make `type: atlas` a First-Class Citizen

## Status

Resolved 2026-04-28 via domain-model interview. Key deltas from initial draft:

- **Three agent types, not four.** `system` dropped from `upsert_agent` description and SKILL teaching. It exists in `WorkspaceAgentConfigSchema` but is server-internal only — never user-authorable, never discoverable.
- **Unified credential field.** All three `Capability` variants carry `requiresConfig: string[]`. The original `credentialed: boolean` on `mcp_enabled` was rejected (forces a second tool call to learn what's missing).
- **`tools?: string[]` dropped from `mcp_enabled`.** `list_mcp_tools` is the existing drill-down; inconsistent-presence on a discovery field is the worst LLM contract.
- **`constraints?: string` added to bundled entries.** Bundled agents have meaningful operational caveats (`web`'s CAPTCHA limits, etc.) that are decisive when picking between similar agents. Worth ~1-1.5K tokens in the list response.
- **No input-shape drill-down tool.** All 18 bundled agents take `string` as per-invocation input. Nothing structured to drill into. `describe_capability` was considered and rejected on this basis.
- **`get_workspace_mcp_status` renamed to `get_mcp_dependencies`.** Scope tightens to the dependency graph (`agentIds`/`jobIds` per server). The "is this credentialed" question moves entirely into `list_capabilities`.
- **Aliases (`browser`, `research` → `web`) invisible to discovery.** Canonical only. Aliases stay in the registry as a server-side back-compat sentinel; no proactive migration of existing workspaces.
- **Cache cadence rule.** SKILL teaches: call `list_capabilities` once at session start; re-call only after `enable_mcp_server`. Bundled set + MCP catalog are stable for the session.
- **Bundled-first as structural ordering, with SKILL nuance.** The list orders bundled before MCP. SKILL teaches: bundled when the work is open-ended within a domain (sub-agent reasoning), MCP when the work is deterministic / single-call. Over-bundling > under-bundling.

Tool count after this change: **17** (`list_mcp_servers` removed, `list_capabilities` added, `get_workspace_mcp_status` renamed in place).

## Problem Statement

`packages/config/src/agents.ts` defines `WorkspaceAgentConfigSchema` as a discriminated union over **four** agent types: `llm`, `system`, `atlas` (bundled platform agents like `web`, `email`, `slack`, `gh`, `claude-code`, `data-analyst`, `image-generation`, `knowledge`), and `user` (Python/TS SDK code agents). The `workspace-api` skill teaches the LLM about exactly **two** of them — `llm` and `user`. The `atlas` and `system` types are invisible to workspace-chat at authoring time.

The observable failure, from a recent transcript: the user asked workspace-chat to build a workspace that does web scraping. The chat dutifully created `type: llm` agents with empty `tools: []` arrays, then reached for `playwright-mcp` to give them rendering capability. When the user asked why it didn't use the bundled web agent, it responded:

> "I don't see a web agent declared in this workspace's config, and I don't have documentation in front of me about a platform-level bundled agent by that name."

It then guessed that "bundled web agent" might mean `agent_web` — the conversation-level tool exposed to workspace-chat itself — and dismissed it as un-wireable into a workspace job. It is in fact wireable: `type: atlas, agent: "web"` resolves to the same `webAgent` from `bundledAgentsRegistry`. The chat did not know this because nothing told it.

The deeper failure modes:

1. **No discovery surface for bundled agents.** `list_mcp_servers` exists for MCP. There is no equivalent for bundled agents. The chat can only learn about a bundled agent if the skill happens to mention it, or if the user names it. The platform's gold-standard reusable building blocks are completely opaque.

2. **The tool description for `upsert_agent` lies by omission.** The current input description (`upsert-tools.ts:66`) says: *"For agents: { type, description, config: { provider, model, prompt, ... } }."* That's the `llm` shape, and only the `llm` shape. The other three types are not mentioned. So even if the LLM somehow learned `type: atlas` exists, the tool's own self-description steers it back to `type: llm`.

3. **The skill's LLM-vs-Python decision matrix is buried.** It exists at line ~295 of 355 in `workspace-api/SKILL.md`. The 7-step recipe at the top says "Agents first" with no flag for "type check before you write a prompt." The cheat sheet's tool-selection list doesn't even mention `writing-friday-agents`. The LLM follows the cheat sheet, skips the matrix, defaults to `type: llm`.

4. **Two parallel discovery paths is a behavioral assumption.** Even if we added a `list_bundled_agents` tool alongside `list_mcp_servers`, we'd be relying on the LLM to *remember* to call both. Behavioral assumptions are exactly what the broader workspace redesign is trying to eliminate (validator-as-compiler, schema-tight mutation tools, draft atomicity). Discovery should not be the one place we revert to "and the LLM also has to remember…"

The cost of getting this wrong is concrete: every workspace built today that needs web rendering, web search, GitHub ops, Slack messaging, image generation, or data analysis ends up with a hand-rolled `type: llm` agent plus an MCP server doing roughly what a bundled agent does — but with worse defaults, more credentials to wire, and more failure modes.

## Solution

Three coordinated changes, shipped together:

1. **Replace `list_mcp_servers` with `list_capabilities`** — a single discovery tool that returns a flat tagged-union list across bundled agents, enabled MCP servers, and available MCP servers. Output is sorted bundled-first when the description domain overlaps, so the LLM scanning the list naturally picks the bundled option.

2. **Rewrite the `upsert_agent` tool description** to enumerate all four agent-type shapes in one line each, with a pointer to `list_capabilities` for the `atlas` and `user` paths. Server-side validation is unchanged — the underlying `WorkspaceAgentConfigSchema` already accepts the full union.

3. **Restructure `workspace-api/SKILL.md`** to make `type: atlas` first-class: replace the "two agent types" claim with a three-row table at the top (`atlas | user | llm`), rewrite recipe step 1 to call `list_capabilities` before any agent authoring, add `type: atlas` examples to the cheat sheet and the `assets/example-jobs-pipeline.yml` fixture, and reference bundled agents dynamically (via the tool) rather than carrying a static inventory in the skill.

`list_user_agents` is intentionally not added. Per the brainstorming session: the chat's expected workflow for user agents is "create purpose-specific Python agent → register → upsert into workspace," not "pull one off the shelf." Workspace-scoped user agents are a separate design problem and not blocking this work.

The validator-warning approach (e.g., flagging `type: llm` + `playwright-mcp` and suggesting `type: atlas, agent: "web"` instead) was considered and rejected for v1 — see *Out of Scope*. Discovery + skill guidance pushes the decision earlier in the loop, where the LLM is reasoning about shape, not getting nudged after the fact.

## User Stories

### Discovery

1. As workspace-chat, I want to call one tool and learn every capability available to a workspace — bundled agents and MCP servers — so that I cannot accidentally skip an entire category of building blocks.

2. As workspace-chat, I want bundled agents to appear before MCP options when both could fulfill the same intent, so that I default to the simpler, zero-config path without having to know which is which.

3. As workspace-chat, I want each capability entry to carry enough description and examples that I can match it to user intent without a second tool call, so that discovery is one step.

### Authoring

4. As workspace-chat, I want the `upsert_agent` tool's own description to show me all four valid agent-type shapes, so that the tool's contract doesn't silently teach me to default to `type: llm`.

5. As workspace-chat, I want the `workspace-api` skill to make `type: atlas` first-class — appearing in the cheat sheet, the recipe, and the gotchas — so that I treat bundled agents as the default and not the exception.

6. As workspace-chat, I want a punchy decision rule for picking an agent type, so that I don't drift to `type: llm` by inertia when a bundled agent or Python agent fits better.

### Authoring (the user's perspective)

7. As a Friday user, I want the chat to use the bundled `web` agent when I ask it to scrape a webpage, so that I'm not stuck wiring up a browser MCP for what's a one-line config.

8. As a Friday user, I want the chat to use the bundled `email` agent when I ask it to send an email, the bundled `slack` agent for Slack messages, the bundled `gh` agent for GitHub ops, and so on, so that the chat takes advantage of the platform without me having to name each one.

9. As a Friday user, I want a workspace built today to look the same way an experienced Friday author would build it — leveraging bundled agents wherever they fit — so that my workspace is reliable and idiomatic.

### Operational

10. As a Friday developer, I want the bundled-agent inventory to live in one place (`bundledAgentsRegistry`) and be discoverable at runtime, so that adding a new bundled agent doesn't require updating skills or documentation by hand.

11. As a Friday developer, I want `list_mcp_servers` removed (not shimmed) so that there's a single discovery tool and no behavioral split between two surfaces with overlapping intent.

## Implementation Decisions

### High-level shape

- **New tool: `list_capabilities`** on workspace-chat. Replaces `list_mcp_servers` outright. No compatibility shim.
- **`get_workspace_mcp_status` is renamed to `get_mcp_dependencies`** and its scope tightens to the dependency graph: for each enabled MCP server, return `{ id, name, source, configured, agentIds, jobIds, available }`. The `configured` field is now redundant with `list_capabilities.requiresConfig` but stays for defense-in-depth (in case the LLM reaches for the dependency tool without having called discovery). The `available` list also stays for the same reason. The tool's primary job is answering "before disabling/removing this server, what depends on it?"
- **`search_mcp_servers` is kept.** Catalog search with a query is a different intent from "show me everything."
- **`list_mcp_tools` is kept.** That's a drill-down from a single MCP server to its tool names, not a peer to discovery.
- **`upsert_agent` runtime: unchanged.** The server endpoint already validates against the full discriminated union. No schema changes needed at the daemon.
- **`upsert_agent` tool description: rewritten** to enumerate the three authorable type shapes (`llm | atlas | user`) in the description string. `type: system` is server-internal and is not described to the LLM. The input JSON schema stays freeform (`additionalProperties: true`); the description string carries the guidance. (Option B from the brainstorm — deriving the JSON schema from `WorkspaceAgentConfigSchema` — was considered and rejected for v1; see *Out of Scope*.)
- **`workspace-api/SKILL.md`** rewritten to put `type: atlas` first, with the `list_capabilities` tool as the recipe's literal step 1.
- **No changes to `using-mcp-servers` skill** beyond a one-line update reflecting the renamed tool.

### Module Boundaries

**`list_capabilities` tool**

- **Interface:** `list_capabilities({ workspaceId? })`. Optional `workspaceId` defaults to the current session's workspace. Returns a flat array of tagged-union entries:
  ```ts
  type Capability =
    | { kind: "bundled"; id: string; description: string; examples: string[]; constraints?: string; requiresConfig: string[] }
    | { kind: "mcp_enabled"; id: string; description: string; requiresConfig: string[] }
    | { kind: "mcp_available"; id: string; description: string; provider: string; requiresConfig: string[] };
  ```
  All three variants carry `requiresConfig: string[]` — env keys / credentials missing for the capability to function. `constraints?` only appears on `bundled` because bundled agents are black-box implementations with meaningful operational caveats; MCP servers expose their tool surface directly via `list_mcp_tools`. `examples` only appears on `bundled` for the same reason.
- **Hides:** The aggregation across three sources (`bundledAgentsRegistry`, the workspace's `tools.mcp.servers` block, and the platform MCP catalog), the bundled-first ordering rule, the per-source field projection (e.g., bundled `examples` from `metadata.expertise.examples`, MCP `tools` from a registry probe when available).
- **Trust contract:** A single call returns the complete capability surface. Bundled entries always appear before MCP entries. Within each kind, ordering is stable (alphabetical by `id`) so the LLM can't be confused by reordering across calls. Idempotent and side-effect-free. If the workspace doesn't exist, the tool returns 404 with a structured error rather than empty results.

**`upsert_agent` (description-only change)**

- **Interface:** unchanged. `{ id: string, config: object, workspaceId?: string }`.
- **Hides:** Server-side discriminated-union validation against `WorkspaceAgentConfigSchema`, draft-vs-direct routing, diff computation.
- **Trust contract (updated):** The tool's description now states explicitly that `config.type` must be one of `"llm" | "atlas" | "user" | "system"`, with a one-line shape example for each. The LLM can no longer claim it didn't know `type: atlas` was a valid shape — the tool's own self-description tells it.

**`workspace-api` skill (rewritten sections)**

- **Interface:** Markdown auto-loaded by workspace-chat when the user is creating, editing, or deleting workspaces.
- **Hides:** The mental model of when each agent type fits, the recipe ordering with `list_capabilities` at step 1, the prerequisite chain (capabilities → credentials → upserts → validate → publish).
- **Trust contract:** Following the skill produces working workspaces in few-shot, with `type: atlas` chosen wherever a bundled agent fits and `type: user` chosen for mechanical work, falling back to `type: llm` only when neither applies. The skill's bundled-agent inventory is *not* static — it points at `list_capabilities` and instructs the LLM to call it. New bundled agents become available without skill edits.

### Output ordering rule for `list_capabilities`

Concrete rule, codified in the tool implementation:

1. **Group by kind** in this order: `bundled` → `mcp_enabled` → `mcp_available`.
2. **Within `bundled`**: alphabetical by `id`.
3. **Within `mcp_enabled`**: alphabetical by `id`.
4. **Within `mcp_available`**: alphabetical by `id`.

The skill teaches the LLM: "scan top-down and pick the first match." This makes the bundled-first preference structural rather than advisory.

A simpler "interleave by relevance score" ordering was considered and rejected: relevance scoring requires either an LLM call or a hand-tuned heuristic, both of which fail open in non-obvious ways. Stable bundled-first ordering is dumb, predictable, and LLM-friendly.

### `upsert_agent` description rewrite

Replace the current description string with:

> Upsert an agent into the current workspace's draft (or live config if no draft). The `config` field's shape depends on `config.type`:
>
> - **`type: "llm"`** — inline LLM agent. Shape: `{ type, description, config: { provider, model, prompt, tools? } }`. Use when the work is open-ended ("figure out what to do") and no bundled agent fits.
> - **`type: "atlas"`** — bundled platform agent (web, email, slack, gh, etc.). Shape: `{ type, agent, description, prompt, config?, env? }`. Discover available `agent` ids by calling `list_capabilities` first. The `prompt` is task-specific context layered on the agent's bundled behavior — describe the user's intent, not the mechanics. Use when a bundled agent fits the task domain — this should be your default for web scraping, email sending, Slack messaging, GitHub ops, image generation, data analysis, and similar.
> - **`type: "user"`** — registered Python/TS SDK code agent. Shape: `{ type, agent, prompt?, env? }`. Use when the work is mechanical (parsing, transforming, deterministic routing) or when LLM-loop cost dominates the value. See `writing-friday-agents` skill.
>
> Pass `workspaceId` to target a workspace other than the current session.

(`type: "system"` is reserved for platform-internal agents and is not authorable from workspace-chat. The server-side schema accepts it, but it is never advertised in the tool description or in `list_capabilities`.)

The description doubles in length (~10 lines vs ~3). Token cost is paid once per session per tool registration — not per call — and is dwarfed by the cost saved when the LLM stops bolting playwright onto `type: llm` agents.

### Skill rewrite checklist

In `packages/system/skills/workspace-api/SKILL.md`:

1. **Cheat sheet (top):** Replace the existing tool-selection bullet with a three-row agent-type table:
   ```
   | Type | When | Example |
   |---|---|---|
   | atlas | Bundled platform agent fits the task | type: atlas, agent: "web" |
   | user | Mechanical/deterministic work | type: user, agent: "csv-parser" |
   | llm | Open-ended reasoning, no bundled fit | type: llm, config: { prompt, tools } |
   ```
   With a one-line rule below: **Check `atlas` first via `list_capabilities`. Then `user`. `llm` is the fallback, not the default.** And a nuance line: **Bundled when the work is open-ended within a domain (you want a sub-agent that reasons). MCP server when the work is deterministic / single-call (you want a tool).**

2. **Recipe step 1:** Rename from "Identify required MCP servers" to **"List available capabilities."** Body: "Call `list_capabilities` once at the start of any new workspace work. The list returns bundled agents first (alphabetical), then enabled MCP servers, then available MCP servers in the catalog. Scan top-down and pick the first match for each piece of work the workspace needs. The result is stable for the session — re-call only after `enable_mcp_server` (which adds an entry to the enabled set). Bundled agents and the catalog do not change during a session."

3. **Recipe step 2:** Subsume the old "Enable MCP servers" step into a "Wire capabilities" step that branches on `kind`: bundled → goes directly into `upsert_agent`; mcp_enabled → already wired, just reference; mcp_available → call `enable_mcp_server` first.

4. **Decision matrix (the existing table near the bottom):** Hoist a condensed version up next to the cheat sheet's type table. Keep the worked examples below.

5. **Top gotchas:** Add two new gotchas:
   - **"Don't reach for an MCP server when a bundled agent exists for the same domain *and* the work is open-ended. Common over-MCP traps: playwright-mcp instead of `type: atlas, agent: "web"`; smtp-mcp instead of `type: atlas, agent: "email"`; slack-mcp instead of `type: atlas, agent: "slack"`. The flip side: when the work is a deterministic single call, MCP-as-tool is the right pick — don't over-bundle."**
   - **"For `type: atlas`, the `prompt` field is task-specific context layered on the agent's bundled behavior. Describe the user's intent, not the mechanics. The bundled agent already knows how to drive a browser / send email / call the GitHub API."** Inline a 5-7 line YAML example using the `web` agent.

6. **Aliases gotcha:** **"`browser` and `research` are server-side aliases for the unified `web` agent. They are not advertised in `list_capabilities` and you should not write them in new workspaces. If you encounter `agent: "browser"` or `agent: "research"` in an existing workspace, leave it alone — the server still accepts it."**

7. **Examples:** Update `assets/example-jobs-pipeline.yml` to use the same `web` bundled-agent example as the SKILL inline gotcha, so the LLM sees the canonical pattern reinforced across SKILL.md, the asset, and the references doc.

8. **Cross-link:** A short reference doc, `packages/system/skills/workspace-api/references/agent-types.md`, expanding on the **three** authorable types (`llm`, `atlas`, `user`) with a worked example each. Linked from the SKILL.md "Go deeper" section. Pointers to in-tree real examples (e.g., `pr-review-github/workspace.yml`, `system.yml`) for fuller patterns.

The skill grows by ~50 lines net. The bundled-agent inventory itself is *not* duplicated into the skill — `list_capabilities` is the source of truth.

### Tool count after this change

Before: 17 tools (8 existing + 9 from the workspace-creation redesign).

After: 17 tools. `list_mcp_servers` removed, `list_capabilities` added. `get_workspace_mcp_status` renamed in place to `get_mcp_dependencies` (scope tightened, name reflects new role). No drill-down tool added for bundled agents — they universally take `string` as input, so there's nothing structured to drill into.

### Phasing

**Single PR.** Skill rewrite, `list_capabilities` implementation, and `upsert_agent` description fix ship together. The skill references the new tool by name; the new tool depends on no skill changes; the description fix is purely additive. Splitting them creates a broken intermediate state where the skill says "call `list_capabilities`" but the tool doesn't exist, or where the tool exists but the skill still says "call `list_mcp_servers`."

The MCP plan's `using-mcp-servers` skill needs a one-line edit (rename `list_mcp_servers` → `list_capabilities` in any reference) and ships in the same PR.

### Data Isolation

Not applicable. `list_capabilities` reads from the bundled-agents in-process registry and the workspace's filesystem-backed config. No user-scoped database tables involved.

## Testing Decisions

What makes a good test here: the test names what the LLM should *do* in response to a prompt, not what bytes the tool returns. The validator already covers structural correctness; these tests cover behavior.

**`list_capabilities` unit tests.**
- Returns at least one entry of each `kind` when both bundled and MCP capabilities are present.
- Bundled entries always come before MCP entries in the output array.
- Within a kind, entries are alphabetical by `id` (stable ordering).
- Bundled entry count equals the number of *non-alias* entries in `bundledAgentsRegistry` — aliases (`browser`, `research`) are not advertised in discovery.
- A workspace with zero MCP servers returns only bundled entries (no empty `mcp_*` placeholders).
- An invalid `workspaceId` returns 404 with a structured error.
- `description`, `examples`, and `constraints` fields on bundled entries match the values from each agent's `metadata`.
- All three variants carry `requiresConfig: string[]` (always present, even if empty array).

**`upsert_agent` server-side acceptance tests.**
- `type: "atlas"` with valid `agent: "web"` is accepted and persisted.
- `type: "user"` with a valid registered agent id is accepted.
- `type: "atlas"` with an `agent` id that's not in `bundledAgentsRegistry` returns a structural issue with code `unknown_bundled_agent` and the path `agent`.
- `type: "atlas"` with `agent: "browser"` (legacy alias) is still accepted server-side — back-compat sentinel, even though aliases are not advertised in `list_capabilities`.
- `type: "system"` continues to be accepted server-side (the schema still includes it; it just isn't advertised in chat-facing surfaces).

**Description rewrite verification (mechanical).**
- Snapshot test on the registered tool's description string asserting it mentions the three authorable type literals (`llm`, `atlas`, `user`). Asserting it does **not** mention `system` (system is not authorable from chat). Catches regressions where someone trims the description back to the `llm` shape, or accidentally re-adds the `system` row.

**Chat anti-regression tests.**
- "I want a workspace that scrapes the top headlines from Hacker News every morning" → produces an `upsert_agent` call with `type: "atlas"` and `agent: "web"`. Does **not** produce any `enable_mcp_server` call for playwright/puppeteer/browser MCPs.
- "I want a workspace that sends me a daily email summary" → produces `type: "atlas"` with `agent: "email"`. Does **not** wire smtp-mcp.
- "I want a workspace that posts a daily standup to Slack" → produces `type: "atlas"` with `agent: "slack"`.
- The minimum smoke test: "build a workspace that fetches a URL daily and emails me the result" — assert `upsert_agent` is called with at least one `type: "atlas"` config in the resulting tool sequence.

**Skill content checks (mechanical).**
- Grep test: SKILL.md no longer contains the substring "two agent types".
- Grep test: SKILL.md contains the substring "type: atlas" at least three times (cheat sheet, recipe, gotchas).
- Grep test: SKILL.md contains "list_capabilities" and does not contain "list_mcp_servers".

**Integration test against a real daemon.**
- Reproduce the transcript that motivated this design: ask workspace-chat to "build a workspace that scrapes a webpage and emails me the result." Confirm the resulting `workspace.yml` contains `type: atlas` agents and zero MCP servers for browser/email transport.

## Out of Scope

- **`list_user_agents` / discovering pre-registered Python agents.** The chat's expected pattern for user agents is "author purpose-specific → register → upsert," not "pull one off the shelf." Workspace-scoped user agents is a separate design problem; defer until that ships.
- **Validator nudges for redundant configurations** (e.g., warning when `type: llm` + playwright-mcp is configured and suggesting `type: atlas, agent: "web"`). The discriminated discovery + skill guidance is hypothesized to be enough. If post-ship transcripts still show LLM drift after this lands, validator nudges become the next iteration.
- **Auto-rewriting existing workspaces** that use `type: llm` + browser MCPs to use `type: atlas, agent: "web"`. Existing workspaces work; rewriting them is risky and provides no LLM-feedback-loop value (the LLM that built them isn't the one editing them).
- **Deriving `upsert_agent`'s input JSON schema from `WorkspaceAgentConfigSchema`** (option B from the brainstorm). Per-call token cost on a four-way `oneOf` is in the 1-2K range; the description-string approach achieves the same guidance for the agent-shape case (which is flat and small) at one-time cost. `upsert_job` keeps the typed-schema approach because FSM shapes have meaningful structure to enforce.
- **Ranked / relevance-scored capability ordering.** Considered for `list_capabilities`; rejected as fragile (heuristic-tuning rabbit hole). Bundled-first stable alphabetical is the v1 rule.
- **Tooling for adding new bundled agents.** Out of scope; bundled-agent authoring is a Friday-developer concern, not a workspace-chat concern.
- **Renaming `type: atlas` to something more discoverable** (e.g., `type: bundled`). Considered. The `atlas` literal is already used in workspace configs in the wild; renaming requires migration. Defer until there's evidence the literal name is itself a stumbling block.
- **Surfacing platform-level chat tools** (memory, file I/O, web fetch as built-in to workspace-chat) inside `list_capabilities`. Those tools don't get wired into workspace-agent configs — they're conversation-only. Including them confuses the discovery model.

## Further Notes

### Why this is small but high-leverage

The transcript that motivated this work shows a clear cause-and-effect chain: the LLM didn't know `type: atlas` existed → therefore couldn't pick it → therefore reached for MCP. Three small changes (one new tool, one description rewrite, one skill rewrite) close the loop. No new architecture, no new validation layers, no new endpoints. The validator-warning approach (rejected for v1) would have been more architecturally pure but harder to ship cleanly; discovery + skill is the cheaper path with the same expected outcome.

### Why bundled-first is the right ordering

The alternative — interleave bundled and MCP options sorted by some relevance score — was considered. Two problems: relevance requires either an LLM call (latency, cost, instability) or a hand-tuned heuristic (drift, false positives, maintenance burden). Stable bundled-first alphabetical is dumb, predictable, and matches the actual preference order: bundled is zero-config and platform-managed, so it should always be the first choice when the domain matches. If the domain doesn't match, the LLM scans past it in a few tokens and lands on the right MCP option.

### Why the skill carries the type guidance, not the tool

The tool's description does the minimum viable job — enumerate the four shapes so the LLM can produce valid configs. The skill carries the *judgment*: when to pick which type, with worked examples. Splitting it this way matches the existing pattern (validator catches malformed configs; skill catches wrong-but-valid configs) and keeps the per-call token cost on the tool's description low. The skill is loaded once per session.

### Relationship to the workspace-creation redesign

This is a follow-on to `2026-04-27-workspace-creation-redesign-design.md`, not a rework. That design fixed the *iteration loop* (validator-as-compiler, draft mode, schema-tight mutation tools). This design fixes the *building-block surface* (which agent types the LLM knows about). Both are required for "workspace-chat reliably builds working workspaces in few shots."

### Why not a separate bundled-agents skill

Considered. Decided against because (a) the workspace-chat author is already the right consumer of `workspace-api`, and that's exactly when bundled-agent guidance is needed; (b) a separate skill competes for trigger budget and creates a "which skill do I load?" decision; (c) the bundled-agent inventory is small enough to live as a reference doc inside `workspace-api`. Same trade-off the workspace-creation redesign made for `building-friday-jobs` (folded into `workspace-api/references/job-authoring.md` instead of a standalone skill).

### Risk: the description rewrite isn't enough

If post-ship transcripts show the LLM still defaulting to `type: llm` despite the new description and skill guidance, the next intervention is the validator-warning approach (option C from the brainstorm). That has higher implementation cost and a small false-positive risk, but it's the natural escalation. The single biggest signal to watch: does the chat ever produce `type: llm` with a browser MCP enabled when `web` is in the bundled list? If yes more than a couple of times across real sessions, escalate.

### Why not fold `get_mcp_dependencies` into `list_capabilities`

`get_mcp_dependencies` (renamed from `get_workspace_mcp_status`) answers a different question — "for each enabled MCP server, which agents and jobs reference it?" That's introspection on the *dependency graph*, used before disabling/removing a server. `list_capabilities` answers "what could I use, and is it credentialed?" Folding the dependency graph into discovery would bloat every list call with `usedByAgents` / `usedByJobs` arrays the LLM almost never reads during browse. The "what depends on this" question only fires after the LLM has picked a specific server to act on. Two tools, two intents, clear separation.
