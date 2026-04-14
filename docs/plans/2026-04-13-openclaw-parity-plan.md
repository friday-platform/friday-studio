# Friday → OpenClaw Parity + Reliability Leapfrog

**Date:** 2026-04-13
**Status:** Draft (v6 — FAST docs reconciled, `friday` CLI rename)
**Supersedes:** v5 (microsandbox runtime + RPC transport), v4 (WASM-
centric), v3 (bucketlist-anchored), v2 (narrow MemoryAdapter), v1 (cwd
sketch)

## Terminology used in this plan

- **FAST** — Friday Agent Studio & Toolkit. The shipped product.
- **Friday** — the brand; the CLI post-rename (see below).
- **Space** — user-visible name for a workspace. The YAML file is
  still `workspace.yml` and the API still uses `/api/workspaces/{id}`
  for legacy reasons, but in user-facing prose and CLI help text the
  term is "space." This plan uses "space" in prose and "workspace.yml"
  for the file.
- **`friday` CLI** — the current CLI binary is `atlas`. **The rename
  to `friday` is explicitly deferred to after material work lands.**
  Phases 1, 2, 4, 5, and 8 all ship under the `atlas` binary; the
  rename is a late-phase marketing-and-branding cut, not
  infrastructure. Every `friday ...` command in the companion
  walkthroughs is aspirational; they read correctly against the
  current `atlas` binary with a global find-and-replace. The
  rename is a one-day change whenever you're ready to ship publicly
  under the Friday brand. Do not block any Phase 1 work on it.
- **Studio UI** — parallel track, explicitly **not** blocking.
  Studio upgrades for the new Phase 1 primitives (memory views,
  skill browser updates, `friday inspect` equivalents) are leapfrog
  material — a high-quality UI is what makes the whole story
  *accessible* — but they proceed in parallel with the adapter
  work, not ahead of it. Don't gate Phase 1 ship on Studio work
  and don't gate Studio work on Phase 1 ship.
- **FridayHub (Phase 3) is deferred.** Phases 1 and 2 plus Phase 8
  are the critical path. Phase 3 is important but not tonight's
  problem; revisit when Phases 1+2 are shipping and the skill
  format has had time to settle under real use.
- **Studio** — the local web dashboard on port 15200. Drag-drop
  space loading, Agent Tester, Job Inspector (DAG + waterfall),
  Skills browser, PTY terminal. Not covered by today's parity
  conversation but referenced throughout the walkthroughs.
- **Daemon** — core backend on port 18080. Everything else talks to
  it.
- **Link** — credential service on port 13100. Backs
  `LinkCredentialRef`.
- **Webhook tunnel** — Cloudflare tunnel on port 19090. Ships
  with FAST; not a future feature.

---

## Framing: options, not dogma

Every interface, backend, phase split, and hierarchy in this doc is a
**proposed option**, not a prescription. Where a call is genuinely load-
bearing (adapter contract versioning, JSON-RPC schema shape, state-surface
deprecation order, bucketlist-cs migration as a Phase 1 canary) it's
called out explicitly; everything else is movable. The goal is to name
the shape of the decision space clearly enough that we can argue
specifics without re-deriving the premise each time.

---

## North Star

Two goals, in order:

1. **Parity** — reach OpenClaw's chat-to-durable-capability loop. A user
   says "help me with Todoist" in a chat, and by the next turn the agent
   has authored a reusable skill that's loaded automatically. This is
   the table-stakes demo.
2. **Leapfrog on reliability** — ship day-one guarantees OpenClaw
   structurally cannot make. Validated writes, versioned state,
   observable mutations, type-enforced containment, multi-agent
   orchestration, eval-backed reinforcement. Friday's primitives already
   support all six; most of the work is wiring them into the
   self-modification surface, not inventing anything.

The thesis: OpenClaw wins on the chat-to-capability loop today; Friday
wins on *trustworthy* self-modification. Users who want a personal
assistant they can actually run against their real accounts —
calendar, inbox, CRM, bank — want reliability more than they want
novelty. The plan is about being the version of this category that
enterprises will run, not the version hobbyists will poke at.

---

## What OpenClaw does (condensed)

Sources: `github.com/openclaw/openclaw`, `docs/concepts/*.md`,
`docs/tools/skills.md`, `docs/tools/clawhub.md`,
`docs/automation/standing-orders.md`, `docs/automation/cron-jobs.md`.

1. **Bootstrap files injected into system prompt** at session start —
   `AGENTS.md`, `SOUL.md`, `MEMORY.md`, `memory/YYYY-MM-DD.md`,
   `IDENTITY.md`, `USER.md`, all in `~/.openclaw/workspace`.
2. **Skills = directories with `SKILL.md`.** YAML frontmatter +
   markdown body + optional `scripts/`/`references/`/`assets/`.
   Progressive disclosure: metadata always in prompt, body loaded on
   trigger. Resolution: workspace → project → personal → managed →
   bundled.
3. **ClawHub.** Public registry (`clawhub.com`). Install drops into
   workspace skills dir; next session loads. Trust model: 1-week author
   age gate, 3-report auto-hide, installer-metadata code scanner. Docs
   warn: "treat like untrusted npm packages."
4. **Self-modification = filesystem writes.** Agent's `read`/`write`/
   `edit`/`apply_patch` tools work on any bootstrap file or skill.
   Containment: workspace cwd + `tools.deny: ["gateway"]` convention.
5. **Dreaming.** Opt-in cron consolidator with a 6-signal weighted
   promotion formula (frequency .24, relevance .30, diversity .15,
   recency .15, consolidation .10, richness .06). Only touches
   `MEMORY.md`; never skills or persona.
6. **Standing Orders.** Section in `AGENTS.md` granting durable
   authority. Separates intent from schedule.
7. **Signal breadth.** Cron + `/hooks/wake` + `/hooks/agent` + Gmail
   PubSub + ~10 chat channels. Sandbox tiers `off|non-main|all` via
   Docker.

**What OpenClaw does well:** low-ceremony emergent capability,
human-reviewable state (`git diff ~/.openclaw/workspace`), broad
messaging-channel surface, the `skill-creator` loop as a zero-friction
onboarding path.

**Where OpenClaw is structurally limited:**

- **No schema enforcement.** `SKILL.md` frontmatter is parsed
  best-effort. A malformed skill half-lands; a typo in a cron
  expression breaks the daemon on next start.
- **No versioning / rollback.** Latest file wins. "Undo the last three
  skill edits" is `git reset` — if the user remembered to `git init`.
- **No multi-agent orchestration.** Standing Orders + cron is the
  control-flow vocabulary. No branching, no guards, no data contracts
  between steps.
- **Filesystem-only containment.** `tools.deny: ["gateway"]` is a
  convention, not a type. Prompt injection that gets the agent to
  write outside its cwd is catastrophic.
- **Single-user by construction.** Concurrent writes to the workspace
  dir fracture the state. No team / multi-tenant story without
  rebuilding the storage layer.
- **Agent-authored skills are untrusted community code** by their own
  admission. Nothing stops a skill's `scripts/` from shelling out
  once permissions are granted.
- **Reinforcement is consolidation-only.** Dreaming promotes patterns
  from daily notes into `MEMORY.md`. There's no loop from measured
  outcomes (evals) back to prompt or skill edits.

These aren't bugs in OpenClaw. They're consequences of the design
choice to make the filesystem *the* storage primitive. Friday's
different primitives let us ship a different — and stricter — contract
on day one.

---

## What Friday already has that OpenClaw doesn't

The leapfrog story depends on primitives that already exist in the
repo. These are the load-bearing facts; nothing below is aspirational.

### Adapter-native SDK

`packages/agent-sdk/src/adapter.ts` already defines
`AgentServerAdapter`, `AgentSessionManager`, `AgentRegistry`. The
custom-agent-platform master plan
(`docs/plans/2026-04-07-custom-agent-platform-master-plan.md`) ships
`BundledAgentAdapter`, `UserAdapter` and names `CortexAdapter` +
`PostgresAgentStorageAdapter` as designed extensions. Friday is not
retrofitting the adapter pattern; it's built on it.

### FSM engine with data-contract-gated progression

`@atlas/fsm-engine` runs multi-step workflows with states, guards,
code actions, agent actions, and **data contracts** — JSON schemas
enforced at step boundaries. Per the FAST docs: *"agents must
fulfill a contract to move from step to step."* A step cannot
advance until its output parses against the next step's input
schema. This is stronger than typed handoffs; it's *schema-gated
progression* — invalid output blocks the pipeline, it doesn't
cascade downstream as garbage.

Bucketlist-cs chains `knowledge` → `hubspot` → `synthesizer` →
`knowledge` → `hubspot` across five FSM states with guards, retries,
and data contracts between every step. OpenClaw's automation layer
— cron + standing orders — cannot express any of this. OpenClaw has
no equivalent of "the pipeline blocks if the agent returned malformed
output," which is the single most common mode real workflows fail in.

### ResourceToolkit with draft → publish versioning

`packages/agent-sdk/src/resource-toolkit.ts`:

```ts
interface ResourceToolkit {
  query(wsId, slug, rawSql, params?);   // SELECT against draft CTE
  mutate(wsId, slug, rawSql, params?);  // SELECT computes new draft
  publish(wsId, slug);                  // snapshot as immutable version
  linkRef(...); listResources(...);
}
```

Every agent-writable structured resource has free immutable history.
The Ledger HTTP client satisfies the interface; backend is swappable.
"Undo the last three edits" is literally rewinding a version pointer.

### Host capabilities for agent processes

Per the master plan: "Host capabilities (`ctx.llm`, `ctx.http`) bridge
the most critical gaps" between sandboxed agents and runtime services.
This is how sandboxed code agents call out to model providers without
owning the credentials. The mechanism is extensible — `ctx.memory`,
`ctx.skills`, `ctx.scratchpad` fit the same pattern, resolved via
JSON-RPC calls from the agent process to the daemon.

### Hardware-isolated agent runtime (microsandbox)

