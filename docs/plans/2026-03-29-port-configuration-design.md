# Port Configuration

Shipped on branch `ports`, 2026-03-29.

Users running Friday via `docker compose up` hit "address already in use" errors
when any of the five exposed ports are occupied. The fix: parameterized
`docker-compose.yml` with env var overrides (defaulting to high ports unlikely to
conflict), and an "external URL" concept in the playground so user-facing URLs
(cURL commands, webhook endpoints) reflect actual host ports.

## What Changed

### docker-compose.yml

All five port bindings use env var substitution with defaults:
`"${FRIDAY_DAEMON_PORT:-18080}:8080"`. Left side (host) is configurable, right
side (container) is fixed. All five `FRIDAY_*_PORT` vars are passed into the
container environment for banner and Vite URL construction.

Defaults use high ports (18080, 13100, 15200, 17681, 19090) to minimize
conflicts with common services. Users override via `.env` file or shell
environment.

### run-platform.sh (container entrypoint)

Constructs `VITE_EXTERNAL_DAEMON_URL` and `VITE_EXTERNAL_TUNNEL_URL` from
`FRIDAY_*_PORT` vars before launching `vite dev`. Startup banner uses the port
vars to show correct host-accessible URLs.

### Playground source (agent-playground)

- **`daemon-url.ts`** — added `EXTERNAL_DAEMON_URL` export (reads
  `VITE_EXTERNAL_DAEMON_URL`, defaults to `http://localhost:18080`)
- **`upload.ts`** — rerouted file uploads through `/api/daemon/*` proxy (was
  hitting daemon directly from browser)
- **`oauth-popup.ts`** — switched to `EXTERNAL_DAEMON_URL` (OAuth is a
  browser-navigation flow incompatible with server-side proxying)
- **`signal-row.svelte`** — replaced hardcoded `localhost:9090` with
  `VITE_EXTERNAL_TUNNEL_URL`
- **cURL generation** (inspector, jobs page, jobs-card-row) — switched from
  `DAEMON_BASE_URL` to `EXTERNAL_DAEMON_URL`

URL routing after changes:

| Use Case              | Mechanism                         | URL Source                 |
| --------------------- | --------------------------------- | -------------------------- |
| API calls (RPC, data) | SvelteKit proxy (`/api/daemon/*`) | Relative path              |
| File uploads          | SvelteKit proxy (`/api/daemon/*`) | Relative path              |
| OAuth popups          | Direct browser navigation         | `EXTERNAL_DAEMON_URL`      |
| cURL examples         | Display/copy-to-clipboard         | `EXTERNAL_DAEMON_URL`      |
| Webhook URLs          | Display/copy-to-clipboard         | `VITE_EXTERNAL_TUNNEL_URL` |

## Key Decisions

**Env vars only, no wrapper script.** Users set `FRIDAY_*_PORT` in `.env` if
defaults conflict. Docker's error message already tells you which port is
occupied — a 135-line auto-detection script isn't worth the complexity for a
10-second manual fix.

**High-port defaults.** Moving from 8080/3100/5200/7681/9090 to
18080/13100/15200/17681/19090 reduces the chance of conflicts with common
services (webpack-dev-server, Rails, etc.) without requiring any user
configuration.

**OAuth popups use external URL directly instead of proxy.** OAuth is a 302
redirect chain to third-party providers — the SvelteKit proxy's `fetch()`
follows redirects by default, breaking the flow. File uploads go through the
proxy; OAuth does not.

**Vite dev mode dependency.** `VITE_*` env vars work because the container runs
`vite dev`. If the playground moves to a static build, URL injection would need
a different mechanism (e.g., `/api/config` endpoint).

## Out of Scope

- Internal container ports (always fixed)
- Port configuration for local dev (`deno task dev`) — docker-compose only
- HTTPS or custom hostname support
- Ledger service port exposure
