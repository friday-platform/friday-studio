package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/friday-platform/friday-studio/tools/webhook-tunnel/forwarder"
	"github.com/friday-platform/friday-studio/tools/webhook-tunnel/provider"
)

// setupTestServer starts the same routes main() does, with NO_TUNNEL=true
// semantics (no cloudflared). Caller gets the test-server URL.
func setupTestServer(t *testing.T, atlasdURL string) string {
	t.Helper()
	cfg = &Config{
		AtlasdURL: atlasdURL,
		Port:      0,
		NoTunnel:  true,
	}
	if err := provider.Init(); err != nil {
		t.Fatalf("provider init: %v", err)
	}
	f, err := forwarder.New(atlasdURL, "")
	if err != nil {
		t.Fatalf("forwarder init: %v", err)
	}
	fwd = f
	tunMgr = nil

	srv := httptest.NewServer(newRouter())
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestHealthEndpointShape(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	resp, err := http.Get(base + "/health")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, k := range []string{"status", "service", "tunnelAlive"} {
		if _, ok := got[k]; !ok {
			t.Errorf("missing field %q in /health response: %v", k, got)
		}
	}
	if got["service"] != "webhook-tunnel" {
		t.Errorf("service: %v", got["service"])
	}
}

func TestStatusEndpointHasAllSevenFields(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	resp, err := http.Get(base + "/status")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Locked contract: these keys MUST be present.
	want := []string{"url", "providers", "pattern", "active", "tunnelAlive", "restartCount", "lastProbeAt"}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("missing /status field %q in %v", k, got)
		}
	}
	if got["pattern"] != "/hook/raw/{workspaceId}/{signalId}" {
		t.Errorf("pattern mismatch: %v", got["pattern"])
	}
	if _, ok := got["providers"].([]any); !ok {
		t.Errorf("providers should be array, got %T", got["providers"])
	}
	// `secret` is no longer part of the contract — the tunnel does no HMAC.
	if _, ok := got["secret"]; ok {
		t.Errorf("secret should not appear in /status (tunnel no longer holds an HMAC secret)")
	}
}

func TestHookForwardsRawBody(t *testing.T) {
	var seenPath string
	var seenBody []byte
	atlasd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenBody, _ = io.ReadAll(r.Body)
		_, _ = w.Write([]byte(`{"sessionId":"sess-99"}`))
	}))
	defer atlasd.Close()
	base := setupTestServer(t, atlasd.URL)

	body := []byte(`{"actor":{"name":"alice"},"comment":{"raw":"hi"}}`)
	resp, err := http.Post(base+"/hook/raw/ws-1/sig-1", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d, body %s", resp.StatusCode, respBody)
	}
	var got map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&got)
	if got["status"] != "forwarded" {
		t.Errorf("status: %v", got["status"])
	}
	if got["sessionId"] != "sess-99" {
		t.Errorf("sessionId: %v", got["sessionId"])
	}
	if seenPath != "/api/workspaces/ws-1/signals/sig-1" {
		t.Errorf("atlasd received unexpected path: %s", seenPath)
	}
	// The forwarder wraps the body as {"payload": <body>}; just sanity-check
	// that the actor field survived round-trip.
	if !bytes.Contains(seenBody, []byte("alice")) {
		t.Errorf("body did not reach atlasd intact: %s", seenBody)
	}
}

func TestHookUnknownProvider(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	resp, err := http.Post(base+"/hook/martian/ws/sig",
		"application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", resp.StatusCode)
	}
}

func TestHookOversizedRejectedAs413(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	// 25 MB + 1 byte
	body := bytes.Repeat([]byte("a"), maxBodySize+1)
	req, _ := http.NewRequest(http.MethodPost,
		base+"/hook/raw/ws/sig", bytes.NewReader(body))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", resp.StatusCode)
	}
}

func TestHookRawForwarded(t *testing.T) {
	atlasd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		payload, _ := body["payload"].(map[string]any)
		if payload["foo"] != "bar" {
			t.Errorf("payload: %v", payload)
		}
		_, _ = w.Write([]byte(`{}`))
	}))
	defer atlasd.Close()
	base := setupTestServer(t, atlasd.URL)
	resp, err := http.Post(base+"/hook/raw/w/s",
		"application/json", strings.NewReader(`{"foo":"bar"}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
