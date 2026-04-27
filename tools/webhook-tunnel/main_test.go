package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/tempestteam/atlas/tools/webhook-tunnel/forwarder"
	"github.com/tempestteam/atlas/tools/webhook-tunnel/provider"
)

// setupTestServer starts the same routes main() does, with NO_TUNNEL=true
// semantics (no cloudflared). Caller gets the test-server URL.
func setupTestServer(t *testing.T, atlasdURL string) string {
	t.Helper()
	cfg = &Config{
		AtlasdURL:     atlasdURL,
		WebhookSecret: "test-secret",
		Port:          0,
		NoTunnel:      true,
	}
	if err := provider.Init(); err != nil {
		t.Fatalf("provider init: %v", err)
	}
	fwd = forwarder.New(atlasdURL)
	tunMgr = nil

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", handleHealth)
	mux.HandleFunc("GET /status", handleStatus)
	mux.HandleFunc("OPTIONS /status", handleStatusCORS)
	mux.HandleFunc("GET /{$}", handleRoot)
	mux.HandleFunc("POST /hook/{provider}/{workspaceId}/{signalId}", handleHook)
	platform := wrapMaxBytes(fwd.ProxyHandler())
	mux.Handle("/platform/{provider}", platform)
	mux.Handle("/platform/{provider}/{suffix...}", platform)

	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestHealthEndpointShape(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	resp, err := http.Get(base + "/health")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
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
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	var got map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	// Locked contract: these 8 keys MUST be present (matches TS).
	want := []string{"url", "secret", "providers", "pattern", "active", "tunnelAlive", "restartCount", "lastProbeAt"}
	for _, k := range want {
		if _, ok := got[k]; !ok {
			t.Errorf("missing /status field %q in %v", k, got)
		}
	}
	// Spot-check types.
	if got["pattern"] != "/hook/{provider}/{workspaceId}/{signalId}" {
		t.Errorf("pattern mismatch: %v", got["pattern"])
	}
	if _, ok := got["providers"].([]any); !ok {
		t.Errorf("providers should be array, got %T", got["providers"])
	}
	if got["secret"] != "test-secret" {
		t.Errorf("secret mismatch: %v", got["secret"])
	}
}

func TestHookValidSignature(t *testing.T) {
	atlasd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/workspaces/ws-1/signals/sig-1" {
			t.Errorf("atlasd path: %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"sessionId":"sess-99"}`))
	}))
	defer atlasd.Close()
	base := setupTestServer(t, atlasd.URL)

	body := []byte(`{"action":"opened","pull_request":{"html_url":"https://x/y"}}`)
	mac := hmac.New(sha256.New, []byte("test-secret"))
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	req, _ := http.NewRequest(http.MethodPost,
		base+"/hook/github/ws-1/sig-1", bytes.NewReader(body))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-Hub-Signature-256", sig)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
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
}

func TestHookInvalidSignature(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	body := []byte(`{"action":"opened","pull_request":{"html_url":"x"}}`)
	req, _ := http.NewRequest(http.MethodPost,
		base+"/hook/github/ws/sig", bytes.NewReader(body))
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-Hub-Signature-256", "sha256=deadbeef")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", resp.StatusCode)
	}
}

func TestHookUnknownProvider(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	resp, err := http.Post(base+"/hook/martian/ws/sig",
		"application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
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
	defer resp.Body.Close()
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
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
}
