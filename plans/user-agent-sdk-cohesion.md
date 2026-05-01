# User-agent SDK cohesion

A plan to make `type: user` Python agents work end-to-end on a fresh
install — no dev-machine state, no manual SDK wrangling — and to close
the protocol/skill drift between friday-studio and `friday-agent-sdk`.

## Survival context (read this if compaction has run)

The work below references a handful of repository facts. If you're
picking this up after the conversation has been compacted, here's
the load-bearing state:

- **Daemon spawn site for Python agents** lives in two places
  (must stay in sync):
  `apps/atlasd/routes/agents/register.ts` (`buildSpawnArgs`, validate
  handshake — sets `FRIDAY_VALIDATE_ID`) and
  `apps/atlasd/src/process-agent-executor.ts` (`buildSpawnArgs`,
  per-call execute — sets `FRIDAY_SESSION_ID`). Both currently
  read `process.env.FRIDAY_AGENT_PYTHON ?? "python3"` (landed in this
  branch as workstream C step C1).
- **Daemon envfile** — canonical
  `~/.friday/local/.env`; legacy installs (Ken's machine) still
  use `~/.atlas/.env`. Resolution goes through `getFridayHome`. The
  launcher loads it and exposes vars via `process.env` to the daemon.
  `FRIDAY_UV_PATH=/opt/homebrew/bin/uv` is the sentinel that uv is
  available; it's set by the launcher when the bundled uv ships
  (commit `c9b52fe5c`), or by the dev-setup script for in-tree
  development.
- **agent-sdk repos on Ken's machine.** Two of them:
  (a) `/Users/kenneth/tempest/agent-sdk` — branch `python-nats` at
  `912b7f1` plus uncommitted local edits to `_bridge.py` migrating
  `ATLAS_*` → `FRIDAY_*`. This is what `pip3 show friday-agent-sdk`
  reports as the editable install location, and is what
  `python3 -c "import friday_agent_sdk"` resolves to. So this is
  what Ken's daemon actually loads.
  (b) `/Users/kenneth/friday/agent-sdk` — freshly cloned, on `main`
  at `7cd2e1e`, one commit behind `origin/main` (`5bd0ccb`). Not
  used by the daemon.
- **PyPI:** `friday-agent-sdk` is published at
  https://pypi.org/project/friday-agent-sdk/ . Latest is `0.1.1`
  (released 2026-05-01, corresponds to upstream commit
  `f3337d7 chore(release): cut 0.1.1`). 0.1.1 is essentially a
  re-release of 0.1.0 — the only SDK-source change is the
  version string in `__init__.py` / `pyproject.toml`. The
  intervening commit `5bd0ccb` is a ReDoS fix in the
  `jira-agent` *example*, not in the SDK itself. Metadata
  shape (the six new fields below) is identical in 0.1.0 and
  0.1.1. Status: alpha; supports Python 3.12, 3.13, 3.14;
  maintained by `ljagiello-tempest`.
- **Six new metadata fields the SDK publishes on validate** that the
  daemon does *not* currently accept (Zod silently strips them):
  `summary`, `constraints`, `expertise.examples`, `environment`,
  `inputSchema`, `outputSchema`. The daemon's `get.ts:73-81` already
  reads `expertise.examples`, `inputSchema`, `outputSchema` — so the
  read path expects fields the write path discards.
- **Skill drift.**
  `packages/system/skills/writing-friday-agents/SKILL.md` in
  friday-studio teaches the *old* `@agent` decorator surface
  (`id`, `version`, `description` only). The SDK ships its own
  more current skill at
  `packages/python/skills/writing-friday-python-agents/SKILL.md`
  in the agent-sdk repo, which covers the new fields, `ctx.config`,
  `ctx.session`, `generate_object`, etc.
- **MCP via uvx precedent.** The daemon already spawns Python MCP
  servers (`mcp-server-time` etc.) through `uvx` on every workspace
  startup — see `packages/mcp/src/create-mcp-tools-startup.test.ts`
  and `scripts/build-studio.ts:154`. uv-run overhead for user
  agents is the same pattern.

## Problem statement

A user prompt that triggers user-agent creation in workspace-chat
(*"build me an Inbox Zero workspace"*, etc.) has three independent
ways to fail today:

1. **Routing bias.** workspace-chat picks `type: user` when the work
   is actually open-ended LLM judgment. The prompt's only type
   guidance lives in the `upsert_agent` tool description, which
   includes a too-inviting *"or when LLM-loop cost dominates the
   value"* clause. Even when the user explicitly says "use llm
   agents", the model can drop the workspace-design discipline
   entirely and shell out via `run_code` + `curl /api/agents/register`.

2. **SDK install gap.** When the daemon spawns `python3 agent.py`
   for validation, `python3` resolves to whatever PATH says — on a
   stock Mac, `/usr/bin/python3 = 3.9` (Xcode CLT). The latest
   `friday-agent-sdk` requires `>=3.12` and is not pre-installed.
   Result: `ModuleNotFoundError: friday_agent_sdk` followed by a
   15s validate-handshake timeout, then a long shell-debug spiral
   to manufacture an SDK install.

3. **Protocol drift.** Even with the SDK installed, six new
   metadata fields the SDK publishes on register (see survival
   context) are silently stripped by the daemon's
   `AgentValidateResponseSchema` Zod parser, then later read back
   as empty by `apps/atlasd/routes/agents/get.ts`.

These compound. Eric hit (2) and (3) on a fresh-ish install while
also hitting (1). Ken does not hit (2) because his daemon's
`python3` resolves to a hand-patched editable install at
`/Users/kenneth/tempest/agent-sdk/` that masks both the SDK install
gap and the protocol drift on his machine.

## Discovery: who's running what

| Source | Commit / version | env-var protocol | New metadata fields |
|---|---|---|---|
| Ken's daemon's actually-used SDK (`/Users/kenneth/tempest/agent-sdk`) | `912b7f1` + uncommitted local edits | `FRIDAY_*` ✓ | ✗ |
| Ken's freshly-pulled `~/friday/agent-sdk` | `7cd2e1e` (1 behind remote) | `FRIDAY_*` ✓ | ✓ |
| `origin/main` of `friday-platform/agent-sdk` | `5bd0ccb` | `FRIDAY_*` ✓ | ✓ |
| PyPI `friday-agent-sdk==0.1.1` (latest, 2026-05-01) | matches `f3337d7` | `FRIDAY_*` ✓ | ✓ |

**Implication:** Ken's local dev silently shadows the install gap
*and* the protocol drift. Eric's experience on PyPI 0.1.0 is the
"true" experience. We should be testing against PyPI, not against
an editable monorepo install.

## Goals

- A user on a stock Mac, no Friday/Atlas dev environment, no
  Python expertise, can have workspace-chat create a user-agent
  workspace and have it run end-to-end on first try.
- All `type: user` registrations preserve full agent metadata
  through to read-back (`get.ts`).
- workspace-chat picks the right `type` for the task, and respects
  explicit type instructions from the user.
- Agent-authoring guidance (skill content) does not silently drift
  from the SDK's published API.
- Friday-studio devs have one canonical environment-setup script,
  not "whatever happens to be in your editable pip install."

## Non-goals

- Building user agents in languages other than Python (the skill
  shape in D anticipates them, but we ship Python only for now).
- Replacing or revisiting the NATS-subprocess execution model.
- Touching the WASM-era code paths beyond cleanup
  (Dockerfile already done in this branch).

## Plan

Five workstreams, ordered by dependency. Each is shippable
independently; later items don't require all earlier items, but
the dependency arrows below are real.

### A. Routing fixes (workspace-chat) — no dependencies

**A1.** Tighten `upsert_agent`'s `type: user` description in
`packages/system/agents/workspace-chat/tools/upsert-tools.ts:223-224`.
Drop the *"or when LLM-loop cost dominates the value"* clause.
Replace with: *"Per-call decision is mechanical (regex match,
schema validation, routing table) — never LLM judgment. If the
agent calls `ctx.llm.generate` to make any decision, use
`type: llm` instead."*

