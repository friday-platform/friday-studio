# `friday.yml` — platform superset

Read this when configuring LLM provider selection per call site, exposing
the platform as an MCP server, or setting tool-level security policy.

`friday.yml` loads once at daemon startup from the workspace parent
directory. Optional — defaults work with just `ANTHROPIC_API_KEY` set. It's
a superset of `workspace.yml` with three platform-only blocks: `models`,
extended `server.mcp`, and extended `tools.mcp.tool_policy`.

Invalid config — unknown provider, malformed model id, missing credential —
fails daemon startup with every error reported at once, so you don't have
to restart four times to fix four typos.

## Contents

- `models` — per-archetype LLM selection
- Credential resolution
- Default chains
- Extended `server.mcp` (transport / auth / rate_limits)
- Extended `tools.mcp.tool_policy` (allowlist / denylist)

## `models` — per-archetype LLM selection

Friday makes LLM calls from four distinct call sites. Each can be pinned
independently. Id format: `provider:model`. Known providers: `anthropic`,
`openai`, `google`, `groq`, `claude-code`.

```yaml
models:
  labels: "groq:openai/gpt-oss-120b"            # short plain-text (session titles, quick summaries)
  classifier: "anthropic:claude-haiku-4-5"      # structured-output routing decisions
  planner: "anthropic:claude-sonnet-4-6"        # multi-step synthesis (workspace planner, plan DAG)
  conversational: "anthropic:claude-sonnet-4-6" # streaming chat with tools (workspace chat)
```

### Archetype guidance

- **`labels`** — short plain-text, latency matters, quality ceiling is low.
  Session titles, snap summaries, anything on a user-blocking path under
  ~100 output tokens. Default: `groq:openai/gpt-oss-120b` → falls back to
  `anthropic:claude-haiku-4-5` if no Groq key.
- **`classifier`** — `generateObject` over small enums / discriminated
  unions. Schema-compliance matters most. Default:
  `anthropic:claude-haiku-4-5`.
- **`planner`** — long-context synthesis with structured output. Not
  latency-sensitive but a weak planner produces broken downstream
  pipelines. Default: `anthropic:claude-sonnet-4-6`.
- **`conversational`** — streaming chat with 5-20 tools + multi-turn
  history. Tool-calling reliability is the gating factor. Default:
  `anthropic:claude-sonnet-4-6`.

### Common override shapes

Cheap labels, frontier planner, everything else default:

```yaml
models:
  labels: "groq:openai/gpt-oss-120b"
  classifier: "openai:gpt-4o-mini"
```

Claude Code CLI for chat (no API key; the CLI handles auth itself):

```yaml
models:
  conversational: "claude-code:claude-sonnet-4-6"
```

LiteLLM proxy for everything (see credential resolution below):

```yaml
models:
  labels: "anthropic:claude-haiku-4-5"
  classifier: "anthropic:claude-haiku-4-5"
  planner: "anthropic:claude-sonnet-4-6"
  conversational: "anthropic:claude-sonnet-4-6"
```

## Credential resolution

Each provider reads its usual env var:

| Provider | Env var |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` | `OPENAI_API_KEY` |
| `google` | `GEMINI_API_KEY` |
| `groq` | `GROQ_API_KEY` |
| `claude-code` | (none — the CLI handles its own auth) |

**Universal override:** setting `LITELLM_API_KEY` satisfies the credential
check for every provider. Put a LiteLLM proxy in front of Friday and you
can route every archetype through one key.

Startup fails fast if any archetype references a model whose provider
credential is missing.

## Default chains (what happens when `models` is absent)

- `labels` → try `groq:openai/gpt-oss-120b`; fall back to
  `anthropic:claude-haiku-4-5` if no Groq key.
- `classifier` → `anthropic:claude-haiku-4-5`.
- `planner` → `anthropic:claude-sonnet-4-6`.
- `conversational` → `anthropic:claude-sonnet-4-6`.

So with just `ANTHROPIC_API_KEY` set, the whole platform runs. Add
`GROQ_API_KEY` and labels-path latency improves automatically.

## Extended `server.mcp` (friday.yml only)

The basic `server.mcp` (enabled + discoverable capabilities/jobs) is
allowed in `workspace.yml`. These extensions are platform-only:

```yaml
server:
  mcp:
    enabled: false
    discoverable:
      capabilities: ["workspace_*"]
      jobs: ["review-*"]
    transport:
      # Same shape as tools.mcp.servers.*.transport — stdio, SSE, HTTP
      type: stdio
      command: "..."
      args: [...]
    auth:
      required: false
      providers: []                  # opaque provider ids; wire up with your IdP
    rate_limits:
      requests_per_hour: 1000
      concurrent_sessions: 10
  rest:                              # declared; not yet implemented
    enabled: false
    prefix: "/api/v1"
    swagger: false
```

Transport details live in `@atlas/agent-sdk`'s `MCPTransportConfigSchema`.

## Extended `tools.mcp.tool_policy` (friday.yml only)

Platform-wide allow/deny list layered on top of whatever the wired MCP
servers advertise:

```yaml
tools:
  mcp:
    client_config:
      timeout:
        progressTimeout: "2m"
        maxTotalTimeout: "30m"
    servers:
      filesystem:
        transport:
          type: stdio
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp/friday-scratch"]
      github:
        transport:
          type: stdio
          command: "npx"
          args: ["-y", "@modelcontextprotocol/server-github"]
    tool_policy:
      type: "allowlist"                          # "allowlist" (default) or "denylist"
      allow:
        - "filesystem.read_file"
        - "filesystem.list_directory"
        - "github.get_file_contents"
      # deny: [...]                              # mutually exclusive with allow
```

`allow` and `deny` are mutually exclusive. With `allowlist` and no `allow`
array, nothing is permitted — useful as a hard lockdown. With `denylist`,
all tools are permitted except the listed ones.

Tool ids are `<server_name>.<tool_name>` — the server name comes from the
`tools.mcp.servers.*` key.

## Worked file (minimal)

```yaml
version: "1.0"
workspace:
  name: friday-platform
  description: Platform defaults for this installation.

models:
  labels: "groq:openai/gpt-oss-120b"
  # classifier / planner / conversational fall back to anthropic defaults
```
