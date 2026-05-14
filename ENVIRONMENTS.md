# Environments

> **Draft — describes post-home-isolation state.** This page reflects
> the operator surface *after* Phase 3 of the home-isolation work
> ships (alignment of `getFridayHome()`'s default to `~/.friday/local`,
> explicit pinning of `FRIDAY_HOME=$HOME/.atlas` in the dev task). On
> builds where that work hasn't landed yet, the `FRIDAY_HOME` default
> for bare CLI and `deno task atlas` is `~/.atlas` — see the
> "FRIDAY_HOME" section below for the transition note. Remove this
> banner once Phase 3 ships and the description is accurate everywhere.

Friday reads its configuration from a single `.env` file under its home
directory. This page is the operator-facing reference: what each
variable does, when to set it, and what the default is.

## How Friday discovers config

On every supervised process — daemon, link, webhook-tunnel,
playground — Friday resolves its home directory once at boot, then
reads `<home>/.env` for the rest. Resolution order:

1. `FRIDAY_HOME` env var, if set, wins.
2. Friday Studio's launcher pins this for every supervised child to
   `FRIDAY_LAUNCHER_HOME` (or its default `~/.friday/local`).
3. Bare CLI / `deno task atlas` invocations fall through to a default
   that's set per-binary (see §"For everyone" below).
4. The home directory holds your `.env`, `friday.yml` (optional model
   overrides), NATS JetStream data (`<home>/nats/`), logs, workspaces,
   chats, sessions, skills, and credentials.

Override priority is **shell env > `.env` file > built-in default**.
Shell variables you export before launching Friday always beat values
in `.env`. This matters in CI and when debugging — exporting
`FRIDAY_LOG_LEVEL=debug` in the same terminal as the launcher gives
you a debug log without editing the file.

`.env` is plain `KEY=VALUE` lines, one per line. Comments start with
`#`. Values may be wrapped in single or double quotes; both are
stripped on read. The Studio installer writes this file atomically
during the API-Keys step.

---

## For everyone

These are the two variables a Friday user is most likely to set.

### `FRIDAY_HOME`

What it does: the per-process root for everything Friday writes —
workspaces, chats, sessions, skills database, memory, logs, NATS
JetStream store, and `.env` itself.

When to set it: when you want a Friday process to read and write a
specific directory. Useful for running multiple isolated Friday
instances on one machine (dev + prod, or per-project sandboxes).

Default: Friday Studio.app uses `~/.friday/local` (the launcher pins
`FRIDAY_HOME` for every supervised child). Bare `friday` binary
and `deno task atlas` invocations resolve to a per-binary default
that **differs across the home-isolation transition**:

- **Current builds (pre-Phase 3):** bare CLI and `deno task atlas`
  fall through to `~/.atlas` — the legacy default at
  `packages/utils/src/paths.ts:83`. This mismatch with Studio.app's
  `~/.friday/local` is the root cause the home-isolation plan
  addresses.
- **Post-Phase 3:** bare CLI defaults to `~/.friday/local` (matching
  Studio.app). The dev `deno task atlas` task pins
  `FRIDAY_HOME=$HOME/.atlas` explicitly in `deno.json` so dev
  behavior is preserved with the inference made legible.

Set `FRIDAY_HOME` to override.

Example: `FRIDAY_HOME=/Users/alice/work/friday-project-a`

### `FRIDAY_LAUNCHER_HOME`

What it does: tells the Studio installer and the supervising launcher
where to install / look for Friday's home. The installer can't read
`FRIDAY_HOME` because that variable gets clobbered by every nested
spawn; this one is launcher-scoped.

When to set it: same case as `FRIDAY_HOME`, but for the
Studio.app-managed install. Set this before launching the installer
to relocate the whole tree away from `~/.friday/local`.

Default: `~/.friday/local`.

Example: `FRIDAY_LAUNCHER_HOME=/Volumes/External/friday`

---

## For installers and operators

### Port remap

Friday Studio reserves a non-default port range so it doesn't clash
with another Friday instance, a bare `atlasd` from source, or any
other tool already on the conventional `5200`/`8080`. These four
vars are written by the installer to `<home>/.env`:

| Var | What it controls | Default (installer) |
|---|---|---|
| `FRIDAY_PORT_FRIDAY` | Daemon HTTP API | `18080` |
| `FRIDAY_PORT_LINK` | Credential service | `13100` |
| `FRIDAY_PORT_WEBHOOK_TUNNEL` | Webhook tunnel | `19090` |
| `FRIDAY_PORT_PLAYGROUND` | Studio UI | `15200` |

Set these in `<home>/.env` to move a service off its default. The
launcher reads each one and translates it into the right per-service
knob — daemon `--port`, `LINK_PORT`, `TUNNEL_PORT`, `PLAYGROUND_PORT`.

### URLs the UI needs

The playground UI is served as static HTML with a
`window.__FRIDAY_CONFIG__` object injected at request time. It needs
to know the absolute URL of the daemon and the webhook tunnel
(otherwise it tries to relative-path against the playground origin):

