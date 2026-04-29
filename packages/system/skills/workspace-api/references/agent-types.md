# Agent types — worked examples

Three authorable agent types: `atlas`, `user`, `llm`. Pick in that order.
`atlas` is zero-config and platform-managed; `user` is for mechanical work
that doesn't pay the LLM-loop tax; `llm` is the fallback when no bundled
agent fits and the work is open-ended.

A fourth type — `system` — exists in the schema but is server-internal
(used by the platform's own workspaces). Not authorable from chat. Don't
write it in user workspaces.

## `atlas` — bundled platform agent

**Use when:** a bundled agent already covers the domain (web, email,
slack, gh, image generation, data-analyst, etc.). Always check first via
`list_capabilities` — the response lists every bundled agent under
`kind: "bundled"` along with the `id` you put in `agent:`.

**Shape.**

```yaml
agents:
  news-scout:
    type: atlas
    agent: web                    # one of the ids returned by list_capabilities
    description: >-
      Pulls top headlines from Hacker News and saves them to memory.
    prompt: |
      Pull the top 5 headlines from news.ycombinator.com.
      For each: title, URL, points, comment count.
      Save to memory under "daily-headlines".
    env:
      PARALLEL_API_KEY: from_environment   # optional — enables search
```

**Wiring it into a job.**

```yaml
jobs:
  scrape-headlines:
    title: "Daily Hacker News headlines"
    description: "Fetches and saves the top 5 HN stories."
    triggers: [{ signal: daily-tick }]
    fsm:
      id: scrape-headlines
      initial: idle
      states:
        idle:
          'on':
            daily-tick: { target: scrape }
        scrape:
          entry:
            - type: agent
              agentId: news-scout
              outputTo: scrape-result
              prompt: "Run the daily headline scrape."
            - type: emit
              event: DONE
          'on':
            DONE: { target: done }
        done: { type: final }
    config: { timeout: "5m", max_steps: 20 }
```

**Key rules.**

- The `prompt` field is task-specific intent layered on the agent's
  bundled behavior. The `web` agent already knows how to drive a
  browser, run a search, and fetch URLs — don't re-teach it those
  mechanics. Describe what you want, not how.
- `agent` ids are stable; `browser` and `research` are server-side
  aliases for `web` and not advertised in `list_capabilities`. Don't
  write the aliases in new workspaces; if you find them in an existing
  workspace, leave them alone.
- `env` is optional. Bundled agents declare their own env requirements
  in `requiresConfig` (returned by `list_capabilities`). If a key is
  globally set in the daemon's environment, you don't need to repeat
  it here.

**See also.** `assets/example-jobs-pipeline.yml` for the canonical
`type: atlas, agent: web` shape inside a full pipeline.

## `user` — registered Python or TS SDK code agent

**Use when:** the work is mechanical or deterministic — parsing PDFs,
filtering CSVs, mutating SQLite, calling a fixed HTTP endpoint with a
known payload. Reach for `user` when the LLM-loop tax dominates the
value of running an LLM, or when the task needs libraries the LLM
can't reach (Pandas, PIL, custom compiled code).

The agent itself is built out-of-band with the `atlas agent build`
toolchain — see the `writing-friday-agents` skill. The workspace
config only references the registered `agent` id.

**Shape.**

```yaml
agents:
  csv-parser:
    type: user
    agent: csv-parser              # id from `atlas agent build` output
    description: >-
      Pure-Python parser. Reads an uploaded CSV, validates schema,
      writes rows to SQLite. No LLM call.
    prompt: |
      Workspace context: rows must have columns id, ts, payload.
      Reject rows where payload is empty.
    env:
      DATABASE_URL: from_environment
```

**Wiring it into a job.**

```yaml
jobs:
  ingest-csv:
    title: "Ingest CSV upload"
    description: "Parses and stores an uploaded CSV."
    triggers: [{ signal: csv-uploaded }]
    fsm:
      id: ingest-csv
      initial: idle
      states:
        idle:
          'on':
            csv-uploaded: { target: parse }
        parse:
          entry:
            - type: agent
              agentId: csv-parser
              outputTo: parse-result
              prompt: "Parse the uploaded file."
            - type: emit
              event: DONE
          'on':
            DONE: { target: done }
        done: { type: final }
    config: { timeout: "2m", max_steps: 1 }
```

**Key rules.**

- `prompt` is optional for `user` agents; the agent's behavior is
  hard-coded in its source. Use `prompt` only to inject workspace-level
  context the agent reads off its config.
- `env` works the same as `atlas`: workspace-level overrides plus
  whatever the daemon process exposes.
- Authoring a new `user` agent is an out-of-flow step the user kicks
  off explicitly. If chat reaches for `type: user` and no matching
  agent id is registered, validation fails with `unknown_user_agent`.
  Confirm registration before writing the config.

**See also.** `packages/system/workspaces/system.yml` has many
`type: user` agents wired into the autopilot FSM (`status-watcher`,
`planner`, `dispatcher`, `reflector`).

## `llm` — inline LLM agent with prompt + tools

**Use when:** the logic is "figure out what to do" *and* no bundled
agent covers the domain. If a bundled agent fits, prefer `atlas`
even when the work is reasoning-heavy — the bundled agent already
ships the right tool set and prompt scaffolding.

**Shape.**

```yaml
agents:
  email-triage:
    type: llm
    description: "Classifies an inbound email as urgent / tracking / ignore."
    config:
      provider: anthropic
      model: claude-sonnet-4-6
      prompt: |
        You triage inbound email.
        Classify each message as one of: urgent, tracking, ignore.
        Return JSON: { category, reason }.
      tools: [read_query, write_query]   # MCP tool names from list_mcp_tools
      max_steps: 6
```

**Wiring it into a job.**

```yaml
jobs:
  triage-inbound:
    title: "Triage inbound email"
    description: "Classifies a freshly received email."
    triggers: [{ signal: email-received }]
    fsm:
      id: triage-inbound
      initial: idle
      states:
        idle:
          'on':
            email-received: { target: classify }
        classify:
          entry:
            - type: agent
              agentId: email-triage
              outputTo: triage-result
              outputType: triage-classification
              prompt: "Classify this message."
            - type: emit
              event: DONE
          'on':
            DONE: { target: done }
        done: { type: final }
    config: { timeout: "1m", max_steps: 6 }
```

**Key rules.**

- Tool names in `config.tools` resolve against `tools.mcp.servers.*`.
  Call `list_mcp_tools({ serverId })` to get the exact names; guessing
  produces `unknown_tool` validation errors.
- `provider` + `model` are required and not inferred. The bundled
  agents pick their own model; inline `llm` agents are explicit.
- `temperature` defaults to 0.3. Override only when you have a reason.

**See also.** `assets/example-jobs-pipeline.yml`'s `bookmark-writer` /
`bookmark-searcher` agents — both `type: llm` with SQLite MCP tools.

## Hybrid: `llm` delegating to `user`

A common shape: an `llm` agent does the open-ended part (design,
reasoning) and hands off a deterministic step to a `user` agent.
Example: a map-builder that calls an `llm` agent for layout decisions
and a `user` (Python + PIL) agent for tile rendering. Wire both as
top-level agents; sequence them in the job's FSM with separate
`type: agent` actions.

This is the right pattern when you'd otherwise be tempted to bolt a
`user` agent's job onto an `llm` agent's `tools` array — keep them
separate so each can be reasoned about, tested, and retried in
isolation.
