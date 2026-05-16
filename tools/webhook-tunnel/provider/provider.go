// Package provider exposes the webhook payload handler. Every webhook
// — from any upstream — uses the same path-through-tunnel shape:
// the request body becomes the signal payload as-is. Workspace agents
// own parsing and any signature verification they need.
//
// The Handler interface takes already-buffered request body bytes and
// headers — never an *http.Request. This pins the "read body once,
// then parse" contract so a future caller can't accidentally re-read
// req.Body and silently get an empty second read.
package provider

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Handler is what callers invoke per webhook request. Transform
// receives the headers + body slice and returns the parsed payload
// plus a human-readable description. A non-nil error means malformed
// input the caller should surface as 400.
type Handler interface {
	Transform(headers http.Header, body []byte) (payload map[string]any, description string, err error)
}

// Init is a no-op kept for call-site compatibility with the old
// YAML-loading registry. Returns nil always.
func Init() error { return nil }

// Get returns the handler for the named provider. Only `raw` is
// supported — anything else returns nil so callers respond with a
// clear "unknown provider" error.
func Get(name string) Handler {
	if name == "raw" {
		return &rawHandler{}
	}
	return nil
}

// List returns the supported provider names. There is exactly one.
func List() []string {
	return []string{"raw"}
}

// rawHandler forwards the full JSON body as the signal payload. No
// HMAC, no event filtering, no transformation. Workspace agents that
// need signature verification do it themselves on the raw body.
type rawHandler struct{}

func (h *rawHandler) Transform(_ http.Header, body []byte) (map[string]any, string, error) {
	if len(body) == 0 {
		return nil, "", fmt.Errorf("empty body")
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, "", fmt.Errorf("json: %w", err)
	}
	m, ok := v.(map[string]any)
	if !ok {
		return nil, "", fmt.Errorf("raw provider expects JSON object, got %T", v)
	}
	return m, "Raw webhook forwarded", nil
}