| Var | What it controls | Default |
|---|---|---|
| `FRIDAYD_URL` | Daemon URL for CLI / launcher / sibling services | `http://localhost:8080` (installer writes `:18080`; `scripts/setup-tls.sh` rewrites scheme to `https://`) |
| `EXTERNAL_DAEMON_URL` | UI-facing daemon URL — what the browser hits | falls back to `FRIDAYD_URL` |
| `EXTERNAL_TUNNEL_URL` | UI-facing webhook-tunnel URL | none |
| `LINK_SERVICE_URL` | Where the daemon proxies `/api/link/*` | `http://localhost:3100` (installer writes `:13100`) |
| `FRIDAY_TLS_CERT` / `FRIDAY_TLS_KEY` | Private-CA s2s cert + key. When both set, the daemon binds TLS and `getAtlasDaemonUrl()` auto-upgrades any `http://` `FRIDAYD_URL` to `https://`. | unset (plain HTTP) |
| `FRIDAY_TLS_CA` | CA cert path passed to `curl --cacert` (and `urllib`/`fetch` via `DENO_CERT`) so processes trust the s2s leaf. | unset |
| `DENO_CERT` / `NODE_EXTRA_CA_CERTS` | Mirror of `FRIDAY_TLS_CA` in the variables Deno and Node read at startup. | unset |

Set `EXTERNAL_DAEMON_URL` / `EXTERNAL_TUNNEL_URL` when you've placed
a reverse proxy or tunnel in front of Friday and the browser needs
the public address.

When TLS is enabled, source the daemon `.env` once per shell so curl and
ad-hoc scripts pick up the right scheme + CA cert. The block tries
`${FRIDAY_HOME:-~/.friday/local}/.env` (installed Studio, written by the
launcher) and falls back to `~/.atlas/.env` (dev convention, written by
`scripts/setup-tls.sh`):

```bash
set -a
. "${FRIDAY_HOME:-$HOME/.friday/local}/.env" 2>/dev/null \
  || . "$HOME/.atlas/.env" 2>/dev/null || true
set +a
```

### JetStream store directory

| Var | What it controls | Default |
|---|---|---|
| `FRIDAY_JETSTREAM_STORE_DIR` | NATS JetStream `-sd` argument; where chat history, session events, KV data live on disk. | `<FRIDAY_HOME>/nats` |

Set this only if you need the store on a different filesystem (e.g.
fast SSD, larger volume). The launcher, the daemon's
`readJetStreamConfig`, and `atlas migrate` all resolve the same
default — keep them in agreement.

### Provider API keys

