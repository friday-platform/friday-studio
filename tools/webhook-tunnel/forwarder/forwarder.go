// Package forwarder reverse-proxies inbound webhook + platform requests
// from the cloudflared tunnel to atlasd's signal endpoints. Every byte
// of the request body and every upstream header is preserved verbatim —
// only the URL (host + path) is rewritten. The agent on the other side
// sees a request byte-identical to what the upstream (GitHub / Bitbucket
// / Slack / etc.) sent, which is what makes HMAC verification possible.
//
// Using httputil.ReverseProxy for both paths gets RFC 7230 hop-by-hop
// header stripping (Connection, Keep-Alive, Proxy-Authenticate,
// Proxy-Authorization, TE, Trailers, Transfer-Encoding, Upgrade) for
// free — the agent never sees these transport-only headers.
package forwarder

import (
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"

	"github.com/go-chi/chi/v5"
)

// Forwarder bundles the atlasd URL + a reverse-proxy transport.
type Forwarder struct {
	atlasdURL string
	transport http.RoundTripper
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

// WebhookProxyHandler returns an http.Handler that reverse-proxies
// /hook/{provider}/{workspaceId}/{signalId} on the tunnel-facing side
// to atlasd's /api/workspaces/{workspaceId}/signals/{signalId} on the
// daemon-facing side. The request method, body bytes, headers, and
// query string all pass through untouched — only the host + path
// change. atlasd's signal-trigger endpoint discriminates webhook mode
// by body shape (no envelope keys) and captures the verbatim body +
// headers so a workspace agent can verify HMAC against the exact
// bytes the upstream signed.
//
// Routing — chi binds path params `provider`, `workspaceId`, `signalId`
// at the route registration site; we just read them back here.
func (f *Forwarder) WebhookProxyHandler() http.Handler {
	target, err := url.Parse(f.atlasdURL)
	if err != nil {
		return http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, fmt.Sprintf("forwarder: bad atlasd URL: %v", err), http.StatusInternalServerError)
		})
	}
	rp := &httputil.ReverseProxy{
		Transport: f.transport,
		Director: func(r *http.Request) {
			workspaceID := chi.URLParam(r, "workspaceId")
			signalID := chi.URLParam(r, "signalId")
			r.URL.Path = fmt.Sprintf("/api/workspaces/%s/signals/%s", workspaceID, signalID)
			r.URL.Scheme = target.Scheme
			r.URL.Host = target.Host
			r.Host = target.Host
		},
	}
	return rp
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