**A2.** Add an `<agent_types>` section to
`packages/system/agents/workspace-chat/prompt.txt`. One-line
summary of `llm` / `user` / `atlas`, plus the rule:
*"If the user names a type explicitly, use that type unless it's
structurally impossible. Don't second-guess."* This binds
explicit user instructions to something the model won't drift off
mid-session.

**A3.** Add a hard rule against raw-curl agent registration to
`<workspace_modification>` in `prompt.txt`:
*"Agent registration goes through `upsert_agent` only. Never
`curl /api/agents/register` from `run_code`. If `upsert_agent`
fails, fix the input — do not shell out."* Eric's chat-2 collapse
was the model abandoning the workspace-design flow once
`upsert_agent` looked unavailable.

**A4.** Add an explicit-instruction case to
`packages/system/agents/workspace-chat/agent-type-default.eval.ts`:
prompt says *"Build me a workspace that does X. Use an LLM agent
for this."* → must produce `type: llm`. Also tighten the
inbox-triage assertion target after A1+A2 land.

**A5.** Tighten the trigger description on
`packages/system/skills/writing-friday-agents/SKILL.md:3` (or its
successor — see D1). Drop the *"Use even when the user says 'write
a Python function that does X'…"* override-style language. The
description should fire when an agent is being authored, not when
"the user wants automation."