The installer's API-Keys step writes whichever of these you provided.
They're plain `.env` entries, append-or-replace semantics on rerun.

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`,
`GROQ_API_KEY`, `FIREWORKS_API_KEY`, `PARALLEL_API_KEY`,
`TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`.

For non-Anthropic picks the installer also writes a `models:` block
to `<home>/friday.yml` so the daemon's role resolver targets the
right model IDs.

### Friday environment mode

| Var | What it controls | Default |
|---|---|---|
| `FRIDAY_ENV` | Setting this to `dev` enables the local-first session middleware (no remote credential fetch, auto-mint of a `/api/*` session). Any other value or unset = fail closed and require a valid Bearer / session cookie. | unset (fail closed) |
| `FRIDAY_KEY` | Bearer token for outbound calls to Link / cypher / share / persona / search-gateway. **Not** a local-identity JWT. | unset (local-only mode) |

The Studio installer writes `FRIDAY_ENV=dev` by default. Production
hosted deployments leave it unset and supply `FRIDAY_KEY` via a
credential service.

### Log level

| Var | What it controls | Default |
|---|---|---|
| `FRIDAY_LOG_LEVEL` | `trace`, `debug`, `info`, `warn`, `error`, `fatal` | `info` |
| `FRIDAY_LOGS_DIR` | Override the logs directory | `<FRIDAY_HOME>/logs` |

---

## For CI and power users

### Multi-tenant on one host

Two Friday instances on the same machine need three things to coexist:

1. Distinct home directories — different `FRIDAY_HOME` per process.
2. Distinct HTTP / UI ports — different `FRIDAY_PORT_*` values in
   each home's `.env`.
3. NATS isolation: the spawning binary auto-allocates a free port
   per home (see §"NATS port selection" below). You do **not** need
   to set anything for this; the binary handles it.

Example two-instance layout:
```
~/.friday/work/.env        FRIDAY_PORT_FRIDAY=18080  ...
~/.friday/personal/.env    FRIDAY_PORT_FRIDAY=18180  ...
```
Then launch each with its `FRIDAY_HOME` exported.

### Tool path overrides

The launcher discovers these binaries at startup and injects the
absolute paths so the daemon doesn't have to consult PATH. Set them
yourself only if you're running outside the launcher (e.g.
`deno task atlas`) and want to point at a specific build:

`FRIDAY_CLAUDE_PATH`, `FRIDAY_NODE_PATH`, `FRIDAY_NPX_PATH`,
`FRIDAY_UV_PATH`, `FRIDAY_UVX_PATH`, `FRIDAY_AGENT_BROWSER_PATH`,
`FRIDAY_AGENT_PYTHON`.

### Skill registry / kernel surface

| Var | What it controls | Default |
|---|---|---|
| `FRIDAY_ALLOW_REMOTE_SKILLS` | Allow installing skills from remote registries. Set to `"false"` to lock down a hardened install. | enabled by default |
| `FRIDAY_EXPOSE_KERNEL` | Show the internal kernel workspace in the picker. | `0` (hidden) |

### JetStream tuning

For unusual workloads. Defaults are fine for laptop and small-team
use. Full list lives in `.env.example`: `FRIDAY_JETSTREAM_MAX_*`,
`FRIDAY_JETSTREAM_DUPLICATE_WINDOW`, `FRIDAY_JETSTREAM_ACK_WAIT`.

### Webhook tunnel knobs

`TUNNEL_PORT` (default `9090`), `TUNNEL_TOKEN` (Cloudflare tunnel
token), `NO_TUNNEL` (set to `true` to disable the cloudflared
sidecar in CI), `WEBHOOK_SECRET` (HMAC verification — auto-generated
if absent), `WEBHOOK_MAPPINGS_PATH` (override embedded mappings).

### Link service overrides

`LINK_PORT`, `LINK_DB_PATH`, `LINK_CALLBACK_BASE`,
`LINK_ALLOW_INSECURE_HTTP`, `LINK_DEV_MODE`,
`LINK_JWT_PUBLIC_KEY_FILE`, `LINK_STATE_SIGNING_KEY_FILE`. Most
installs need none of these — the launcher defaults
`LINK_DEV_MODE=true` because Studio has no Postgres backing.

---

## For cloud deployments

Self-hosted multi-tenant or k8s installs read three extra knobs.

### External NATS broker

| Var | What it controls | Default |
|---|---|---|
| `FRIDAY_NATS_URL` | Connect to an existing NATS broker instead of spawning one. Cloud-with-shared-broker path: one NATS cluster, all tenants connect via this URL, tenant isolation via subject prefixes or NATS accounts. | unset; Friday spawns its own |

### Persona and credential services

| Var | What it controls | Default |
|---|---|---|
| `PERSONA_URL` | Fetch user identity from a remote persona service. Requires `FRIDAY_KEY` for outbound auth. | unset (local `UserStorage`) |
| `USER_IDENTITY_ADAPTER` | Force-set to `local` to ignore `PERSONA_URL`. | unset |
| `FRIDAY_URL` | Base URL for the hosted Atlas API (credentials fetch). | `https://atlas.tempestdx.com` |
| `FRIDAY_CREDENTIALS_URL` | Override the credentials endpoint directly. | `${FRIDAY_URL}/api/credentials` |
| `FRIDAY_GATEWAY_URL` | LLM / search-tool gateway. Pairs with `FRIDAY_KEY` for outbound auth. | unset |
| `FRIDAY_ATLAS_PLATFORM_URL` | One shared `atlas-platform` pod fronted by an HTTP service, addressed by N daemons. | `${daemon_url}/mcp` (same-host fallback) |
| `CYPHER_TOKEN_URL` | Where the daemon fetches `FRIDAY_KEY` from cypher at boot. | unset |
| `FRIDAY_SYSTEM_MODE` | Set to `"true"` to put logs under `/var/log/atlas` and home under `/var/lib/atlas`. | unset |

### NATS port selection (future)

Friday picks the NATS port at spawn time. The spawning binary
(launcher in prod, daemon in dev) iterates the reserved range
`14222..14231` and binds the first free slot, falling back to an
OS-assigned port only if all ten are taken. The chosen URL is
written to `<home>/nats/url` so consumers (the daemon, `atlas
migrate`, future tooling) can discover it without guessing.

This means **the NATS port is not configured per-home in `.env`**.
There's no `FRIDAY_NATS_PORT_FOR_THIS_HOME` knob — the binary owns
the decision so two homes-on-one-machine can't both write the same
port to two `.env`s and collide.

For orchestrator-managed deployments (k8s, multi-tenant launcher)
where one pod-per-tenant needs a deterministic port allocated
externally, set `FRIDAY_NATS_PORT` in shell / launchd / systemd /
pod env — not in `.env`. The spawner picks up the env value and
binds there directly. Operator-set, inspectable above the home-dir
layer.

| Var | Source | What it controls |
|---|---|---|
| `FRIDAY_NATS_PORT` | shell / orchestrator env (NOT `.env`) | Skip the reserved-range iteration; bind at this port. Cloud-per-tenant only. |

---

## See also

- `.env.example` at the repo root lists every supported variable with
  inline comments. It's the canonical "what knobs exist" reference;
  this page is the "when and why to set them" companion.
- `plans/friday-env-audit.md` is the implementer-facing variant with
  call-site citations and an internal-state-diff proposal.
