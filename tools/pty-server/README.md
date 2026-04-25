# pty-server

WebSocket↔PTY bridge for the cheatsheet terminal in `agent-playground`.
Replaces the prior Node/`node-pty`/`tsx` server (`server.ts`) with a
single static Go binary that runs on Linux, macOS (Intel + ARM), and
Windows (amd64).

## Build

From the repo root (binary lives in the root Go module):

```
go build -o pty-server ./tools/pty-server
GOOS=windows GOARCH=amd64 go build -o pty-server.exe ./tools/pty-server
```

CI builds are produced by:
- `.github/workflows/go-ci.yml` (build sanity check on every PR)
- `Dockerfile-platform`'s `go-builder` stage (Linux binary baked into the platform image)

## Run

```
pty-server
PTY_PORT=7681 PTY_LOG_LEVEL=debug pty-server
pty-server --version
```

### Env vars

| Variable        | Default | Notes                                                                  |
| --------------- | ------- | ---------------------------------------------------------------------- |
| `PTY_PORT`      | `7681`  | Listen port. `0` → kernel-assigned ephemeral (used by tests).          |
| `PTY_SHELL`     | unset   | Shell to spawn. Empty → platform default (see below).                  |
| `PTY_CWD`       | unset   | Default working dir. Overridden by `?cwd=` query param.                |
| `PTY_LOG_LEVEL` | `info`  | `debug` / `info` / `warn` / `error`. JSON output to stderr.            |

Default shells:
- Unix: `$SHELL` if set, else `/bin/bash`. `zsh` gets `-f`, `bash` gets `--norc --noprofile`.
- Windows: `COMSPEC` → `pwsh.exe` → `powershell.exe` → `cmd.exe`.

## Wire protocol

`/pty` WebSocket endpoint. Query params: `cols`, `rows`, `cwd`.

### Client → Server (text JSON)

| Type     | Payload                              |
| -------- | ------------------------------------ |
| `input`  | `{"type":"input","data":"keys..."}`  |
| `resize` | `{"type":"resize","cols":N,"rows":N}`|

### Server → Client

| Frame   | Payload                                                  |
| ------- | -------------------------------------------------------- |
| binary  | raw PTY output bytes                                     |
| text    | `{"type":"status","shell":"..."}` (sent once on connect) |
| text    | `{"type":"exit","code":N}` (then close)                  |
| text    | `{"type":"error","message":"..."}` (then close)          |

## `/health`

`GET /health` → `200 {"ok":true}` with CORS headers. `OPTIONS /health` → `204`.

**The path is `/health`, not `/healthz`.** Other Go services in this repo use
`/healthz` but the cheatsheet client (`tools/agent-playground/src/lib/components/shared/cheatsheet.svelte:44`)
hardcodes `/pty-proxy/health`. Do not "harmonize" the path without updating
the client.

## Logging

JSON to stderr, suitable for GCP/GKE structured-log ingestion.
`/health` requests are intentionally NOT logged (Docker healthcheck polling
would dominate).

| Level | Event                          |
| ----- | ------------------------------ |
| INFO  | Startup, graceful shutdown     |
| DEBUG | WS conn accepted/closed        |
| WARN  | Validation failures, ping timeouts, malformed messages |
| ERROR | PTY spawn failure, accept failure |

## Compatibility

- **Linux**: any glibc/musl distro. Static binary (`CGO_ENABLED=0`).
- **macOS**: 10.15+ (build matrix targets macOS 13/14).
- **Windows**: 10 1809+ (ConPTY minimum). Tested on Win 10 22H2 and Win 11.
- **Browser**: WebSocket clients (cheatsheet uses [restty](https://www.npmjs.com/package/restty)).
  Binary frames + UTF-8 text frames; ping/pong handled transparently by the browser.

## Threat model

pty-server binds to localhost in every deployment context (Docker
publishes only via per-pod network; Studio bundles it as an internal
binary). The WebSocket handshake skips Origin verification
(`InsecureSkipVerify: true`) because the cheatsheet runs on a different
port and connects through Vite's proxy, which is technically
cross-origin.

`?cwd=` is validated (`filepath.Abs` + `os.Stat` + `IsDir`) before being
passed to the PTY spawn — invalid values return a clear error frame.

On Windows, every spawned shell is wrapped in a Job Object with
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so closing the WS terminates the
entire descendant tree (matches Unix SIGHUP-on-session-close).

## Local dev

The cheatsheet expects a real `atlas` binary on PATH. The previous
TS server shipped a `bin/atlas` shim that proxied to `deno task atlas` —
that's been removed. From a fresh clone you need a built `atlas` available:

```
deno task compile          # produces ./bin/atlas
export PATH="$PWD/bin:$PATH"
deno task playground       # cheatsheet terminal will pick it up
```

Or simply rely on the shell's normal `which atlas` — if your dev box
already has the binary installed somewhere, the cheatsheet will find it.

## Tests

```
go test -race ./tools/pty-server/...
```

Tests are integration-style — they spawn real shells. Skipped on Windows
where the suite uses Unix shell idioms (`stty`, `printf $$`, etc.).