### B. Protocol sync (daemon) — no dependencies

**B1.** Extend `AgentValidateResponseSchema` in
`apps/atlasd/routes/agents/register.ts:28-36` to accept the six
new optional fields the SDK publishes:

```ts
summary: z.string().optional(),
constraints: z.string().optional(),
expertise: z.object({ examples: z.array(z.string()) }).optional(),
environment: z.record(z.string(), z.unknown()).optional(),
inputSchema: z.record(z.string(), z.unknown()).optional(),
outputSchema: z.record(z.string(), z.unknown()).optional(),
```

**B2.** Persist them. Today the validate response is written to
`~/.friday/local/agents/{id}@{version}/metadata.json` (via
`installAgent` or the equivalent in `register.ts`). Either write
the new fields directly, or update the writer to pass through any
unknown fields. `apps/atlasd/routes/agents/get.ts:73-81` already
expects `expertise.examples`, `inputSchema`, `outputSchema` to
exist on read — once persistence works, those reads return real
data instead of empty defaults.

**B3.** Add a regression test in `register.test.ts` that
publishes a fake validate response containing all six new fields
and asserts they survive a register → get round-trip.

### C. Install / spawn cohesion — depends on B1 to be lossless

**C1.** Spawn change for `.py` entrypoints. (✅ landed in this
branch — `register.ts:41`, `process-agent-executor.ts:31`. Falls
back to `python3` when `FRIDAY_AGENT_PYTHON` unset. This is
intentionally an interim step; C2 supersedes the
`FRIDAY_AGENT_PYTHON` form with `uv run`.)

**C2.** Switch the spawn target to `uv run --with friday-agent-sdk`,
with the SDK version sourced from the daemon's envfile (not
hardcoded). Read `process.env.FRIDAY_AGENT_SDK_VERSION` at the
spawn site:

```ts
function buildSpawnArgs(agentPath: string): [string, string[]] {
  if (agentPath.endsWith(".py")) {
    const uv = process.env.FRIDAY_UV_PATH;
    const sdkVersion = process.env.FRIDAY_AGENT_SDK_VERSION;
    if (uv && sdkVersion) {
      return [uv, [
        "run",
        "--python", "3.12",
        "--with", `friday-agent-sdk==${sdkVersion}`,
        agentPath,
      ]];
    }
    return ["python3", [agentPath]]; // dev fallback (see E1)
  }
  // .ts unchanged
}
```

The version comes from the launcher — installer ships a default
in the bundled envfile, dev-setup script writes it for in-tree
work (see C5). Bumping the SDK is one line in the envfile, no code
change.

