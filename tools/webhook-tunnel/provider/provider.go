// Package provider holds the per-provider webhook signature
// verification + payload transform logic. The mapping is data-driven
// (webhook-mappings.yml) so adding a provider is a YAML change, not a
// code change.
//
// External callers see two functions: Get(name) → Handler and List() →
// []string. The Handler interface takes already-buffered request body
// bytes and headers — never an *http.Request. This pins the
// "read body once, then HMAC + parse" contract so a future caller
// can't accidentally re-read req.Body and silently get an empty
// second read.
package provider

import (
	_ "embed"
	"fmt"
	"net/http"
	"os"
	"sort"
	"sync"

	"gopkg.in/yaml.v3"
)

//go:embed mappings.yml
var defaultMappings []byte

// Handler is what callers invoke per webhook request. Both Verify and
// Transform receive the same headers + body slice — no need to
// re-buffer at the transport layer.
//
// Verify returns nil on success, an error explaining the failure
// otherwise (caller maps to HTTP 401).
//
// Transform returns the normalized payload + a human-readable
// description, or (nil, "", nil) when the event should be silently
// skipped (caller returns 200 with status:skipped). A non-nil error
// means malformed input the caller should surface as 400.
type Handler interface {
	Verify(headers http.Header, body, secret []byte) error
	Transform(headers http.Header, body []byte) (payload map[string]any, description string, err error)
}

// EventMapping is one entry under provider.events in the YAML.
type EventMapping struct {
	Actions []string          `yaml:"actions"`
	Mapping map[string]string `yaml:"mapping"`
}

// ProviderConfig is one entry under top-level providers in the YAML.
type ProviderConfig struct {
	EventHeader     string                  `yaml:"event_header"`
	EventField      string                  `yaml:"event_field"`
	SignatureHeader string                  `yaml:"signature_header"`
	Events          map[string]EventMapping `yaml:"events"`
}

// MappingsConfig is the root of webhook-mappings.yml.
type MappingsConfig struct {
	Providers map[string]ProviderConfig `yaml:"providers"`
}

var (
	loadOnce     sync.Once
	loadErr      error
	loadedConfig MappingsConfig
	handlers     map[string]Handler
)

// load parses webhook-mappings.yml from the file pointed at by
// WEBHOOK_MAPPINGS_PATH (preserves the legacy override for ops who
// added custom providers without rebuilding); falls back to the
// embedded copy. Validation errors at load time are fatal — webhooks
// arriving with broken config produce confusing 500s, so fail loud
// at startup.
func load() {
	loadOnce.Do(func() {
		raw := defaultMappings
		if path := os.Getenv("WEBHOOK_MAPPINGS_PATH"); path != "" {
			data, err := os.ReadFile(path)
			if err != nil {
				loadErr = fmt.Errorf("read WEBHOOK_MAPPINGS_PATH=%s: %w", path, err)
				return
			}
			raw = data
		}
		if err := yaml.Unmarshal(raw, &loadedConfig); err != nil {
			loadErr = fmt.Errorf("parse webhook-mappings.yml: %w", err)
			return
		}
		handlers = map[string]Handler{
			"raw": &rawHandler{},
		}
		for name, cfg := range loadedConfig.Providers {
			handlers[name] = &configHandler{name: name, cfg: cfg}
		}
	})
}

// Init forces load() to run with the current WEBHOOK_MAPPINGS_PATH
// value. Callers should invoke this at startup so a malformed config
// fails fast rather than on first webhook.
func Init() error {
	load()
	return loadErr
}

// Get returns the handler for the named provider, or nil if unknown.
func Get(name string) Handler {
	load()
	if loadErr != nil {
		return nil
	}
	return handlers[name]
}

// List returns the configured provider names sorted alphabetically.
// Sorted output keeps /status responses stable across restarts.
func List() []string {
	load()
	if loadErr != nil {
		return nil
	}
	out := make([]string, 0, len(handlers))
	for name := range handlers {
		out = append(out, name)
	}
	sort.Strings(out)
	return out
}

// rawHandler is the always-present passthrough: no HMAC verification,
// the entire JSON body becomes the payload. Used by clients that
// handle their own auth (e.g. ops triggering a signal manually).
type rawHandler struct{}

func (h *rawHandler) Verify(http.Header, []byte, []byte) error { return nil }

func (h *rawHandler) Transform(_ http.Header, body []byte) (map[string]any, string, error) {
	parsed, err := decodeJSON(body)
	if err != nil {
		return nil, "", err
	}
	m, ok := parsed.(map[string]any)
	if !ok {
		return nil, "", fmt.Errorf("raw provider expects JSON object, got %T", parsed)
	}
	return m, "Raw webhook forwarded", nil
}