Agents run as processes inside [microsandbox](https://microsandbox.dev/)
microVMs — hardware-level isolation via libkrun, <100ms boot times,
OCI-compatible base images. Inside the guest, the agent has a normal
Linux environment with native deps (`pip install playwright`,
`apt install chromium`) and no access to the host filesystem, the
daemon's credentials, or any other workspace's state. The **only**
communication path out of the guest is a JSON-RPC channel that
terminates at the daemon's adapter layer.

[minimal.dev](https://minimal.dev/) handles environment reproducibility
for skill installation and CI — Nickel-locked build specs so the
version that passes the trust gate is byte-identical to the version
that runs at execution time.

OpenClaw's equivalent is Docker sandboxing, opt-in, off by default
for main sessions. microsandbox is hypervisor-level (strictly
stronger than container isolation), on by default for every agent
process, and sub-100ms cold starts mean users don't notice it.

### Zod-validated configuration end-to-end

`packages/config/src/mutations/apply.ts` does load → transform →
Zod validate → atomic rename. `CreateAgentConfigValidationSchema`,
`MCPServerConfigSchema`, `AgentMetadataSchema`, `AtlasAgentConfigSchema`
— every agent-reachable entity has a runtime schema. Invalid
mutations can't land; they bounce back as errors.

### Link credential scoping

`LinkCredentialRefSchema` + `token_env`: agents reference credentials
by ID, never see raw secrets. Secrets are injected into tool processes
by the Link service. A leaked prompt can't leak a token.

### Typed signals

`packages/signals/src/providers/` — HTTP, cron, fs-watch — each
signal definition has a Zod input schema. Webhook bodies are parsed
and validated before they reach an FSM. OpenClaw webhooks are
stringly-typed bags.

### Eval harness

`tools/evals/` — the eval runner (`deno task evals run`), per-agent
eval files (`research.eval.ts`, etc.), scoring rubrics. This is the
infrastructure OpenClaw's `dreaming` doesn't have and couldn't build
without starting over — measured outcomes as a first-class input to
the system.

### Chat SDK + streaming + activity ledger

`apps/atlasd/src/chat-sdk/`, `AtlasUIMessage`, `StreamEmitter`,
`Activity` records. Every agent action is a streamable event: text,
tool calls, tool results, thinking, usage. Sessions are durable;
activity is queryable. OpenClaw's equivalent is JSONL session files.

### Multi-agent workflows are already real, and plural

`examples/bucketlist-cs/workspace.yml` defines four agents
(`knowledge`, `hubspot`, `synthesizer`, plus bundled) across three
jobs. The `auto-answer-new-tickets` job runs
`hubspot → synthesizer → knowledge → hubspot` with guards and
iteration.

But bucketlist isn't the only existence proof. FAST **ships with
four starter spaces** that are real, working, complete workflows:

- Bitbucket pull request code review
- GitHub pull request code review
- Jira bug fix (clones repo, runs Claude Code, opens PR, comments)
- Jira labeled bug fix (auto-finds `ai-fix` labeled tickets,
  claims, fixes, PRs, transitions to Done)

Each starter has its own multi-agent FSM with data-contract
handoffs. OpenClaw has no starter spaces of this complexity because
it lacks the orchestration substrate to express them. The starters
are the existence proof that the multi-agent story isn't a future
promise — it's a product feature users run today.

### Studio (the visual dashboard)

FAST ships with a local web dashboard (port 15200, `http://
localhost:15200`) that is the primary UI for most users. Features:

- **Drag-drop space loading.** Drop a `workspace.yml` onto the
  dashboard to add a space. No CLI needed for the common case.
- **Agent Tester.** Select any agent (built-in or custom), provide
  inputs, pick a model, see the result — used for testing prompts
  and choosing models before wiring into jobs.
- **Job Inspector.** DAG visualization of the FSM plus a waterfall
  timeline of a run. You can see every agent step, duration,
  input/output, data contract validation status. This is already
  leapfrog #3 (observability) with a rendered UI.
- **Skills browser.** Navigate, edit, upload, publish skills. Drag
  a skill folder onto the page to publish.
- **PTY server (port 17681).** Browser-based terminal. You can run
  CLI commands from inside the Studio without a separate terminal.

OpenClaw has no visual dashboard at all. The gap between "git diff
~/.openclaw/workspace" and "a DAG visualization of your workflow
execution with per-step input/output and data contract validation"
is categorical, not marginal.

### Webhook tunnel (Cloudflare-backed, ships at port 19090)

FAST ships with a built-in Cloudflare tunnel that creates a public
URL on startup. External services (GitHub, Bitbucket, Jira) send
webhooks to `https://{tunnel-domain}/hook/{provider}/{workspaceId}/
{signalId}`, the tunnel HMAC-verifies and forwards to the daemon,
the daemon routes to the correct space's signal handler.

Provider transformations (`github` / `bitbucket` / `jira` / `raw`)
normalize incoming payloads so your FSM receives clean typed input
(`{pr_url: ...}`, `{issue_key: ..., project_key: ...}`) instead of
raw webhook bodies. Customizable via `webhook-mappings.yml`.

OpenClaw users fight ngrok, eat public IPs, or give up on external
webhooks entirely. FAST users get a public URL for free on startup.
This is Phase 7 territory in my plan — chat-channel signals — but
the tunnel infrastructure is *already here*, so Phase 7 is adding
channels on top of an existing surface, not building the surface
from scratch.

---

## Self-modification surface ladder

Every "the agent changed something" case falls into one of these
tiers. They're ordered by reversibility and blast radius (least →
most dangerous). Each leapfrog dimension below and each phase of
the plan maps back to one or more tiers; knowing which tier a given
capability serves is the difference between "this is fine to
auto-apply" and "this needs a human at the gate."

| Tier | Surface | What it changes | Reload cost | Containment |
|---|---|---|---|---|
| **0** | **Memory / scratchpad** | Narrative state (facts, preferences, standing orders); ephemeral reasoning traces | None — next prompt reads it | Adapter write boundary + Zod |
| **1a** | **Skills (prompt-only)** | Markdown instructions | None — next session resolves | Adapter + schema |
| **1b** | **Skills (with one-shot script)** | Prompt + transient executable | None — per-invocation spawn | Per-skill capability block enforced by microsandbox |
| **1c** | **Skills (with persistent helper)** | Prompt + long-running process inside the agent's microVM | Helper lifecycle tied to microVM lifecycle | Capability block + microsandbox policy |
| **2** | **Workspace config (wiring)** | Declarative `workspace.yml` edits: add existing agent to workspace, adjust FSM transitions, change agent prompts | Signal re-registration, FSM rebuild — no daemon restart | `applyMutation` + Zod schema |
| **3** | **Signals / triggers** | New cron / webhook / fs-watch — creates durable external triggers that fire autonomously | Cron manager reload, Hono route rebuild | Scoped `signal_create` tool, not generic config patch |
| **4** | **MCP server config** | Adds a new tool provider (external process, new credentials scope) | MCP client reconnect | Schema + credential allowlist |
| **5** | **Agent SDK authorship** | New code agent authored via `createAgent` / Python SDK, registered in `user:` namespace | `POST /api/agents/reload` — no daemon restart | Build-time Zod validation, microVM sandbox, host capability surface |
| **6** | **Source code (last resort)** | Edits in `packages/` — skill bundles, daemon code, FSM engine | Full reload, possible downtime | **No adapter — propose-and-wait staging, human review only** |

Key observations:

- **Tier 0 is a different axis than 1-6.** Tiers 1-6 change what
  the agent *can do*. Tier 0 changes what the agent *knows*. The
  permission models differ — memory writes are cheap and frequent,
  capability writes should require deliberation. Don't conflate.
- **Skills (tier 1) are three sub-tiers.** Prompt-only is free. A
  one-shot script that reads a file is cheap. A persistent helper
  that holds a Chromium process is the tier where you actually
  need user consent and per-permission scoping. The plan treats
  them as three sub-tiers, not one blob.
- **Signals (tier 3) deserve their own tier above workspace
  config.** Adding a cron means "this will now fire autonomously
  at 4am forever." Categorically different from "this workspace
  now has access to agent X." A dedicated `signal_create` tool
  (rather than generic config-patch) is what makes this safe —
  the mutation surface is narrow.
- **Agent SDK (tier 5) means the code-agent path**, not raw TS in
  `packages/bundled-agents/`. The code-agent path has a real build
  pipeline, validation gate, hot-reload, and microVM sandbox.
  Bundled TS agents are tier 6 wearing a nice hat — they require
  deno check + full reload + no sandbox.
- **Source code (tier 6) is "propose a diff" only, never
  autonomous.** Even as last resort. The agent can suggest file
  edits, run tests, iterate against them; the commit is a human
  gesture. Failure mode (broken build, can't restart daemon to
  fix the break) is unrecoverable without human intervention.
  `docs/plans/2026-04-13-friday-dev-walkthrough.md` demonstrates
  what a tier-6 workflow looks like end-to-end.

### What the agent explicitly CANNOT modify

Even with tier 6 enabled, these are out of reach by construction:

- Platform tool policy / `PLATFORM_TOOL_NAMES` allowlist
- Adapter implementations themselves (`SkillAdapter`, etc.)
- Link credential contents (only references)
- `@atlas/agent-sdk` internals
- `.friday/` state directory (session logs, cron definitions)
- `~/.friday/config/**` (daemon config, outside every workspace's
  microVM)
- Adapter schema definitions (would break the schema boundary)

These aren't convention-based denials — they're outside every
workspace's microVM reach, and they're not in any adapter's write
surface.

### How phases map to tiers

| Phase | Unlocks tier | Notes |
|---|---|---|
| Phase 1 | 0 | Memory/scratchpad adapters + bootstrap injection |
| Phase 2 | 1a, 1b, 1c | `skill_create` + per-skill capability declarations; bundled `skill-author` FSM |
| Phase 3 | 1a/b/c enrichment | FridayHub distribution + trust model |
| Phase 4 | 2, 3 | Signal graduation + standing orders via narrative memory |
| Phase 5 | 0, 1 reinforcement | Session reflector proposes patches at tiers 0 and 1 |
| Phase 6 | (backend swap, no new tier) | Pg/KV/Ledger backends |
| Phase 7 | (signal breadth, tier 3) | Chat-channel signals |
| Phase 8 | 6 | Tier-6 source modification with propose-and-wait staging, dev workspace template, `feature-delivery` FSM, CI integration |
| — | 4, 5 | Not unlocked by this plan. Tier 4 (MCP) and tier 5 (code agents via Python SDK) are served by the custom-agent-platform master plan (`2026-04-07-custom-agent-platform-master-plan.md`). |

---

## The leapfrog dimensions

The six places where Friday's primitives convert into day-one
guarantees OpenClaw can't match. Each dimension maps to concrete
commitments the plan has to honor.

### 1. Schema-validated self-modification

**Claim:** every agent-authored change — a new skill, a memory
append, a signal creation, a workspace-config edit — parses through
a Zod schema before it commits. Invalid changes are *rejected*, not
half-landed.

**Contrast:** OpenClaw's frontmatter is "parsed best-effort." A
malformed `SKILL.md` can land and partially register; a cron
expression typo in `openclaw.json` crashes the daemon on next start.

**Engineering commitment:** every adapter write goes through a
`SchemaBoundary` helper (thin wrapper; already the pattern in
`packages/config/src/mutations/apply.ts`). A Zod failure returns a
typed error to the caller; no partial state is persisted. Conformance
test kits assert: invalid input → backend state unchanged.

### 2. Versioned durable state with cheap rollback

**Claim:** every change to durable state is a versioned step. "Undo
the last three memory consolidations," "rollback the skill-creator's
last edit," "diff the workspace config between session A and session
B" are one command away.

**Contrast:** OpenClaw's history is `git log` if the user remembered
to `git init`. Dreaming consolidations have no audit trail.

**Engineering commitment:** `SkillAdapter`, `MemoryAdapter` corpora,
and workspace config mutations all record versions. Reference
backends use ResourceToolkit (free versioning); the `md` reference
backend uses a hidden `.history/` dir with timestamped snapshots.
`friday history --corpus kb --since 2h` returns a structured log.

### 3. Observable mutations

**Claim:** every self-modification is a streamable event on the chat
SDK. The human sees, in real time: "agent wrote to narrative memory,"
"agent created skill `todoist`," "agent proposed signal
`friday-weekly`." The activity ledger persists a structured record.

**Contrast:** OpenClaw's changes show up as filesystem writes and
only become visible if the user is tailing `~/.openclaw/workspace`.

**Engineering commitment:** adapter writes emit `AtlasDataEvents`
(`@atlas/agent-sdk/src/messages.ts` already defines the shape).
`friday inspect` CLI aggregates activity-ledger records into a
human-readable timeline. Every Phase 1 adapter call is wired through
the stream.

### 4. Two-layer containment (hardware + adapter contract)

**Claim:** agent processes run inside microsandbox microVMs with no
host filesystem, no host network, no access to daemon credentials
or other workspaces' state. The only escape hatch is a JSON-RPC
channel to the daemon, and every call on that channel terminates at
an adapter method with a Zod schema at the boundary. Two independent
containment layers: **hardware isolation** (the microVM boundary)
and **adapter contract** (the schema boundary). Either one is
sufficient to prevent the worst cases; together they compose.

**Contrast:** OpenClaw enforces containment by filesystem cwd + a
deny-list convention. Prompt injection that gets the agent to write
outside its cwd (via a bundled skill's script, say) bypasses
containment entirely — there's one layer and it's conventional.

**Engineering commitment:**
- **Layer 1 (hardware):** microsandbox microVM per agent runtime.
  Hypervisor-enforced syscall boundary; the guest literally cannot
  see the host's filesystem or processes. OCI-compatible base images
  so native deps (Chromium, Playwright, pgvector clients, …) just
  work inside the guest.
- **Layer 2 (adapter contract):** the JSON-RPC channel from guest
  to daemon is the only I/O path out of the microVM. Every RPC
  method is backed by an adapter call with a Zod schema; unknown
  methods are rejected. `SkillAdapter.create` cannot reach
  `LinkCredentialRef` because the RPC method doesn't exist. No
  ambient "write to any file" capability; only the typed adapter
  surface.
- **Credentials stay in the daemon.** Link credentials + agent-
  declared `.env` entries (via the existing agent config schema)
  live in the host daemon process. The microVM guest receives them
  via the RPC channel on demand for specific tool calls, scoped to
  the caller. `fs_write_file` is deprecated as a general-purpose
  write path and retained only for agents that explicitly opt in
  via workspace config (at which point the skill declares its
  filesystem intent).
- **Deno permissions are the inner belt.** The daemon itself runs
  under restrictive Deno permissions so a daemon-side bug can't
  escalate into host compromise. Layer 2 failure is bounded by the
  daemon's own sandbox.

### 5. Multi-agent orchestration with data-contract-gated progression

**Claim:** Friday ships emergent capability inside an FSM, not as a
flat prompt loop. A `skill-author` workflow is five agents, three
code actions, two guards, typed document passing between them.
Partial failures retry; session state is durable; the human can
interrupt at any step.

**Contrast:** OpenClaw's `skill-creator` is a multi-turn LLM prompt
with no external structure. If the model drifts, the user notices
after; if a step fails, the whole conversation restarts.

**Engineering commitment:** `skill-author` ships as an FSM-driven
workflow (Phase 2). States include `understand`, `plan`, `scaffold`,
`validate`, `eval`, `publish`. Each state is an agent action with
typed output. Guards gate transitions on measurable outcomes (schema
valid, test passes, eval green). This is directly supported by
`@atlas/fsm-engine` today — no new engine work required.

### 6. Eval-backed reinforcement

**Claim:** failing evals produce structured diff proposals against
the relevant skill, memory entry, or agent prompt. The next session
reads the proposed diff and either accepts, rejects, or iterates.
Dreaming's weighted heuristics become one signal among many, not the
whole story.

**Contrast:** OpenClaw's dreaming consolidates memory only and never
touches skills or persona. There's no closed loop from measured
outcomes back to prompt edits.

**Engineering commitment:** `tools/evals/` gains a `--propose-diffs`
mode that emits structured `SkillPatch` / `MemoryPatch` /
`AgentPromptPatch` objects on failing runs. A bundled
`session-reflector` agent consumes these between sessions. Adapter
writes are gated by the same schema boundary as agent writes.

---

## The design

The design exists to unlock the six leapfrog dimensions on top of
parity with OpenClaw's file-based model. Interfaces are in
`@atlas/agent-sdk` alongside existing adapter infrastructure.

### MemoryAdapter — corpus-typed with swappable backends

OpenClaw treats memory as one thing: markdown files in a dir. Real
workloads have at least four shapes, proven by existing Friday code:

- **Narrative memory** — OpenClaw `MEMORY.md`, persona, standing orders
- **Retrieval corpus** — RAG over large document collections
  (bucketlist `knowledge`)
- **Dedup state** — TTL'd set membership (bucketlist
  `processed-tickets` via `state_append`)
- **KV state** — simple key/value for session metadata, config
  caches, resume tokens

A single flat interface fails all four by being too generic. Four
sibling adapters costs 4× config and docs surface. The compromise:
a thin `MemoryAdapter` *router* that hands out kind-typed `Corpus`
handles.

```ts
// packages/agent-sdk/src/memory-adapter.ts

export interface MemoryAdapter {
  /** Open or create a named corpus. Backend resolved per-corpus from config. */
  corpus<K extends CorpusKind>(
    workspaceId: string,
    name: string,
    kind: K,
  ): Promise<CorpusOf<K>>;

  /** Enumerate corpora registered in this workspace. */
  list(workspaceId: string): Promise<CorpusMetadata[]>;

  /** Bootstrap block injected into agent system prompt at session start.
   *  A *view* over one or more narrative corpora. */
  bootstrap(workspaceId: string, agentId: string): Promise<string>;

  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, filter?: HistoryFilter): Promise<HistoryEntry[]>;
  rollback(workspaceId: string, corpus: string, toVersion: string): Promise<void>;
}

export type CorpusKind = "narrative" | "retrieval" | "dedup" | "kv";

export interface NarrativeCorpus {
  append(entry: NarrativeEntry): Promise<NarrativeEntry>;
  read(opts?: { since?: string; limit?: number }): Promise<NarrativeEntry[]>;
  search(query: string, opts?: SearchOpts): Promise<NarrativeEntry[]>;
  forget(id: string): Promise<void>;
  render(): Promise<string>;
}

export interface RetrievalCorpus {
  ingest(docs: DocBatch, opts?: IngestOpts): Promise<IngestResult>;
  query(q: RetrievalQuery, opts?: RetrievalOpts): Promise<Hit[]>;
  stats(): Promise<RetrievalStats>;
  reset(): Promise<void>;
}

export interface DedupCorpus {
  append(namespace: string, entry: DedupEntry, ttlHours?: number): Promise<void>;
  filter(namespace: string, field: string, values: unknown[]): Promise<unknown[]>;
  clear(namespace: string): Promise<void>;
}

export interface KVCorpus {
  get<T = unknown>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): Promise<string[]>;
}
```

Every corpus write emits a typed `AtlasDataEvent` on the stream
(leapfrog #3) and records a version (leapfrog #2). Every input is
Zod-validated (leapfrog #1).

**Alternatives considered:**

| Alternative | Why you'd pick it | Why this draft didn't |
|---|---|---|
| Single flat `MemoryAdapter` with `kind` on every call | Simpler type surface | Every backend no-ops half the methods; silent failures |
| Four sibling adapters as peers of `SkillAdapter` | Type-strongest | 4× registration/config/docs surface; harder to answer "what memory does this workspace have" |
| `Corpus` only, no router | Cleaner — agents grab by `(wsId, name)` | Loses `bootstrap` / `history` view; we need a router anyway |
| Keep `state_*`/`library_*`/`artifacts_*` as-is, add narrative only | Smallest diff | Perpetuates fragmentation; bucketlist can't benefit |

Open for debate — the leading alternative (four sibling adapters) is
a real option if the cost of 4× config surface is cheaper than the
ergonomics of the router.

### ScratchpadAdapter — session-scoped reasoning state

```ts
export interface ScratchpadAdapter {
  append(sessionKey: string, chunk: ScratchpadChunk): Promise<void>;
  read(sessionKey: string, opts?: { since?: string }): Promise<ScratchpadChunk[]>;
  clear(sessionKey: string): Promise<void>;
  /** Promote a chunk into a narrative corpus. Agent-gated by config. */
  promote(
    sessionKey: string,
    chunkId: string,
    target: { workspaceId: string; corpus: string },
  ): Promise<NarrativeEntry>;
}
```

Homogeneous access pattern; no corpus split needed. Default backend
is an in-memory ring buffer — ephemeral scratchpad should never hit
disk in the common case. Opt-in `md` backend for debuggability.

### SkillAdapter — versioned, validated, hot-reloadable

```ts
export interface SkillAdapter {
  list(workspaceId: string, agentId?: string): Promise<SkillMetadata[]>;
  get(workspaceId: string, name: string): Promise<ResolvedSkill | undefined>;
  create(workspaceId: string, draft: SkillDraft): Promise<ResolvedSkill>;
  update(workspaceId: string, name: string, patch: Partial<SkillDraft>): Promise<ResolvedSkill>;
  /** Versioned history — leapfrog dimension #2. */
  history(workspaceId: string, name: string): Promise<SkillVersion[]>;
  rollback(workspaceId: string, name: string, toVersion: string): Promise<ResolvedSkill>;
  invalidate(workspaceId: string): void;
}
```

`ResolvedSkill` extends the existing `AgentSkill` from
`packages/agent-sdk/src/types.ts:271` — no breaking change. The
`Ledger` backend uses ResourceToolkit's draft→publish pipeline for
free immutable versioning; the `md` backend uses `.history/` snapshot
dirs.

### Signal graduation — scoped mutation, not arbitrary config patch

The plan **does not** add a generic `propose_config_patch` tool.
Workspace config is mutated only via scoped tools: `signal_create`,
`signal_delete`, `agent_add`, `agent_configure`. Each is its own
Zod schema, its own Phase in the plan, its own schema boundary. There
is no tier-breaking "agent rewrites workspace.yml" path.

### Host capability surface (in-guest agent SDK)

New host functions alongside `ctx.llm` and `ctx.http`, delivered via
the JSON-RPC channel from the guest microVM to the daemon:

```python
# friday-agent-sdk (Python, runtime dep inside the guest)

persona = ctx.memory.corpus("persona", kind="narrative")
persona.append("user prefers terse replies")
hits = persona.search("communication style")

kb = ctx.memory.corpus("kb", kind="retrieval")
kb.ingest(docs=csv_rows)
results = kb.query(text="password reset bad token", top_k=8)

seen = ctx.memory.corpus("processed-tickets", kind="dedup")
seen.append("tickets", {"ticketId": "305502595831"}, ttl_hours=48)

ctx.scratchpad.append(kind="reasoning", body=...)
ctx.skills.create(draft)  # schema-validated, atomic, versioned
```

Each call on `ctx.*` serializes to a JSON-RPC request, crosses the
microVM boundary to the daemon, and terminates at the same adapter
instance the LLM platform tools use — **one adapter, two call sites**.
The LLM path goes through MCP platform tools; the code-agent path
goes through the in-guest SDK. Same methods, same schemas, same
validation.

Wire format: JSON-RPC 2.0 over unix socket (stdio fallback for
non-Linux dev envs). Request and response bodies share Zod schemas
between daemon and agent SDK — one source of truth for the contract,
compile-time type checking on both sides of the boundary.

### Platform tool surface (LLM agents)

- `memory_corpus_list`, `memory_corpus_stats`, `memory_corpus_history`,
  `memory_corpus_rollback`
- `memory_narrative_append`, `memory_narrative_read`,
  `memory_narrative_search`, `memory_narrative_forget`
- `memory_retrieval_ingest`, `memory_retrieval_query`,
  `memory_retrieval_reset`
- `memory_dedup_append`, `memory_dedup_filter`, `memory_dedup_clear`
- `memory_kv_get`, `memory_kv_set`, `memory_kv_delete`
- `scratchpad_append`, `scratchpad_read`, `scratchpad_promote`
- `skill_list`, `skill_get`, `skill_create`, `skill_update`,
  `skill_history`, `skill_rollback`

Open question: is ~20 memory/skill tools too many for the agent's
prompt menu? Alternative: dispatch tools (`memory_call(corpus, op,
args)`) that route dynamically. Smaller prompt, weaker per-op Zod
schemas. Lean explicit for Phase 1; revisit if budget becomes a
real constraint.

### State-surface consolidation (deprecation contract)

Adding three adapters on top of five existing state surfaces would
make fragmentation worse. The mapping below is the deprecation
contract — where today's call sites go, and what gates each
deprecation.

| Today | New home | Migration gate |
|---|---|---|
| `state_append` / `state_filter` / `state_lookup` | `memory_dedup_*` or `memory_kv_*` | Phase 1 ships `sqlite-ttl` dedup + `sqlite` KV backends. Bucketlist `processed-tickets` is the canary migration. |
| `library_store` / `library_get` / `library_list` / `library_templates` | Keep for binary artifacts + template bundles. Narrative/skill payloads migrate. | Split by payload type; no hard gate. |
| `artifacts_*` | Unchanged. Chat-attached outputs, not state. | — |
| `fs_*` | Deprecated as general-purpose write path; retained for user-code agents that opt in via workspace config. | Leapfrog #4 (containment) depends on this. |
| `resource_*` (ResourceToolkit) | Keep. Structured-data primitive + candidate SkillAdapter backend. | — |
| `AgentSessionState.memory` | Rename to `.ephemeral`. | Soft; rename immediately, migrate opportunistically. |
| Bundled `knowledge-hybrid` SQLite schema | `memory_retrieval_*` + `sqlite-rag` backend | Phase 1 ships `sqlite-rag`. Bucketlist `kb` is the canary. |

---

## Case studies

Four concrete use cases the plan has to satisfy. Bucketlist-cs is
one — the hardest single case — but not the only one.

### Case 1: narrative memory (OpenClaw MEMORY.md parity)

**Use case:** user says "remember I prefer terse replies," agent
writes to narrative memory, next session the preference is in the
system prompt bootstrap.

**Backend:** `md` narrative corpus, root at
`~/.friday/workspaces/<id>/MEMORY.md` + `memory/YYYY-MM-DD.md`.

**What OpenClaw can't match:**
- Memory append goes through Zod validation (leapfrog #1)
- Memory history + rollback (leapfrog #2)
- Every append streams through the chat SDK as a visible event
  (leapfrog #3)
- `memory_narrative_append` is the *only* way to touch narrative
  memory — no ambient filesystem write (leapfrog #4)

### Case 2: retrieval corpus (bucketlist-cs as representative)

**Use case:** CS agent indexes a knowledge base from CSV/PDF/TXT,
answers queries with hybrid RAG + citations.

**What exists today:** `packages/bundled-agents/src/knowledge/` —
1275 lines of hand-forged SQLite+FTS5+vector BLOB code owned by the
agent, pinned to Fireworks embeddings and Groq reranker. Schema
literal in `corpus.ts:43`. Locator via `KNOWLEDGE_CORPUS_PATH` env
var. Works; not reusable.

**Migrated state:**
- Agent calls `ctx.memory.corpus("kb", "retrieval").ingest(...)` and
  `.query(...)`. The SQLite schema, FTS5 virtual table, embedding
  BLOB column, and hybrid retrieval logic *move into* the
  `sqlite-rag` backend — same logic, new home. The knowledge agent
  shrinks to the synthesis prompt plus glue.
- Embedding provider and reranker become corpus config
  (`embedder: "fireworks"`, `reranker: "groq"`), not pinned code.
- Every ingest is a versioned operation; a failed batch can be
  rolled back cleanly instead of leaving half-indexed rows.
- The same backend is available to every future knowledge-style
  capability without re-paying the 1275-line cost.

**Why this is the Phase 1 canary:** it's the hardest existing case.
If `sqlite-rag` can host bucketlist's workload with identical eval
quality, the adapter contract is right. If it can't, we iterate
before shipping.

### Case 2b: multi-agent starter spaces (PR review / Jira bugfix)

**Use case:** FAST already ships four multi-agent starter spaces
(Bitbucket PR review, GitHub PR review, Jira bug fix, Jira labeled
bug fix). Each is a real workflow users run today: clone repo →
run Claude Code → open PR → comment → transition ticket. Multi-
agent FSM with data contracts between every step.

**What this demonstrates without requiring any plan work:**
- Leapfrog #5 (multi-agent orchestration) is live in production,
  not a future capability
- Data contracts enforce schema-gated progression today — already
  matches the Phase 1 engineering commitment on FSM output schemas
- Credentials flow through Link via `LinkCredentialRef`, agents
  never see raw tokens (leapfrog #4 foundation already in place)

**What migrates to adapter-backed form in Phase 1:**
- Skills attached to agents (`@tempest/pr-code-review` etc.)
  become `SkillAdapter.get(...)` calls; the resolution path goes
  through the adapter, same result, better audit trail.
- Any ticket-dedup state (e.g. "already processed PR #123") moves
  from `state_*` to `memory_dedup_*`.
- Activity ledger becomes the source of truth for "what did the
  agent do on this run," accessible via `friday inspect`.

**Why this case matters for the plan:** the five real workflows
(bucketlist-cs + four starters) collectively prove Friday's
orchestration primitives are production-ready. The parity plan is
not rebuilding the orchestration story — it's adding memory,
skills, and emergent capability *on top of* a multi-agent
substrate that already works. OpenClaw has nothing equivalent to
any one of these workflows, let alone five.

### Case 3: dedup state (bucketlist-cs processed-tickets)

**Use case:** cron-driven ticket processing needs TTL'd
set-membership: "have I already answered ticket 305502595831 in the
last 48 hours?"

**What exists today:** `context.stateAppend('processed-tickets', ...)`
and `context.stateFilter(...)` in `examples/bucketlist-cs/workspace.yml`,
backed by `state_*` platform tools. String-typed namespace, no schema.

**Migrated state:** `ctx.memory.corpus("processed-tickets",
"dedup").append/filter` with a Zod schema on the entry shape, TTL
semantics preserved, behavior-identical. The `state_*` tools enter
the deprecation path.

### Case 4: emergent capability authoring (Todoist demo)

**Use case:** fresh workspace, user says "help me triage my Todoist
tasks." Agent has no Todoist skill. By the next turn there's a
validated `todoist` skill in `<available_skills>` authored by the
`skill-author` FSM.

**What makes this more than OpenClaw:**
- The author loop is an FSM, not a prompt (leapfrog #5). Steps:
  understand → plan → scaffold → validate → eval → publish. Each
  step is an agent action with typed output; guards gate on
  measurable outcomes.
- Draft parses through `SkillDraft` schema (leapfrog #1). Malformed
  skills are *rejected at the adapter boundary*, not half-landed.
- The new skill is versioned (leapfrog #2). If the first attempt is
  bad, `skill_rollback` restores the previous state atomically.
- Every mutation streams (leapfrog #3). The human watches the author
  loop execute in real time.
- The skill runs inside the adapter-mediated tool surface
  (leapfrog #4). Scripts don't get ambient filesystem access; they
  get explicit host-capability grants per-permission.

### Case 5: browser control (normal Phase 2 demo)

**Use case:** a skill needs to drive a real browser — log into a
Todoist web UI, maintain a session across turns, scrape state that's
only visible post-login.

**What exists today:** nothing. `webfetch` + `@atlas/web-search`
bundled agent. No browser automation primitive.

**Why this is a normal Phase 2 demo, not a stretch:** the microVM
runtime removes every blocker. A browser skill declares a base OCI
image with Chromium + Playwright (or uses a Friday-provided
`chromium-playwright` base). The agent process, running inside its
own microVM, spawns Chromium as a normal subprocess — no host
capability gymnastics, no CDP-over-RPC bridging, no persistent-
helper lifecycle adapter. Cookie jar lives in the microVM's
`/home/agent/.config/chromium`; survives across turns within a
session; is destroyed on microVM teardown.

**This also resolves two limitations the FAST SDK docs explicitly
call out as active constraints today.** From
`sdk/how-agents-work.mdx`: *"External packages (NumPy, Pydantic,
etc.) are not supported — use `ctx.llm`, `ctx.http`, `ctx.tools`
for external capabilities."* And from
`sdk/python-reference/llm-capability.mdx`: *"No streaming responses
— Full response returned as string (WASI 0.3 will enable streaming
in late 2026)."* Both are WASM sandbox constraints. The move to
microsandbox microVMs + JSON-RPC transport erases both in one
change: native deps work because the guest is a real Linux
userland, and LLM streaming works because JSON-RPC natively
carries streams. The SDK docs needing to describe workarounds for
"no native deps" becomes a historical note.

**What OpenClaw can't match:**
- The browser runs inside a hardware-isolated microVM, not a
  Docker container with ambient network (leapfrog #4). A hostile
  page can't escape the guest.
- Secrets stay in the daemon. The skill references
  `LinkCredentialRef` for the Todoist login; the daemon injects
  credentials via a scoped RPC call when the skill explicitly
  requests them, not as ambient env vars in the microVM.
- The browser skill is versioned via `SkillAdapter` (leapfrog #2).
  "Roll back the browser skill to yesterday's version because
  Chromium 130 broke something" is one command.
- Every navigation, click, and tool call is observable on the
  chat SDK stream (leapfrog #3).

**The agent-authors-its-own-browser-control dogfood** (the "first
self-mod test case" from the earlier chat turn) can still run as a
stretch after Phase 2 ships. The agent studies the bundled browser
skill, authors its own variant for a different target site (e.g.
Linear, Notion, Calendar), and the same `skill-author` FSM validates
it. The bundled skill is the template; the self-authored one is the
proof.

---

## Containment / trust model

OpenClaw's rule: "agent can't modify its own policy config because
the fs tool can't reach it." Friday's rule is stronger — it's
*type-enforced*:

1. **Adapter boundary = capability boundary.** `SkillAdapter.create`
   can write to the skill store. It cannot touch agent credentials,
   MCP server configs, or signal policy. Agent processes running
   inside microsandbox microVMs have no ambient filesystem; LLM
   agents reach durable state only through typed platform tools.
2. **Zod at every boundary.** Every adapter write parses its input
   through a schema before committing. Invalid inputs are typed
   errors, not partial state.
3. **Link credential scoping.** `LinkCredentialRefSchema` +
   `token_env`: agents never see raw secrets, even when authoring a
   new skill that references one. A leaked prompt can't leak a token.
4. **Sandbox-by-default for user code.** Agent processes run inside
   hardware-isolated microVMs with capability declarations (network
   allowlist, filesystem mounts, subprocess allowlist) enforced at
   the hypervisor layer. Default-deny; skills opt into specific
   capabilities per-skill.
5. **No `/elevated` escape hatch.** Friday doesn't need one —
   everything runs inside either a microVM or an MCP tool boundary
   already. Elevated shell is out-of-scope until/unless a workspace
   opts in via `host.bash.enabled`.
6. **Versioned rollback as the fail-safe.** Even if a bad skill
   lands (e.g. a prompt-injection attack that produces a valid-but-
   hostile `SkillDraft`), `skill_rollback` + activity-ledger audit
   gives the operator a clean recovery path.

Explicit threat-model pairs:

| Threat | OpenClaw defense | Friday defense |
|---|---|---|
| Malformed skill half-lands | Best-effort parse (partial state) | Zod reject at adapter boundary (no state change) |
| Bad consolidation promotes noise | None (no rollback) | `memory_rollback` + versioned history |
| Prompt injection writes outside cwd | `tools.deny` convention | Hardware-isolated microVM — no host filesystem reachable from guest |
| Malicious community skill scripts | "Treat like untrusted npm" warning | Skill runs inside its own microVM with capability-scoped network/filesystem/subprocess allowlist from the skill's declared `capabilities` block |
| Credential exfiltration via skill | `tools.deny` on secrets paths | Credentials held by daemon; injected via scoped RPC on demand; skill code never holds a raw secret at rest |
| Compromised skill pivots to other workspaces | No defense | Per-workspace microVM; skill in workspace A cannot reach workspace B's state |
| Broken cron expression crashes daemon | Daemon crash | Zod validation at `signal_create`; daemon never sees bad config |
| Skill's native deps drift between install and runtime | N/A (no env primitive) | Nickel-locked base image from minimal.dev; install-time hash verified at runtime |

---

## Phased implementation

Phases are reorderable but 1 gates 2 and 3; 2.5 gates the stretch
browser dogfood; 4 depends on 3; 5 depends on 1 and 3; **8 depends on
2, 3, and 5** (needs skill-author FSM as base, FridayHub for publish,
reinforcement loop for patch proposals).

### Phase 1 — Adapter foundation + state-surface consolidation

**Goal:** Land the three adapter contracts with enough backend
coverage to unlock leapfrog dimensions 1-4 (validation, versioning,
observability, containment) and migrate existing state surfaces.

1. **Interfaces** in `@atlas/agent-sdk`: `MemoryAdapter` + four
   corpus types, `ScratchpadAdapter`, `SkillAdapter`.
2. **Backends** — minimum set to unblock parity + canary migration:
   - `md` narrative (OpenClaw parity + debuggability)
   - `sqlite-rag` retrieval (bucketlist canary)
   - `sqlite-ttl` dedup (`state_append` migration target)
   - `sqlite` KV (`state_lookup` migration target)
   - `inmemory` scratchpad (default), `md` scratchpad (opt-in)
   - `md` skill
3. **Versioning + history + rollback** — mandatory on all backends
   from day one. This is leapfrog #2; deferring it means the
   abstraction ships incomplete.
4. **Streaming event emission** — every adapter write emits an
   `AtlasDataEvent` on the chat SDK stream. Leapfrog #3.
5. **Schema boundary helper** — shared `SchemaBoundary<TIn, TOut>`
   utility wrapping every adapter write call. Zod parse → commit →
   emit stream event → return. Leapfrog #1.
6. **Session bootstrap injection.** `packages/workspace/src/runtime.ts`
   calls `MemoryAdapter.bootstrap(workspaceId, agentId)` and prepends
   the result to the agent's system prompt, feature-flagged.
7. **JSON-RPC schema + in-guest SDK** for `ctx.memory` (corpus-typed),
   `ctx.scratchpad`, `ctx.skills`. Shared Zod schemas between daemon
   and `friday-agent-sdk`. Transport: JSON-RPC 2.0 over unix socket
   exposed into the microsandbox guest; stdio fallback for non-Linux
   local dev.
   - **Reconcile with existing `ctx.config.skills`.** The current
     `AgentContext` already has `config.skills` — a list of
     workspace skills the FSM pre-resolves at session start (from
     `sdk/python-reference/agent-context.mdx`). Phase 1's new
     `ctx.skills` capability wrapper must coexist: `ctx.config.skills`
     remains the pre-resolved list at session start; `ctx.skills.list()`
     returns the live merged view (pre-resolved + any authored
     mid-session via Phase 2's `ctx.skills.create(...)`). Don't
     break the existing field.
8. **Platform tools** (read-mostly for Phase 1):
   `memory_corpus_*`, `memory_narrative_*`, `memory_retrieval_*`,
   `memory_dedup_*`, `memory_kv_*`, `scratchpad_*`, `skill_list`,
   `skill_get`, `skill_history`, `skill_rollback`. (`skill_create`
   is Phase 2.)
9. **Migrations:**
   - `examples/bucketlist-cs/workspace.yml` rewired to
     `memory_dedup_*`. Existing integration tests must pass.
   - `packages/bundled-agents/src/knowledge/` rewired to
     `memory_retrieval_*`. Existing knowledge evals must pass with
     identical quality.
10. **`friday inspect` CLI** — first version. Aggregates
    activity-ledger records + corpus history into a human-readable
    timeline per workspace. Leapfrog #3, user-facing.

**What Phase 1 does NOT do:** agent-authored skill creation
(`skill_create`), FridayHub, consolidation, signal graduation,
Postgres backends, eval-backed reinforcement. Phase 1 is plumbing
+ leapfrog dimensions 1-4 + migration of existing canaries.

**Phase 1 is bigger than a typical phase.** If it looks like too
much for one landable PR, split into 1a (interfaces + schema
boundary + streaming + `md`/`inmemory` backends) and 1b
(`sqlite-rag`/`sqlite-ttl`/`sqlite` + bucketlist migration +
`friday inspect`). Both stay on the critical path.

### Phase 2 — Emergent skill authoring

**Goal:** Todoist-in-a-fresh-workspace demo. Parity target + Phase 1's
leapfrog dimensions exercised end-to-end.

**Context: the pattern already exists externally.** FAST ships with
a `writing-friday-python-agents` skill (per `core-concepts/
agents.mdx`) that you install in Claude Code to have Claude Code
write Friday agents for you. That's the emergent-capability loop
running *outside* FAST today — a coding agent in a different tool
writes code for FAST based on installed skill guidance. Phase 2
pulls that loop *inside* FAST with stronger guarantees (FSM
orchestration, data contracts, versioned output, adapter
validation). **Phase 2 isn't inventing a new capability — it's
productizing an existing external pattern under Friday's primitive
guarantees.** That's the strongest possible framing: the market has
validated the loop; we're making it first-class.

1. `skill_create` platform tool + `ctx.skills.create` host function.
2. `MdSkillAdapter.create` writes skill directory with scripts,
   references, assets. Every write is versioned.
3. **`skill-author` FSM workflow** — the leapfrog #5 piece.
   Five-state workflow: understand → plan → scaffold → validate →
   publish. Each state is an agent action with a data contract on
   its output; guards gate on schema validity and (Phase 5) eval
   results. This is not a prompt loop, it's an FSM.
4. `SkillAdapter.invalidate` wired through `fs-watch-signal`. Next
   session's system prompt resolves the new skill automatically.
   **This fixes the current "iteration = restart" pain** documented
   in `sdk/how-agents-work.mdx`: *"Rebuild on restart — changes
   take effect when you restart the platform."* Phase 1's file-
   watcher integration replaces daemon restart with hot reload for
   the skill surface.
5. **Eval:** fresh workspace, `friday prompt "help me triage my
   Todoist tasks"`, next session has `todoist` in
   `<available_skills>`. Drop-test automated in `tools/evals/`.

### Phase 2.5 — Per-skill capability declarations

**Context:** v4 of this plan had a whole phase called "script-scoped
skills with process lifecycles" to handle persistent-helper
processes (browsers, LSPs) that the previous WASM-component agent
runtime couldn't spawn directly.
That phase mostly **collapses** under the microsandbox runtime —
agents are already processes inside microVMs, so helpers are just
subprocesses of the agent, managed by the guest OS, not a new
adapter primitive.

What *doesn't* collapse: per-skill capability declarations. A skill
that wants to drive Chromium needs network access to specific
hosts, a filesystem quota for the cookie jar, and the ability to
spawn a child process. A skill that only writes markdown needs none
of those. The trust model needs these intents to be declared so
FridayHub (Phase 3) can validate them at install time.

**This is an additive schema extension to today's skill format.**
Current skills are `SKILL.md` + `references/` — no capabilities
block, no base image, no signing. Phase 2.5 adds an optional
`capabilities` frontmatter section; skills that omit it get a
default-deny policy (no network, no subprocess, no filesystem
writes outside their own sandbox dir). Existing skills in the
`@tempest/` namespace (like `@tempest/pr-code-review`,
`@tempest/cs-response-guidelines`) continue to work unchanged and
run under the default-deny policy, which is appropriate for
prompt-only skills. Skills that currently need host capabilities
(none in `@tempest/` today) would need to declare them on first
migration.

1. `SkillDraft` gains a `capabilities` field:
   ```yaml
   capabilities:
     network:
       allow: ["*.todoist.com", "*.googleapis.com"]
     filesystem:
       write: ["/home/agent/.cache/todoist"]
     subprocess:
       allow: ["chromium", "playwright"]
     base_image: "friday/playwright-chromium:1.48"
   ```
2. Microsandbox policy is generated from the capabilities block.
   The microVM is launched with exactly the network ACL, filesystem
   mounts, and process allowlist the skill declared. Nothing more.
3. Deno permissions for any daemon-side helper scripts default-deny;
   a skill that needs host-side work has to declare it, user opts in.
4. **First deliverable: bundled `browser` skill** (human-authored) —
   same as before, but now it's just a skill with a `chromium`
   base image and a `playwright` subprocess allowlist. No special
   lifecycle adapter needed; microsandbox handles process lifetime
   as a side effect of microVM lifetime.

Phase 2.5 is now a ~1-week addition to Phase 2, not a separate
phase, because the infrastructure it needed is free from
microsandbox.

### Phase 3 — FridayHub (the registry, done right)

**Goal:** Skill marketplace with Friday's trust model — "come out the
gate more mature than ClawHub."

1. **Registry service.** Start as a GitHub-backed index (each
   published skill = commit to a central repo). Cheap, auditable,
   no infra. Upgrade to a dedicated service when volume justifies.
2. **CLI:** `friday skills search|install|publish|update`.
3. **Resolution order:** workspace → project → managed (~/.friday/
   skills/) → bundled.
4. **Trust model (leapfrog over ClawHub):**
   - **Schema validation on publish AND install.** ClawHub scans
     installer metadata; Friday parses through the full `SkillDraft`
     schema including the `capabilities` declaration. Malformed
     skills can't be published.
   - **Reproducible environments via minimal.dev.** Skill base
     images are Nickel-locked build specs; the image hash is
     recorded at publish time and re-verified at install time. The
     version that passed the trust gate is byte-identical to the
     version that runs — something ClawHub structurally cannot
     offer because they have no environment primitive.
   - **Versioned, not "latest wins."** Every publish is a new
     version; installs pin a version. `friday skills update --all`
     is a deliberate action with rollback.
   - **Conformance test kit on install.** Sandboxed test run inside
     a microsandbox microVM before the skill enters the managed
     tier. Failures reject the install. Tests run in the *same*
     environment the skill will run in at execution time (same
     base image, same capabilities), so install-time green
     genuinely predicts runtime green.
   - **Per-capability trust.** The skill's `capabilities` block is
     the declaration: "this skill needs network access to
     `*.todoist.com` and nothing else." Microsandbox enforces the
     policy at runtime — hypervisor-level, not convention.
   - **Signing (Phase 3.5).** `clawhub login`-equivalent identity.
     Managed-tier skills are signed; install warns on signature
     mismatch.
5. **Semantic search.** Keyword on launch; embeddings once >200
   skills published.
6. **Install sandbox tier:** managed skills load behind
   `skills.allowManaged: false` by default. Users opt in per
   workspace.

**Why this is leapfrog over ClawHub:** ClawHub warns users that
community skills are "like untrusted npm packages." Friday can
actually enforce a meaningful trust boundary because the adapter
contract + Zod schemas + Deno sandbox + signing give us a stack
ClawHub doesn't have.

### Phase 4 — Signal graduation

**Goal:** "Remind me Fridays at 4pm" becomes a durable signal
without the user hand-editing `workspace.yml`.

1. Scoped `signal_create` / `signal_delete` platform tools — not a
   generic config-patch tool. Each is its own Zod schema, its own
   schema boundary.
2. Hot-reload for `CronManager` + Hono route registry. Existing
   mutation pipeline gets a `reloadSignals()` hook.
3. **Standing Orders** section in narrative memory (AGENTS.md-style
   block maintained by `MemoryAdapter`). Bootstrap surfaces it to
   the agent each session. Intent-vs-schedule separation matches
   OpenClaw; implementation reuses Phase 1 narrative memory.

### Phase 5 — Reinforcement loop

**Goal:** Leapfrog dimension #6. Close the loop from measured
outcomes back to agent state.

1. **`session-reflector` bundled agent.** Replaces write-only
   `SessionAISummary` (`apps/atlasd/src/session-summarizer.ts`).
   After each session, a cheap model proposes
   `memory_narrative_append` calls and optionally `skill_update`
   patches. All go through the schema boundary.
2. **Scheduled consolidation.** Cron-triggered job reads recent
   memory entries and applies a weighted promotion formula. Start
   with OpenClaw's six signals (freq .24, rel .30, div .15, rec
   .15, consol .10, rich .06) as a baseline; tune once we have
   data. Called `consolidate`, not `dreaming`.
3. **Eval → structured patch.** `tools/evals/` gains a
   `--propose-diffs` mode: failing evals emit typed
   `SkillPatch` / `MemoryPatch` / `AgentPromptPatch` objects. Next
   session reads, proposes, and either auto-applies (if confidence
   high) or surfaces to human. This is the core leapfrog over
   `dreaming`.
4. **Chat-correction classifier.** "Stop doing X" / "remember Y"
   triggers `memory_narrative_append` via the adapter. Auto-memory
   pattern, type-enforced.

### Phase 6 — Server-grade backends

**Goal:** Prove the adapter abstraction survives multi-user
deployment.

1. `pg-vector` retrieval backend (PostgreSQL + `pgvector`).
2. `pg` narrative backend for shared team workspaces.
3. `kv` dedup + KV backends (Deno KV / Redis / Cloudflare KV).
4. `ledger` skill backend using ResourceToolkit's draft → publish —
   immutable versioning comes free from the existing primitive.
5. Config profiles:
   - **Local:** `md` narrative + `sqlite-rag` retrieval +
     `sqlite-ttl` dedup + `md` skills. `git init` the workspace
     dir; the OpenClaw-style "one pane of glass" story works.
   - **Cloud:** `pg` narrative + `pg-vector` retrieval + `kv`
     dedup + `ledger` skills. Multi-user, concurrent-write-safe,
     versioned via Ledger.
   - **Hybrid:** per-corpus backend choice. Narrative memory stays
     local; retrieval corpus lives in cloud. The adapter router
     hands out corpora individually so this composes cleanly.

### Phase 7 — Broader signal surface

**Goal:** Match OpenClaw's chat-channel breadth.

Straightforward extension of existing signal providers. Slack
adapter already in deps. Priority order:
Slack → Discord → Telegram → iMessage → WhatsApp → Gmail PubSub.
Sandbox tiers (`off|non-main|all`) ported from OpenClaw, enforced
via Deno permissions instead of Docker. Standing Orders on specific
channels (user DMs vs. team channels get different trust levels)
is the leapfrog piece.

### Phase 8 — Tier-6 source modification (Friday builds Friday)

**Goal:** Unlock tier 6 of the modification ladder. The agent can
propose edits to files in `packages/` and beyond, under a staging
area, with human review gates and CI integration. Friday becomes
its own best user of Friday. Makes
`docs/plans/2026-04-13-friday-dev-walkthrough.md` work end-to-end.

This is the phase where "the plan ships" becomes "Friday ships
itself." It depends on Phase 2 (skill-author FSM as base), Phase 3
(FridayHub for publish), and Phase 5 (reinforcement loop for patch
proposals).

1. **Dev workspace template (`friday-dev`).** Pre-configured
   workspace with:
   - Source access policy (`source-write.yml`) declaring
     `write_paths`, `read_paths`, `forbidden_paths`, and
     `review_mode: propose-and-wait`.
   - Bundled dev agents as FSM roles: `architect` (reads source,
     writes design memos), `coder` (proposes file changes),
     `tester` (runs eval suites), `reviewer` (handles human review
     comments).
   - Bundled dev skills: `atlas-source` (monorepo navigation),
     `deno-toolchain` (check/lint/test/task), `git-ops` (status/
     diff/commit/push via gh), `skill-authoring` (the FSM itself),
     `ci-watch` (gh API poller).
   - Narrative memory seeded with codebase facts: monorepo layout,
     package conventions, commit message style, CLAUDE.md rules,
     recent architectural decisions from `docs/plans/`.
2. **Propose-and-wait staging area.** The core primitive. Every
   `source.write` call from a dev-tier agent lands in a staging
   area, not the real filesystem. The engineer reviews via
   `friday review diffs`, approves per-file or en masse, and only
   then does the write apply to the real repo. Rejected proposals
   never touch disk.
   - Implementation option A: git worktree per session — cleanest,
     git-native, easy rollback. Cost: one worktree per active
     review.
   - Implementation option B: overlay fs — fastest, but Linux-
     specific.
   - Implementation option C: virtual fs mounted into the microVM,
     promoted to host on approval. Best isolation, most work.
   - Open question #16 picks one. Leaning A (git worktree) for v1
     with B/C as follow-on if performance bites.
3. **Source-access policy enforcement.** `forbidden_paths` and
   `write_paths` are enforced at the RPC layer — any `source.write`
   targeting a path outside `write_paths` or inside
   `forbidden_paths` is rejected with a typed error, audited to
   the activity ledger, surfaced via `friday inspect
   --sandbox-denials`. This is the demo in Step 12 of the dev
   walkthrough.
4. **`feature-delivery` FSM** (open question #15 — two FSMs or
   one). Dev-tier sibling of `skill-author`. States:
   understand → plan → scaffold → validate → eval → commit → push
   → pr → ci-watch → pr-review → merge → publish → dogfood.
   Transitions gated on: schema validity, test results, CI status,
   human approval, reflector patch confidence. External
   transitions (CI run, human PR review) are first-class FSM
   events, not side channels.
5. **`friday review` CLI.** Diff viewer (per-file panes, syntax
   highlighted), approve / request-change / comment, approve-all
   for bulk low-stakes changes. Maps directly to the FSM's review
   gates. Includes `friday review pr <N>` to bring PR comments
   into the FSM as change requests.
6. **CI integration.** Watch GitHub Actions runs on PRs the agent
   opened. Two implementations:
   - Polling via gh API (simple, works everywhere)
   - Webhook listener (faster, requires inbound)
   Start with polling; upgrade to webhooks if latency matters.
   CI events stream on the chat SDK as `ci.watch` events
   (status, failures, details) — same stream as everything else.
7. **Tier-scoped reflector confidence** (open question #17).
   Config gains `reflector.confidence.auto_apply_threshold` keyed
   by tier. Default: tier 0/1 = 0.85, tier 6 = 0.95. Below
   threshold → queue for human review. Dev-tier workspaces set
   their own per-workspace overrides if needed.
8. **Sandbox denial audit surface.** `friday inspect
   --sandbox-denials` — show every `FORBIDDEN` event with
   timestamp, trigger, requested path/call, action, agent
   adaptation (if any), escalation status. Named in the dev
   walkthrough's Step 12; Phase 8 makes it real.
9. **Tier-6 dogfood (the acceptance test).** Phase 8 is done when
   the full Friday dev walkthrough runs end-to-end: fresh
   `friday-dev` workspace, `friday prompt "implement @friday/
   browser..."`, engineer reviews ~5 gates, one test failure
   auto-patches via reflector, engineer code-reviews the PR,
   merge, publish to FridayHub, dogfood validation in a
   throwaway workspace. All twelve steps of the walkthrough pass.
   **The acceptance test is literally the walkthrough doc.**

**What Phase 8 does NOT do:**
- Autonomous source commits. Every tier-6 apply has a human
  approval event in the activity ledger. No exceptions, no
  "high confidence threshold bypass." The reflector can propose
  auto-apply only at tiers 0–1.
- Autonomous PR merges. `gh pr merge` is a human gesture.
- Remove the human from any critical gate. The engineer can skip
  gates (approve-all, skip-review flags) but the gates still
  fire and still log; bypass is audited.
- Tier 5 (code-agent authorship). That's the custom-agent-platform
  master plan's territory, not this plan.
- Extend write access to repos outside the configured
  `write_paths`. A dev workspace can be scoped to a subdir (e.g.
  "this workspace can only touch `packages/skills/browser/`") and
  that scope is enforced at every boundary.

**Files touched:** new `packages/tier-6/staging/` (staging area
implementation), new `packages/tier-6/policy/` (source-access
enforcement), new `packages/skills/feature-delivery/` (the dev-
tier FSM skill), `packages/skills/friday-dev-template/` (workspace
template), `apps/atlas-cli/src/review.ts` (review CLI),
`packages/ci-integration/` (gh polling + webhook listener),
`packages/reflection/` (extend for tier-scoped confidence),
`packages/agent-sdk/src/platform-tools.ts` (extend
`PLATFORM_TOOL_NAMES` with `source_propose`, `source_apply`,
`source_reject`, `ci_watch`, `pr_*` tools).

**Phase 8 is where the leapfrog story stops being theoretical.**
Up through Phase 7, Friday is OpenClaw-better with novel properties
(versioning, observability, type safety). Phase 8 is the phase
where Friday starts *shipping its own features*, which is a
category OpenClaw can't even describe, let alone enter. If Phase
1–5 validates the adapter contract, Phase 8 validates that the
contract is strong enough to trust Friday with its own source
tree under supervision. That's the endgame.

---

## Risks and trade-offs

1. **Three adapters = 3× surface area.** Mitigation: shared
   `conformance-test-kit` per adapter type. Every implementation
   runs the same test suite. Regression on any backend fails CI.

2. **State-surface fragmentation makes things worse before better.**
   Needs an owner on day one. Without explicit deprecation driving,
   we end up with eight surfaces instead of five. This is the single
   biggest non-technical risk.

3. **MD reference implementation vs. server parity.** `md` wins on
   debuggability, loses on concurrent writes. Phase 6 (Postgres
   backends) cannot be indefinitely deferred or the abstraction
   rots. Explicit commitment: Phase 6 ships within two milestones
   of Phase 1, not "someday."

4. **JSON-RPC schema versioning is a real decision, not a default.**
   JSON-RPC 2.0 has no native versioning story. Options: versioned
   method names (`memory.corpus.v1.ingest`), a top-level `version`
   field on every request, or a registry of Zod schemas that both
   sides pin. Leaning toward shared Zod schemas between daemon and
   `friday-agent-sdk` with a per-method version tag — one source of
   truth for the wire contract, compile-time type-checked on both
   sides. Once shipped, schema bumps still break every deployed
   agent SDK version; treat as major-version bumps and maintain a
   compatibility shim.

5. **Leapfrog commitments have to be real, not marketing.** If
   "versioned + rollback + observable + validated" isn't enforced
   by CI and asserted by conformance test kits, it's aspiration.
   Every leapfrog dimension needs an assertion in the
   `conformance-test-kit` that runs on every adapter.

6. **Observability cost.** Streaming every adapter write through
   the chat SDK generates event volume. For a chatty
   reinforcement loop or a bulk retrieval ingest, this could
   swamp the stream. Mitigation: event sampling / batching at the
   stream emitter, not at the adapter.

7. **The `skill-author` FSM is a new kind of FSM.** Friday's FSMs
   today orchestrate deterministic steps with LLM agents as nodes.
   `skill-author` is an LLM-driven meta-workflow where the agent
   *reasons* about its own capabilities. The FSM shape might not
   fit naturally; we might need a new action type or a
   "self-directed agent with FSM supervision" pattern. Flag for
   Phase 2 design.

8. **Trust model complexity.** Per-permission trust scoring +
   conformance test kit + signing is a significant engineering
   investment for FridayHub. If we ship FridayHub without the full
   trust model, we inherit ClawHub's "untrusted npm packages"
   warning verbatim — and we've spent Phase 3 just to draw even.
   Either commit to the full trust model or don't ship Phase 3.

9. **`state_*` deprecation coupling.** Bucketlist and other
   workspaces use `state_*` today. Deprecation can't happen until
   the replacement backends ship + real migrations land. If
   `sqlite-ttl`/`sqlite` KV slip out of Phase 1, `state_*`
   deprecation slips too, and the fragmentation story doesn't
   close. Gate Phase 1 completion on the migrations, not just the
   interfaces.

10. **Tier-6 staging area correctness is load-bearing.** Phase 8's
    entire safety story depends on `propose-and-wait` working —
    writes truly don't touch the real filesystem until approval,
    rejected proposals leave zero artifacts, approved proposals
    apply atomically. If the staging implementation has a race or
    a bypass, the containment claim collapses. Property-based
    testing at the RPC layer is the mitigation, not integration
    tests alone. Also: whichever implementation we pick (git
    worktree / overlay fs / virtual fs) needs a security audit
    before Phase 8 ships.

11. **Tier-6 CI integration brittleness.** Phase 8's `ci.watch`
    events depend on polling gh API or listening for webhooks.
    Both have failure modes (rate limiting, network partitions,
    webhook delivery delays). If CI watch fails, the FSM stalls
    at the `ci-watch` state. Mitigation: bounded wait with
    escalation to human review on timeout. Do not let the FSM
    make forward progress on stale or missing CI signal.

12. **Phase 8 confidence threshold tuning.** Tier-6 reflector
    auto-apply threshold defaults to 0.95, but the right value is
    empirical. Too high and the loop stalls waiting for humans;
    too low and buggy patches land. Plan for explicit tuning
    inside Phase 8, backed by eval data from real dev-workspace
    usage. Ship with conservative defaults; tune up on evidence.

13. **Single pane of glass property.** OpenClaw: `git diff
    ~/.openclaw/workspace`. Friday local profile: `friday inspect`.
    Friday cloud profile: Grafana dashboards + audit logs.
    Different stories for different deployments. The `friday
    inspect` CLI is the mitigation — it's listed as a Phase 1
    deliverable for a reason.

---

## What we explicitly do NOT copy from OpenClaw

- **SOUL.md as a distinct persona file.** OpenClaw themselves warn
  users mix rules into it anyway. Collapse to narrative memory with
  section headers. Voice is a tone, not a file.
- **Workspace-as-cwd containment.** Adapter-bounded writes are
  stronger and honest about Friday's server-side future.
- **MCP as a skill (mcporter pattern).** Friday's `@atlas/mcp` is
  first-class infrastructure. Stay first-class.
- **`dreaming` branding.** Cron job with a scoring function;
  mythology optional.
- **Author-age + report-count gates for the registry.** Fine
  defaults but social trust, not technical trust. Our schema +
  Deno permissions + signing are the primary gate.
- **`tools.deny: ["gateway"]` convention.** Type-enforced adapter
  boundaries replace this entirely.
- **Latest-wins skill updates.** Versioned + pinned by default,
  explicit updates with rollback on failure.

---

## Success criteria

Split into parity and leapfrog axes so each is independently
verifiable.

### Parity (Phase 1 + 2)

1. A fresh workspace + `friday prompt "help me with Todoist"` →
   next prompt sees validated `todoist` skill in
   `<available_skills>` without manual file editing.
2. Narrative memory injection into system prompt at session start
   matches OpenClaw's bootstrap semantics for `MEMORY.md` +
   `memory/YYYY-MM-DD.md`.
3. Skill resolution order (workspace → project → managed →
   bundled) matches OpenClaw.
4. Existing `examples/bucketlist-cs/` evals pass on migrated
   adapter-backed path with identical retrieval quality (Phase 1
   canary).
5. Code agents (running inside microsandbox microVMs) can call
   `ctx.memory.corpus(...)` and
   `ctx.skills.create(...)` via host capabilities.

### Leapfrog (every Phase 1 delivery is assertion-backed)

6. **Schema validation:** conformance test asserts every adapter
   rejects malformed inputs atomically (backend state unchanged on
   failure). Every backend. Every corpus kind.
7. **Versioning + rollback:** conformance test asserts
   `history(...)` returns a complete audit trail and
   `rollback(...)` restores prior state byte-identical to the
   version pointer.
8. **Observable mutations:** integration test asserts every
   adapter write emits an `AtlasDataEvent` that reaches the chat
   SDK stream.
9. **Type-enforced containment:** integration test asserts
   sandboxed agent process cannot reach `~/.friday/config/` or
   any non-adapter path from inside its microVM.
10. **FSM-driven skill authoring:** Phase 2 acceptance test is the
    `skill-author` FSM completing a full cycle (understand → plan
    → scaffold → validate → publish) for a Todoist-shaped task
    with all guards firing correctly.
11. **Eval-backed reinforcement:** Phase 5 acceptance test is a
    failing `tools/evals/` run producing a valid `MemoryPatch` or
    `SkillPatch` that the next session accepts and that makes the
    eval pass.
12. **Tier-6 propose-and-wait staging:** Phase 8 acceptance test
    asserts that a `source.write` proposal from a dev-tier agent
    does not modify the real filesystem until
    `friday review approve` fires. Property-based test: inject 100
    random proposals, 100 rejects, verify zero proposals reach
    disk.
13. **Tier-6 forbidden path enforcement:** Phase 8 integration
    test has a dev-tier agent attempt to read/write every path
    in `forbidden_paths`; all attempts MUST produce audited denial
    events and zero filesystem access.
14. **Friday builds Friday dogfood:** Phase 8 acceptance test is
    the full `2026-04-13-friday-dev-walkthrough.md` running end-
    to-end against a real (sandbox) GitHub repo, producing a real
    PR, with a real merge, and a real FridayHub publish. All 12
    steps pass. This is the endgame assertion.

### Reliability commitments (assertion-backed in CI)

- **Durability:** no partial state after any adapter failure.
  Property-based test against every backend.
- **Idempotency:** consolidation jobs produce identical output on
  re-run against unchanged input. Asserted per Phase 5.
- **Rollback RPO:** every adapter write is rollback-able within
  one version. No "undo the last three writes" edge case.
- **Audit completeness:** `friday inspect --since <time>` returns
  every agent-authored change in the window. Zero unlogged
  mutations is an invariant.

Phase 1 is the load-bearing phase. If the leapfrog assertions above
can't be enforced on Phase 1's backends, the abstraction is wrong and
we iterate before Phase 2. **Parity milestones can slip; leapfrog
invariants cannot.**

---

## Open questions

1. **Storage root collision.** Is `~/.friday/workspaces/<id>/` the
   right root for the MD adapter, or should it live inside the
   existing `getAtlasHome()/agents/` tree owned by the master plan?
   We should not fork the "where does agent state live on disk"
   question.
2. **Corpus split vs. sibling adapters.** The plan proposes a thin
   `MemoryAdapter` router + four corpus sub-interfaces. The leading
   alternative is four sibling adapters. Router is ergonomically
   cleaner; siblings are type-strongest. Which cost do we prefer?
3. **Memory tool count.** ~20 memory/skill tools in the agent's
   prompt menu. Alternative: dispatch tools. Smaller prompt,
   weaker Zod schemas. Lean explicit for Phase 1; trigger for
   revisit is prompt budget on real workloads.
4. **Embedding/reranker pluggability for `sqlite-rag`.** Does it
   belong in `RetrievalCorpus` config (`ingest(opts: { embedder:
   ... })`) or in a separate `EmbeddingAdapter` /
   `RerankerAdapter`? Lean first-option for Phase 1 (simpler); it
   is a real fork.
5. **`SkillAdapter` reload mechanism.** Signal-emit (consistent
   with existing signal architecture) vs. file-watch (simpler)?
6. **`SkillDraft` → `AgentSkill` state machine.** Probably
   `SkillDraft → validate → SkillMetadata → resolve(referenceFiles)
   → AgentSkill`. Draft in Phase 1 before writing the adapter.
7. **`scratchpad_promote` permission model.** Agent-callable tool
   vs. internal consolidation primitive? Lean agent-callable
   behind a per-agent permission.
8. **`session-reflector` vs. existing session-summarizer.** Replace,
   not layer. Owner needed for the migration.
9. **Bucketlist-cs owner sign-off.** Phase 1 makes bucketlist the
   canary. Someone on that side has to agree that migrating its two
   memory surfaces is acceptable Phase 1 scope. If no, Phase 1
   needs a different canary (or Phase 1 isn't ready to start).
10. **FridayHub trust model commitment.** Phase 3 ships schema +
    conformance + signing, or doesn't ship. Partial trust is worse
    than no trust because it implies guarantees we can't back.
    Need an explicit go/no-go on full trust model before Phase 3
    design starts.
11. **`skill-author` FSM shape.** Does today's FSM engine model
    the self-directed-reasoning-with-guards pattern, or do we
    need a new action type? Answer required for Phase 2 design.
12. **Agent runtime granularity.** microVM per session? Per agent
    per session? Warm pool with reset between invocations? Matters
    for cost at scale but not for local dev. Punt until Phase 6.
13. **RPC boundary topology.** Unix socket exposed into the guest
    vs. virtio-vsock vs. stdio-only. All work; the choice affects
    cold start and observability overhead. Punt until Phase 1
    implementation spike — the adapter interface doesn't care.
14. **minimal.dev vs. microsandbox scope.** Current read: minimal.dev
    for environment reproducibility (build specs + dep resolution
    at skill install / CI), microsandbox for execution isolation
    (runtime sandbox for agent processes). Both together, solving
    adjacent problems. Needs confirmation when Phase 3 design
    starts; not blocking Phase 1.
15. **One `skill-author` FSM or two?** The Phase 2 `skill-author`
    FSM was designed for user-authored skills in chat. The dev
    walkthrough (`2026-04-13-friday-dev-walkthrough.md`) scales it
    to feature-delivery work — more states (design review, CI
    watch, PR review, post-merge publish), external transitions
    (CI, human code review), different failure recovery (PR can be
    abandoned). Recommended lean: two FSMs sharing a base —
    `skill-author` (user tier, local-only) and `feature-delivery`
    (dev tier, tier-6 source mod, crosses CI/PR boundaries).
    Blocks Phase 2 design.
16. **Tier-6 staging-area semantics.** The dev walkthrough assumes
    `review_mode: propose-and-wait` means file writes land in a
    staging area and don't touch the real filesystem until
    approved. That's an engineering commitment — needs to be
    explicit in Phase 2 scope. Candidate implementations: git
    worktree staging, overlay fs, virtual fs mounted into the
    microVM. Pick one.
17. **Reflector confidence thresholds per tier.** Phase 5's auto-
    apply threshold is 0.85 in the personal-assistant walkthrough
    (memory/skill edits in user workspaces) but probably needs to
    be 0.95+ for dev-tier patches (production code). Threshold
    should be tier-scoped config, not global.

---

## References

- [openclaw/openclaw](https://github.com/openclaw/openclaw)
- [OpenClaw docs: concepts](https://github.com/openclaw/openclaw/tree/main/docs/concepts)
- [OpenClaw docs: tools/skills.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/skills.md)
- [OpenClaw docs: tools/clawhub.md](https://github.com/openclaw/openclaw/blob/main/docs/tools/clawhub.md)
- [OpenClaw docs: automation/standing-orders.md](https://github.com/openclaw/openclaw/blob/main/docs/automation/standing-orders.md)
- Friday Agent SDK README — `packages/agent-sdk/README.md`
- Friday Agent SDK types — `packages/agent-sdk/src/types.ts`
- Friday Agent SDK adapter interface — `packages/agent-sdk/src/adapter.ts`
- Friday Resource Toolkit — `packages/agent-sdk/src/resource-toolkit.ts`
- Friday Platform Tools — `packages/agent-sdk/src/platform-tools.ts`
- Custom Agent Platform Master Plan —
  `docs/plans/2026-04-07-custom-agent-platform-master-plan.md`
- Personal assistant walkthrough —
  `docs/plans/2026-04-13-personal-assistant-walkthrough.md`
- Friday dev walkthrough (tier-6 dogfood) —
  `docs/plans/2026-04-13-friday-dev-walkthrough.md`
- Bucketlist case study — `examples/bucketlist-cs/workspace.yml` +
  `packages/bundled-agents/src/knowledge/`
- [microsandbox](https://microsandbox.dev/) — hardware-isolated
  microVM runtime for agent processes
- [microsandbox GitHub](https://github.com/microsandbox/microsandbox)
- [microsandbox docs](https://docs.microsandbox.dev/)
- [minimal.dev](https://minimal.dev/) — reproducible local-first
  sandboxes with Nickel-locked build specs