**Latency note (Ken's question):** uv-run overhead is the same
shape as `uvx` for MCP servers — the daemon already spawns
`mcp-server-time` etc. via uvx on every workspace startup. After
the wheel cache is warm, uv-run resolution is ~50–100ms. For
agents whose handlers do LLM/MCP calls (seconds), this is
negligible and matches existing MCP precedent.

**C3.** Set uv's cache locations under `<friday-home>/uv/` so
nothing leaks into `~/.local`. In
`tools/friday-launcher/project.go`, alongside the existing
`FRIDAY_UV_PATH=` line, emit:

```go
"UV_PYTHON_INSTALL_DIR=" + filepath.Join(fridayHome, "uv", "python"),
"UV_CACHE_DIR=" + filepath.Join(fridayHome, "uv", "cache"),
"FRIDAY_AGENT_SDK_VERSION=" + bundledSdkVersion, // from build-time pin
```

Result: managed Pythons land at
`<friday-home>/uv/python/cpython-3.12.X/`,
wheel cache at `<friday-home>/uv/cache/`.

**C4.** Mirror in `Dockerfile` for the docker-compose path. Use the
same env vars; pin the SDK version with a build-arg or a single
`ENV FRIDAY_AGENT_SDK_VERSION=…` line so docker and installer
agree:

```dockerfile
ENV UV_PYTHON_INSTALL_DIR=/data/atlas/uv/python
ENV UV_CACHE_DIR=/data/atlas/uv/cache
ENV FRIDAY_AGENT_SDK_VERSION=0.1.1
# Pre-warm cache (optional, avoids cold-start latency on first agent spawn):
RUN uv run --python 3.12 --with friday-agent-sdk==${FRIDAY_AGENT_SDK_VERSION} \
    -c "import friday_agent_sdk"
```

**C5.** **Dev-environment setup script.** Isolated from the installer
path. Friday-studio devs run this once after cloning:

`scripts/setup-dev-env.sh` (or equivalent — match the language
convention of nearby scripts) that:
1. Verifies `uv` is on PATH (or installs it via the official
   astral one-liner).
2. Writes `FRIDAY_UV_PATH=$(which uv)`, `UV_PYTHON_INSTALL_DIR`,
   `UV_CACHE_DIR`, and `FRIDAY_AGENT_SDK_VERSION=<latest-pinned>`
   into `<friday-home>/.env` if missing.
3. Pre-warms the uv cache:
   `uv run --python 3.12 --with friday-agent-sdk==<pinned> -c "import friday_agent_sdk"`.
4. Runs the local validations from E1/E2 — confirms there is no
   stale editable `friday-agent-sdk` install in any system Python
   that might shadow the uv-managed one. If found, uninstall it.
5. Prints the resolved `FRIDAY_AGENT_SDK_VERSION` so the dev sees
   what their daemon will use.

This replaces "however your machine happens to be set up" with
"every dev runs the same script and gets the same env." Explicitly
not part of the installer flow — installer ships the env via the
launcher; this script is for in-tree development only.

**C6.** Document the dev fallback in CLAUDE.md or a brief note:
when `FRIDAY_UV_PATH` or `FRIDAY_AGENT_SDK_VERSION` is unset
(daemon running out-of-tree, no launcher, dev script not run),
the spawn falls back to bare `python3` and assumes the dev has
the SDK installed in their environment. This preserves the ability
to debug without uv, but stops being load-bearing for users.

### D. Skill source-of-truth — depends on B (so the skill can teach the new fields against a daemon that accepts them)

We disambiguate two skills with different scopes. This anticipates
SDKs in additional languages without forcing a wholesale rename
later.

**D1.** **Disambiguate the skill names.**

- `writing-friday-python-agents` — vendored from the agent-sdk
  repo. Sole source of truth for Python user-agent authoring
  (decorator fields, capabilities, NATS protocol, etc.). Lives at
  `packages/system/skills/writing-friday-python-agents/` in
  friday-studio. The agent-sdk repo at
  `packages/python/skills/writing-friday-python-agents/` is the
  upstream.

- `writing-friday-agents` — kept as a *language-agnostic*
  cross-reference / dispatcher skill. Short. Says: "if you're
  writing a Friday user agent, load
  `writing-friday-python-agents` for Python. (Future: TS, Go.)"
  Plus the cross-cutting trigger guidance from A5 — when to load,
  when not to load.

**D2.** **Reliable sync, no user intervention.** Two options,
prefer the first if it works:

(a) **Symlink at install time**, pointing
`packages/system/skills/writing-friday-python-agents` →
the SDK package's installed skill resources. Requires resolving
the SDK install path at build time (or first launcher run) via
`importlib.resources` or a uv-driven helper. Works if the daemon
can locate the SDK install on disk; reliable on all OSes that
support symlinks (macOS, Linux). Windows installer would need to
fall back to copy.

(b) **Copy on SDK version bump.** A `scripts/sync-sdk-skill.ts`
that takes the pinned SDK version, downloads the wheel from PyPI
(or the matching tag from the agent-sdk repo), extracts the skill
tree, and writes it to
`packages/system/skills/writing-friday-python-agents/`. Run as
part of CI on `FRIDAY_AGENT_SDK_VERSION` bump. Annotate the
vendored files with a `// vendored from
friday-platform/agent-sdk@<sha>` header so a human reading them
knows not to edit in place.

Recommendation: ship (b) first (deterministic, reproducible),
then revisit (a) once we have a clean cross-platform SDK-asset
lookup. Add a CI check that the vendored skill matches the
upstream tag for `FRIDAY_AGENT_SDK_VERSION`.

**D3.** **Cross-references.** Update `prompt.txt` and any other
caller that references `@friday/writing-friday-agents` to also
know about `writing-friday-python-agents`. Probably the dispatcher
skill handles this — `writing-friday-agents` loads the
language-specific one.

### E. Dev-environment hygiene — depends on C2 + C5

**E1.** Replace Ken's editable
`/Users/kenneth/tempest/agent-sdk/packages/python` install with
the PyPI version, or rather: **uninstall it entirely** and let
the uv-run path take over. Action item for the dev script (C5):

```sh
if pip3 show friday-agent-sdk >/dev/null 2>&1; then
  echo "Removing editable friday-agent-sdk install (uv-run is now load-bearing)"
  pip3 uninstall -y friday-agent-sdk
fi
# Also catch /opt/homebrew/lib/python3.X/site-packages
for py in $(uv python list --only-installed | awk '{print $1}'); do
  $py -m pip uninstall -y friday-agent-sdk 2>/dev/null || true
done
```

This is one of the local validations the dev script performs.

**E2.** Once C2 lands, no in-tree Python should have
`friday-agent-sdk` importable except through `uv run`. The dev
script enforces this on every run.

## Order of operations

```
A1, A2, A3, A4, A5  ─┐
                     ├─→ ship workspace-chat improvements
B1, B2, B3        ──┐
                    ├─→ ship daemon protocol sync
                    │
C1 (✅)             │
C2 ────depends on B1┴─→ ship install fix
C3, C4, C5, C6
                                                        │
D1, D2, D3 ──depends on B (skill teaches new fields) ───┴─→ ship skill sync
E1, E2 ──depends on C2 + C5 ────────────────────────────→ stop dev drift
```

A and B can ship in parallel today. C2 must not ship without B1
(otherwise PyPI users hit the lossy register and we mask it
behind successful spawning). D depends on B for the same reason.
E rides on C5 (the dev script is where uninstall lives).

## Risks and mitigations

- **uv-run per-spawn latency.** Same shape as MCP `uvx` invocation
  the codebase already accepts. Negligible for agents that already
  take seconds. If anything spawns user agents in a tight loop and
  this becomes an issue, swap to a managed venv (cache the
  resolved python path, use it directly).
- **First-spawn cold start.** On a fresh install, the first
  user-agent spawn downloads Python 3.12 (~80MB) and the SDK
  wheel. C4 pre-warms in Docker; C5 pre-warms for devs. Installer
  could pre-warm during install (deferred — fine to take the cold
  start on first agent spawn, gives a "Friday is preparing" UX
  signal once).
- **PyPI dependency for fresh installs.** First registration
  needs internet. Friday already requires it for LLM/MCP/etc., so
  not a new constraint.
- **PyPI version drift.** Pinned via `FRIDAY_AGENT_SDK_VERSION` in
  the envfile, written by installer and dev script. Bumping is
  deliberate, not automatic. CI check (D2) ties skill content to
  this same pin.
- **Skill staleness post-vendoring.** D2's CI check fails if the
  vendored skill doesn't match the upstream tag for the pinned
  version. Forces sync at version bump time.
- **Symlink vs copy on Windows.** D2 recommends copy first. If we
  ever ship a desktop installer for Windows, it can use junction
  points; for now, copy is reliable everywhere.

## What's already done in this branch

- Dockerfile WASM cleanup — `componentize-py` + `jco` install
  removed, comment block updated.
- Spawn change C1 — `register.ts` and `process-agent-executor.ts`
  honor `FRIDAY_AGENT_PYTHON` (interim form, will be replaced by
  `FRIDAY_UV_PATH` + `FRIDAY_AGENT_SDK_VERSION` when C2 lands).
- 9/9 register-route tests passing including a new
  `FRIDAY_AGENT_PYTHON` honoring case.
