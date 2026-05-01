---
name: writing-friday-agents
description: "Dispatcher for authoring Friday user agents (`type: \"user\"`). Use when authoring or debugging an existing user agent and you need the language-specific guide. For Python (the only currently-supported language), load `@friday/writing-friday-python-agents` instead — that skill is the source of truth, vendored from the friday-agent-sdk repo. This dispatcher exists to keep cross-references stable while we add other-language SDKs."
user-invocable: false
---

# Writing Friday user agents

User agents (`type: "user"` in `workspace.yml`) are language-native code
agents the daemon spawns as subprocesses. Each language has its own SDK
and its own authoring skill.

## Pick the language-specific skill

| Language | SDK | Skill to load |
|---|---|---|
| Python | `friday-agent-sdk` (PyPI) | **`@friday/writing-friday-python-agents`** |
| TypeScript | _planned_ | _not yet available_ |

If you're authoring or debugging a Python user agent (the common case),
load `@friday/writing-friday-python-agents` for the full surface — `@agent`
decorator fields, `AgentContext` capabilities, NATS subprocess model,
input parsing, structured output, MCP tool calls, etc.

## When to load this dispatcher (vs the language-specific skill)

- **Loading a language-specific skill directly is fine.** If the context
  is unambiguously Python (an `agent.py` already exists, or
  `friday_agent_sdk` imports are visible, or `upsert_agent` was just
  called with `type: "user"`), go straight to
  `@friday/writing-friday-python-agents`.
- **Loading this dispatcher is for the cross-language seam.** Old
  references (in `prompt.txt`, `workspace-api`, `friday-cli`) point here
  by name — this skill exists so those keep working as we add SDKs in
  other languages.

## Not for type-selection

This skill does NOT decide *whether* to author a user agent. That
decision lives in workspace-chat's `<agent_types>` rules: pick
`type: "user"` only when each call's decision is mechanical
(regex/schema/routing table), never for LLM-judgment work. If the agent
body would call `ctx.llm.generate` to decide anything, it's `type: "llm"`,
not `type: "user"`. See the workspace-chat prompt + `upsert_agent` tool
description.
