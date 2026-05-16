// Package forwarder pushes normalized webhook payloads at atlasd
// (Forward) and proxies the /platform/{provider}/{suffix} pass-through
// to atlasd's /signals/... endpoint via httputil.ReverseProxy.
//
// Using httputil.ReverseProxy for the proxy path gets RFC 7230
// hop-by-hop header stripping (Connection, Keep-Alive,
// Proxy-Authenticate, Proxy-Authorization, TE, Trailers,
// Transfer-Encoding, Upgrade) for free — the TS implementation
// stripped only Host + Content-Length, which is incorrect under RFC.
package forwarder

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Forwarder bundles the atlasd URL + an HTTP client.
type Forwarder struct {
	atlasdURL string
	transport http.RoundTripper
	client    *http.Client
}

// New returns a Forwarder pointing at the given atlasd base URL
// (e.g. "http://localhost:8080"). When caCertPath is non-empty, the
// file at that path is loaded as a PEM-encoded root CA and added to
// the transport's RootCAs — required when atlasd serves the private-CA
// s2s cert (see scripts/setup-tls.sh), since the system trust store
// has no knowledge of that CA.
func New(atlasdURL, caCertPath string) (*Forwarder, error) {
	transport, err := buildTransport(caCertPath)
	if err != nil {
		return nil, err
	}
	return &Forwarder{
		atlasdURL: strings.TrimRight(atlasdURL, "/"),
		transport: transport,
		client:    &http.Client{Timeout: 30 * time.Second, Transport: transport},
	}, nil
}

// buildTransport clones http.DefaultTransport (preserves keepalive /
// idle-pool / proxy-env defaults) and, when given a CA path, swaps in
// a TLSClientConfig that trusts that CA in addition to the system roots.
func buildTransport(caCertPath string) (http.RoundTripper, error) {
	if caCertPath == "" {
		return http.DefaultTransport, nil
	}
	// #nosec G304 -- caCertPath comes from FRIDAY_TLS_CA, set by
	// scripts/setup-tls.sh under the user's own FRIDAY_HOME. The
	// operator chooses what CA to trust; reading an arbitrary path is
	// the intended affordance, not a vulnerability.
	pem, err := os.ReadFile(caCertPath)
	if err != nil {
		return nil, fmt.Errorf("read FRIDAY_TLS_CA %q: %w", caCertPath, err)
	}
	roots, err := x509.SystemCertPool()
	if err != nil || roots == nil {
		roots = x509.NewCertPool()
	}
	if !roots.AppendCertsFromPEM(pem) {
		return nil, errors.New("FRIDAY_TLS_CA contains no valid PEM certificates")
	}
	base, ok := http.DefaultTransport.(*http.Transport)
	if !ok {
		return nil, errors.New("http.DefaultTransport is not *http.Transport — refusing to silently drop pool defaults")
	}
	t := base.Clone()
	t.TLSClientConfig = &tls.Config{RootCAs: roots, MinVersion: tls.VersionTLS12}
	return t, nil
}

// SignalResponse is the parsed atlasd signal response. We only care
// about sessionId / correlationId — everything else is opaque.
// (correlationId is returned by the ?nowait=true path; sessionId by
// the default sync path.)
type SignalResponse struct {
	SessionID     string `json:"sessionId,omitempty"`
	CorrelationID string `json:"correlationId,omitempty"`
	Status        string `json:"status,omitempty"`
}

// Forward POSTs the payload to atlasd's signal endpoint with
// `?nowait=true` so atlasd returns 202 the moment the message lands on
// the SIGNALS JetStream subject — the cascade runs async on the
// CASCADES consumer regardless. We never need the cascade's output to
// respond to the upstream webhook (Bitbucket / GitHub / etc), so
// holding the HTTP connection open while the cascade runs would just
// re-couple two systems the bus already decoupled.
//
//	POST {atlasdURL}/api/workspaces/{workspaceID}/signals/{signalID}?nowait=true
//	body: {"payload": <payload>}
//
// Returns sessionId (when atlasd is in sync mode) or correlationId
// (the nowait shape) — empty when atlasd returned neither.
//
// The 30-second client timeout covers PUBLISH ACK only. Atlasd's
// publishSignalToJetStream typically completes in <100ms; if it
// stretches past 30s, the JetStream broker or NATS connection is
// genuinely sick and a clearer error than `context deadline exceeded`
// is what callers want.
func (f *Forwarder) Forward(workspaceID, signalID string, payload map[string]any) (string, error) {
	body := map[string]any{"payload": payload}
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/signals/%s?nowait=true",
		f.atlasdURL, workspaceID, signalID)
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	if err != nil {
		// Surface what specifically failed — the bare `context deadline
		// exceeded` Go default tells the operator nothing about which
		// hop in the chain timed out. We expect this hop (tunnel →
		// atlasd JetStream publish) to take <100ms; a 30s timeout here
		// means atlasd or its broker is stuck before even accepting
		// the message.
		var ue *url.Error
		if errors.As(err, &ue) && ue.Timeout() {
			return "", fmt.Errorf(
				"timeout waiting for atlasd to ACK the signal publish (30s) — "+
					"the bus normally returns in <100ms. Check atlasd /health, the NATS "+
					"connection, and JetStream stream health. Endpoint: %s",
				endpoint,
			)
		}
		return "", fmt.Errorf("post atlasd: %w (endpoint: %s)", err, endpoint)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("atlasd %d: %s", resp.StatusCode, string(body))
	}
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var sr SignalResponse
	_ = json.Unmarshal(respBody, &sr) // both id fields are optional
	if sr.SessionID != "" {
		return sr.SessionID, nil
	}
	return sr.CorrelationID, nil
}

// ProxyHandler returns an http.Handler that reverse-proxies any
// request to atlasd's /signals/{provider}[/{suffix}] endpoint.
// Path is rewritten from /platform/{provider}/{suffix?} → /signals/...
// Query string is preserved (Meta WhatsApp verification handshake
// carries hub.verify_token + hub.challenge in the query).
//
// Routing of which provider/suffix to forward is done by the request's
// PathValue keys "provider" and "suffix" (set by the Go 1.22 mux pattern
// at /platform/{provider}/{suffix...}).
func (f *Forwarder) ProxyHandler() http.Handler {
	target, err := url.Parse(f.atlasdURL)
	if err != nil {
		// Constructor validates this; if we got here it's a programmer
		// error. Return a handler that 500s loudly.
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, fmt.Sprintf("forwarder: bad atlasd URL: %v", err), http.StatusInternalServerError)
		})
	}
	rp := &httputil.ReverseProxy{
		Transport: f.transport,
		Director: func(r *http.Request) {
			provider := chi.URLParam(r, "provider")
			// Chi exposes the wildcard tail as URL param "*".
			suffix := chi.URLParam(r, "*")
			if suffix != "" {
				r.URL.Path = "/signals/" + provider + "/" + suffix
			} else {
				r.URL.Path = "/signals/" + provider
			}
			r.URL.Scheme = target.Scheme
			r.URL.Host = target.Host
			r.Host = target.Host
		},
	}
	return rp
}
