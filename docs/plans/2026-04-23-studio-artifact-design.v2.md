<!-- v2 - 2026-04-23 - Generated via /improving-plans from docs/plans/2026-04-23-studio-artifact-design.md -->

# studio-artifact — Artifact Server Design

## Problem Statement

The studio installer downloads a 1 GB+ binary from a release URL. The current
releases endpoint has no native support for HTTP range requests, meaning a
failed download cannot resume — the user must start over. There is also no
dedicated service owned by the team: the release infrastructure is external and
not suitable for concurrent installer traffic.

## Solution

A Go HTTP service (`apps/studio-artifact`) that proxies GCS objects over HTTP
with full range-request and conditional-GET support. It streams bytes directly
from GCS to the client — no buffering in memory — so any number of clients can
download concurrently without increasing memory pressure. The service uses
Workload Identity Federation for secretless GCS access.

## User Stories

1. As an installer user, I want downloads to resume after a network interruption, so that I do not have to restart a 1 GB download from scratch.
2. As an installer user, I want the download to start immediately without waiting for the server to buffer the file, so that time-to-first-byte is minimal.
3. As an installer user, I want to receive a `Content-Length` header, so that the installer can display accurate progress.
4. As an installer developer, I want the manifest served from the same host as the artifacts, so that the installer only has one origin to configure.
5. As an installer developer, I want `ETag` and `Last-Modified` headers, so that a CDN or HTTP cache in front of the service can cache correctly.
6. As an operator, I want the service to access GCS without any secret keys, so that there are no credentials to rotate or leak.
7. As an operator, I want the service to expose a `/health` endpoint, so that Kubernetes liveness and readiness probes work without authentication.
8. As an operator, I want Prometheus metrics on a separate port, so that the metrics scraper does not touch the public download port.
9. As an operator, I want structured JSON request logs, so that log aggregation pipelines can parse them without regex.
10. As an operator, I want graceful shutdown with a 30-second drain, so that in-flight downloads complete before the pod terminates.
11. As a future developer, I want to add a new product's artifacts by uploading to a new GCS prefix, so that the service itself requires no code changes.
12. As a CDN operator, I want correct `Cache-Control` headers on every response, so that the CDN caches artifacts indefinitely and manifests for a short window.

## Implementation Decisions

### Directory and naming

- Service lives at `apps/studio-artifact/`
- Binary name: `studio-artifact`
- Default service port: `8090`
- Default metrics port: `9091`
- `SERVICE_NAME` env default: `studio-artifact`

### URL structure

URL path maps 1:1 to GCS object key under the configured bucket:

```
GET /studio/manifest.json                  → gs://{GCS_BUCKET}/studio/manifest.json
GET /studio/macos-arm64/friday-1.0.tar.gz  → gs://{GCS_BUCKET}/studio/macos-arm64/friday-1.0.tar.gz
```

A single wildcard route `GET /*` handles all paths. No routing table — adding
a new product prefix requires no service change.

Special routes (outside the wildcard):
- `GET /health` — returns `200 OK`, excluded from request logs

### HTTP semantics

| Scenario | Request | Response |
|---|---|---|
| Full download | no `Range` header | `200 OK`, `Content-Length`, full body |
| Resume / partial | `Range: bytes=N-` | `206 Partial Content`, `Content-Range`, partial body |
| Sub-range | `Range: bytes=N-M` | `206 Partial Content` |
| Invalid range | `Range: bytes=9999-0` | `416 Range Not Satisfiable` |
| Unchanged resource | `If-None-Match` or `If-Modified-Since` matches | `304 Not Modified`, no body |
| Missing object | path not in GCS | `404 Not Found` |
| HEAD request | `HEAD /*` | Headers only via `Stat`, no GCS reader opened |

Response headers always set:
- `Accept-Ranges: bytes`
- `Content-Type` (from GCS object metadata)
- `ETag` (GCS generation number, formatted as `"<generation>"`)
- `Last-Modified` (GCS object updated time, RFC1123)
- `Content-Length` (full size for 200 and HEAD; partial length for 206)
- `Content-Range` (for 206 responses only)
- `Cache-Control` (see below)

