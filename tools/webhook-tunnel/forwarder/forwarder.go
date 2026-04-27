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
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
)

// Forwarder bundles the atlasd URL + an HTTP client.
type Forwarder struct {
	atlasdURL string
	client    *http.Client
}

// New returns a Forwarder pointing at the given atlasd base URL
// (e.g. "http://localhost:8080").
func New(atlasdURL string) *Forwarder {
	return &Forwarder{
		atlasdURL: strings.TrimRight(atlasdURL, "/"),
		client:    &http.Client{Timeout: 30 * time.Second},
	}
}

// SignalResponse is the parsed atlasd signal response. We only care
// about sessionId — everything else is opaque.
type SignalResponse struct {
	SessionID string `json:"sessionId,omitempty"`
}

// Forward POSTs the payload to atlasd's signal endpoint:
//
//	POST {atlasdURL}/api/workspaces/{workspaceID}/signals/{signalID}
//	body: {"payload": <payload>}
//
// Returns sessionId from atlasd's response (empty if missing) and any
// error (non-2xx status, network failure, JSON parse error).
func (f *Forwarder) Forward(workspaceID, signalID string, payload map[string]any) (string, error) {
	body := map[string]any{"payload": payload}
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", fmt.Errorf("marshal: %w", err)
	}
	endpoint := fmt.Sprintf("%s/api/workspaces/%s/signals/%s",
		f.atlasdURL, workspaceID, signalID)
	req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := f.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("post atlasd: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return "", fmt.Errorf("atlasd %d: %s", resp.StatusCode, string(body))
	}
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	var sr SignalResponse
	_ = json.Unmarshal(respBody, &sr) // session ID is optional
	return sr.SessionID, nil
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
