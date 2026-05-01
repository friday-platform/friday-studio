package provider

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
)

// configHandler is a YAML-driven Handler. One instance per provider
// entry in webhook-mappings.yml.
type configHandler struct {
	name string
	cfg  ProviderConfig
}

// Verify checks the HMAC-SHA256 signature in cfg.SignatureHeader. The
// expected value is "sha256=<hex(hmac(secret, body))>" — same format
// GitHub/Bitbucket use. Returns nil when:
//   - secret is empty (caller hasn't configured a shared secret),
//   - cfg has no signature_header (provider doesn't sign),
//
// otherwise returns a descriptive error.
func (h *configHandler) Verify(headers http.Header, body, secret []byte) error {
	if len(secret) == 0 {
		return nil
	}
	if h.cfg.SignatureHeader == "" {
		return nil
	}
	got := headers.Get(h.cfg.SignatureHeader)
	if got == "" {
		return fmt.Errorf("missing %s header", h.cfg.SignatureHeader)
	}
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	// constant-time compare; subtle.ConstantTimeCompare requires equal
	// lengths so check that first.
	if len(got) != len(want) || subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
		return fmt.Errorf("invalid signature")
	}
	return nil
}

// Transform parses the body, resolves the event key (from header or
// body field), looks up the matching event mapping, applies action
// filtering (if configured), and extracts mapped fields via dot-path.
// Returns (nil, "", nil) when the event is configured but should be
// silently skipped (unknown event, action not in actions list) — the
// caller responds 200 with status:skipped.
func (h *configHandler) Transform(headers http.Header, body []byte) (map[string]any, string, error) {
	parsed, err := decodeJSON(body)
	if err != nil {
		return nil, "", err
	}
	bodyMap, _ := parsed.(map[string]any)
	// bodyMap may be nil for non-object payloads (e.g. JSON arrays).
	// extractByPath handles nil gracefully — but event-field resolution
	// won't find anything either, so the request is silently skipped.

	// Resolve the event key. Either header (GitHub/Bitbucket style) or
	// body field (Jira style). Configurations with neither produce
	// "not configured for any event" which silently skips.
	var eventKey string
	switch {
	case h.cfg.EventHeader != "":
		eventKey = headers.Get(h.cfg.EventHeader)
	case h.cfg.EventField != "":
		v := extractByPath(bodyMap, h.cfg.EventField)
		if s, ok := v.(string); ok {
			eventKey = s
		}
	}
	if eventKey == "" {
		return nil, "", nil
	}

	eventCfg, ok := h.cfg.Events[eventKey]
	if !ok {
		return nil, "", nil
	}

	// Action filter (GitHub-style). Only check if the YAML lists actions
	// — providers without an actions list accept everything.
	if len(eventCfg.Actions) > 0 {
		actVal, _ := bodyMap["action"].(string)
		if !contains(eventCfg.Actions, actVal) {
			return nil, "", nil
		}
	}

	// Extract mapped fields. Missing fields are skipped silently — same
	// as the TS implementation.
	payload := map[string]any{}
	for outputField, sourcePath := range eventCfg.Mapping {
		if v := extractByPath(bodyMap, sourcePath); v != nil {
			payload[outputField] = v
		}
	}

	// Description: provider + event [+ action] + first string value.
	// Mirrors the TS shape so existing log/UI scrapers see the same text.
	var firstStr string
	for _, v := range payload {
		if s, ok := v.(string); ok {
			firstStr = s
			break
		}
	}
	action := ""
	if a, _ := bodyMap["action"].(string); a != "" {
		action = " " + a
	}
	desc := fmt.Sprintf("%s %s%s: %s", h.name, eventKey, action, firstStr)

	return payload, desc, nil
}

// decodeJSON is the shared JSON decoder. Returns the raw any so callers
// can type-switch (object vs array vs scalar).
func decodeJSON(body []byte) (any, error) {
	if len(body) == 0 {
		return nil, fmt.Errorf("empty body")
	}
	var v any
	if err := json.Unmarshal(body, &v); err != nil {
		return nil, fmt.Errorf("json: %w", err)
	}
	return v, nil
}

func contains(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}