### Cache-Control strategy

The handler inspects the path suffix to choose the right caching policy:

- **`.json` paths** (manifests): `Cache-Control: public, max-age=60`
  Allows the CDN to cache for 1 minute. After a release, worst case an
  installer sees the old manifest for 60 seconds before the CDN re-fetches.

- **All other paths** (binary artifacts): `Cache-Control: public, max-age=31536000, immutable`
  Artifact filenames are versioned — once uploaded they never change. The CDN
  can cache indefinitely. This is the same policy used by `apps/gist`.

No configuration needed — a `strings.HasSuffix(path, ".json")` check in the
handler covers all foreseeable artifact types.

### HTTP write timeout

The standard service pattern sets a `WriteTimeout` on the HTTP server. A 1 GB
download over a slow connection can take 10–30 minutes, so any finite write
timeout will terminate the transfer mid-stream.

**Resolution:** The `http.Server` for the download port is started with
`WriteTimeout: 0` (disabled). Idle and read-header timeouts remain in place to
defend against slow-loris attacks on the request side. The metrics server and
health endpoint run on separate ports with standard timeouts unaffected.

Go's `net/http` will still detect client disconnects via the request context —
`io.Copy` from the GCS reader to the response writer returns when the client
drops the connection, so goroutines do not leak.

### HEAD request handling

Go's `net/http` server automatically handles `HEAD` by invoking the `GET`
handler and discarding the response body — but the handler still executes
fully. For this service that would open a GCS streaming reader and immediately
close it, wasting a `NewRangeReader` call.

**Resolution:** The handler checks `r.Method == http.MethodHead` immediately
after calling `Stat`. If true, it writes all response headers and returns
without calling `Open`. One GCS API call (Stat) instead of two, no reader
opened. CDN prefetch `HEAD` requests are handled efficiently.

### GCS access — Workload Identity Federation

`storage.NewClient(ctx)` with no credential options. ADC resolves credentials
automatically via the GKE metadata server when the pod's Kubernetes service
account is annotated with a GCP service account that has
`roles/storage.objectViewer` on the bucket.

No `SERVICE_ACCOUNT_KEY_FILE`. No secrets in env vars or Kubernetes Secrets.
Credential configuration is entirely infra-side (KSA → GSA binding).

### Config struct

```go
type Config struct {
    Port        string `env:"PORT"         envDefault:"8090"`
    MetricsPort string `env:"METRICS_PORT" envDefault:"9091"`
    LogLevel    string `env:"LOG_LEVEL"    envDefault:"info"`
    ServiceName string `env:"SERVICE_NAME" envDefault:"studio-artifact"`

    GCSBucket string `env:"GCS_BUCKET,required"`

    TLSConfig *server.TLSConfig
}
```

Parsed with `github.com/caarlos0/env/v11`. `.env` file loaded via `godotenv`
if `DOT_ENV` is set or `.env` exists.

The `http.Server` for the download port is constructed directly in `main.go`
with `WriteTimeout: 0`; `pkg/server`'s `Listen()` helper is used for the
metrics port only (which retains standard timeouts).

### Module Boundaries

**`service/storage.go` — `StorageClient`**
- **Interface:** `Stat(ctx, path) (ObjectMeta, error)` · `Open(ctx, path, offset, length int64) (io.ReadCloser, error)`
- **Hides:** GCS bucket name, `NewRangeReader` call convention (`-1` sentinel for "to end"), GCS error type translation to `ErrNotFound`
- **Trust contract:** Callers never see GCS internals. `offset=0, length=-1` is a full read. `ErrNotFound` is the only domain error callers need to handle.

**`service/handler.go` — download handler**
- **Interface:** `http.HandlerFunc` registered on `/*`
- **Hides:** RFC 7233 range header parsing, HEAD short-circuit, multi-range rejection (respond `200`), conditional GET logic, Cache-Control selection, all response header assembly
- **Trust contract:** Caller registers one handler. It always produces a valid HTTP response. HEAD uses only `Stat`. GET streams via `io.Copy` without buffering.

