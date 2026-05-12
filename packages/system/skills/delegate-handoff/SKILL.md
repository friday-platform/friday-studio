---
name: delegate-handoff
description: |
  Loads when the agent calls `delegate({...})` for a non-trivial sub-task.
  Covers what the child sees and doesn't see (the child has NO `load_skill`
  and NO `<available_skills>` — the parent must pre-push skills via
  `delegate({skills: [{name, refs?}]})`); how to write a good `handoff`;
  when to push specific reference files via `refs:`; the `mcpServers:`
  allowlist; budget envelope (`max_steps`, `max_output_tokens`,
  `max_depth`); the `{ok, answer | reason, toolsUsed}` return contract;
  when to delegate vs call a tool inline.
---

# Delegate handoff contract

`delegate({goal, handoff, mcpServers?, skills?})` spawns a sub-agent
in-process. The child runs its own `streamText` loop and returns a
compact `{ok, answer | reason, toolsUsed}` envelope. This skill is the
contract for how to use it well — the chat trajectory that motivated
the system-skills remodel called `delegate` 5+ times without ever
pushing skills, and the child ran context-blind every time.

## What the child sees

| Surface | Inherited from parent? |
|---|---|
| Parent's tool set (minus `delegate` to prevent infinite nesting) | YES |
| `mcpServers:` allowlist (if you pass it) | only the listed servers |
| `<available_skills>` index | NO — child has no skill catalog |
| `load_skill` tool | NO — child cannot fetch additional skills |
| Skills pushed via `delegate({skills: [...]})` | YES — injected as `<skills>` system-prompt block |
| Workspace context (other agents, MCP servers, signals) | NO unless encoded in `handoff` |
| Chat history | NO — child sees only the system prompt + handoff |
| Datetime grounding | YES (auto-injected) |

**Critical:** the child can only use what you push. There's no
discovery mechanism inside the child.

## Always pass `skills` for non-trivial sub-tasks

If the sub-task involves a domain skill the parent has visible —
GitHub queries, Gmail composing, workspace API patterns — push the
skill. The child runs blind otherwise.

```ts
delegate({
  goal: "Find stale issues + PRs in the friday-platform org",
  handoff: "Today is 2026-05-12. Cutoff: 2026-05-10 (today - 2 days). " +
           "Run searches across friday-studio, friday-studio-examples, agent-sdk. " +
           "Return JSON of {repo, number, title, author, created}.",
  mcpServers: ["github"],
  skills: [
    { name: "@friday/using-mcp-servers" },
    // surgical: only the references you need, not the full body
    { name: "@friday/composing-emails", refs: ["references/tone.md"] },
  ],
})
```

Skill resolution: only skills the parent has visible can be pushed.
Out-of-scope skills are dropped + logged. The runtime resolves the
skill body at the parent boundary and injects it into the child's
system prompt as a `<skills>` block.

## `refs:` for surgical injection

If a skill has reference files (e.g.
`references/phrases.md`, `references/anti-patterns.md`), you can
push only specific files instead of the whole SKILL.md body. The
child sees one `<file path="...">` block per requested ref.

Use this when:
- The full skill body is large and you need only a subset.
- The child's system prompt budget is tight.
- A specific reference file directly answers the sub-task.

## `mcpServers:` — explicit allowlist

If you pass `mcpServers`, the child can only use tools from those
servers. If you don't pass it, the child gets the parent's full MCP
tool surface. Pass it when the sub-task is scoped (e.g.
"GitHub-only research") to prevent the child from wandering into
unrelated tools.

## Budget envelope

The defaults (in `packages/core/src/delegate/index.ts`):

- `max_steps_per_call: 40` — generous; rarely the limit.
- `max_output_tokens: 20_000` — high so the child can produce
  detailed answers.
- `max_depth: 1` — child cannot delegate further by default.

Workspaces can override via `delegation:` block in workspace.yml or
per-job in `jobs.<name>.delegation:`. Job-level wins per field over
workspace-level.

## Writing a good `handoff`

The child has no chat history. The handoff is the only context. Good
handoffs:

- **State the goal in one sentence.** "Find stale issues..." not
  "Help me understand what's stale."
- **Encode the time anchor.** "Today is 2026-05-12. Cutoff:
  2026-05-10." Without this the child guesses.
- **Specify the output shape.** "Return JSON of {repo, number,
  ...}." Without this the child invents a format.
- **Surface workspace context.** "The repos are friday-studio,
  friday-studio-examples, agent-sdk in the friday-platform org."
  The child doesn't know your workspace.
- **Don't restate prompt-injection guards.** The child inherits
  those from the platform prompt scaffolding.

Bad handoffs (what the chat trajectory did):

```
goal: "Find the right org for these repos"
handoff: "The user is ken@tempest.team. Try each org."
```

Result: the child spends 12 tool calls brute-forcing
`get_teams` + `search_repositories` × 3. With workspace introspection
in the handoff or as a skill, it would have done one call.

## Return contract

The child returns one of:

```ts
{ ok: true, answer: string, toolsUsed: [{name, outcome}, ...] }
{ ok: false, reason: string, toolsUsed: [{name, outcome}, ...] }
```

`answer` for success; `reason` for failure (impossible task, missing
auth, unrecoverable error). Both shapes carry a tools manifest for
observability.

## When to delegate vs call inline

Delegate when:
- The sub-task needs many tool calls (5+).
- The output is bulky (long enough to bloat the parent's context).
- The work is independent and bounded (the child won't need to
  ask the user follow-up questions).

Call inline when:
- The task is one or two tool calls (`get_me`, `list_jobs`).
- The output is small.
- The work depends on subsequent parent decisions.

Bad delegate cases:
- "Look up the workspace's GitHub org" — that's
  `describe_workspace(id).integrations.github.org`, one call.
- "Format this markdown" — pure transformation, no tools needed.

## Cross-references

- [[contracts/agent-action-handshake]] — sibling contract for the
  FSM action ↔ agent boundary.
- [[author/using-mcp-servers]] — MCP-tool allowlist semantics for
  the `mcpServers:` arg.
- [[debugging-broken-jobs]] — what to load when a delegate
  sub-task returns garbage.