**`service/service.go` — `Service`**
- **Interface:** `New(cfg Config) (*Service, error)` · `Router() http.Handler` · `Close()`
- **Hides:** GCS client lifecycle, chi router setup, middleware chain
- **Trust contract:** `Router()` returns a ready handler. `Close()` is safe to call exactly once on shutdown.

### Package layout

```
apps/studio-artifact/
  main.go              — env load → config parse → service.New → metrics → http.Server (WriteTimeout:0) → signal wait → graceful shutdown
  service/
    service.go         — Config, Service struct, New(), Router(), Close()
    storage.go         — StorageClient: Stat(), Open()
    handler.go         — ServeObject http.HandlerFunc (HEAD short-circuit, range parsing, Cache-Control, streaming)
  Dockerfile
```

Follows the exact pattern of `apps/cortex` and `apps/gist`:
- Chi router (`github.com/go-chi/chi/v5`)
- Structured logging (`github.com/go-chi/httplog/v2`)
- Metrics via `pkg/metrics.StartServer()`
- 30-second graceful shutdown context
- `http.Error()` for all error responses — no custom error types

### Dockerfile

Multi-stage: `golang:1.26.2-alpine3.23` build → `alpine:3.23.3` runtime.
`CGO_ENABLED=0`, `GOOS=linux`. Runs as `65534:65534` (nobody). Build arg
`GITHUB_SHA` injected via ldflags.

Verify the Go image version matches the current value used in other service
Dockerfiles at implementation time.

## Testing Decisions

Good tests for this service test observable HTTP behaviour, not internal GCS
calls:

- **Unit tests on `handler.go`**: inject a `fakeStorage` that returns canned
  `ObjectMeta` and a `bytes.Reader`. Assert correct status codes, response
  headers (`Content-Length`, `Accept-Ranges`, `Content-Range`, `ETag`,
  `Cache-Control`), and body bytes for: full download, range request, resume,
  invalid range, not found, conditional GET hit/miss, HEAD (assert no GCS
  `Open` call, correct headers present).
- **No GCS integration tests in CI**: WIF credentials are not available in CI
  runners. The `StorageClient` boundary is the test seam — the handler test
  suite never touches real GCS.

Prior art: `apps/cortex` handler tests follow the same fake-storage pattern.

## Out of Scope

- **Upload / write endpoints** — read-only proxy; artifact publication is a CI
  pipeline concern (`gsutil cp` or equivalent).
- **Access control / auth** — downloads are public; any URL-bearing client can
  download.
- **Multi-range requests** (`Range: bytes=0-100,200-300`) — responded to with
  `200 OK` and full body; uncommon and adds complexity for no installer benefit.
- **CDN configuration** — the service emits correct cache headers; CDN setup is
  infra-side.
- **Manifest generation** — the service serves whatever is in GCS; manifest
  authoring is a release pipeline concern.
- **Rate limiting** — not needed for a public artifact server at this scale.
- **Per-request write timeouts** — `http.ResponseController` deadline tuning
  based on transfer rate is not needed; disabling `WriteTimeout` globally on
  the download port is sufficient.

## Further Notes

- The installer's `MANIFEST_URL` constant in `src/lib/installer.ts` changes to
  point at the new service host once deployed.
- The installer's Rust download command (`download.rs`) already sends
  `Range: bytes={existing_size}-` for resume and handles `206 Partial Content`
  — no installer changes needed for range support.
- The GCS bucket should have uniform bucket-level access (no per-object ACLs)
  with the GSA granted `roles/storage.objectViewer` at the bucket level.
- A CDN (Cloud CDN or Cloudflare) in front of the service is strongly
  recommended for the 1 GB artifact — the service handles the long-tail of
  cache misses and resumes, while the CDN absorbs the majority of traffic.
  With correct `Cache-Control` headers in place, the CDN will cache binary
  artifacts permanently and manifests for 60 seconds without any CDN-side
  configuration.
