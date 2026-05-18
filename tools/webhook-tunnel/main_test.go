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

// TestHookForwardsByteForByte locks the load-bearing tunnel property:
// the request that arrives on /hook/raw/{ws}/{sig} reaches atlasd with
// body bytes and headers preserved verbatim — only the URL host + path
// are rewritten. This is what makes downstream HMAC verification work.
func TestHookForwardsByteForByte(t *testing.T) {
	var (
		seenPath string
		seenBody []byte
		seenSig  string
		seenEv   string
		seenCT   string
	)
	atlasd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seenPath = r.URL.Path
		seenBody, _ = io.ReadAll(r.Body)
		seenSig = r.Header.Get("X-Hub-Signature-256")
		seenEv = r.Header.Get("X-GitHub-Event")
		seenCT = r.Header.Get("Content-Type")
		w.WriteHeader(http.StatusAccepted)
		_, _ = w.Write([]byte(`{"status":"accepted","correlationId":"corr-1"}`))
	}))
	defer atlasd.Close()
	base := setupTestServer(t, atlasd.URL)

	// Realistic GitHub pull_request webhook payload + standard headers.
	body := []byte(`{"action":"opened","pull_request":{"number":42,"title":"Add widget"},"repository":{"full_name":"acme/widgets"},"sender":{"login":"alice"}}`)
	req, _ := http.NewRequest(http.MethodPost,
		base+"/hook/raw/ws-1/sig-1", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-GitHub-Event", "pull_request")
	req.Header.Set("X-Hub-Signature-256", "sha256=abcdef0123456789")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusAccepted {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("status %d, body %s", resp.StatusCode, respBody)
	}
	if seenPath != "/api/workspaces/ws-1/signals/sig-1" {
		t.Errorf("atlasd received unexpected path: %s", seenPath)
	}
	// Byte-for-byte body preservation is the core invariant.
	if !bytes.Equal(seenBody, body) {
		t.Errorf("body bytes mismatch\n  want: %s\n  got:  %s", body, seenBody)
	}
	if seenSig != "sha256=abcdef0123456789" {
		t.Errorf("X-Hub-Signature-256 lost or mutated: %q", seenSig)
	}
	if seenEv != "pull_request" {
		t.Errorf("X-GitHub-Event lost or mutated: %q", seenEv)
	}
	if seenCT != "application/json" {
		t.Errorf("Content-Type lost or mutated: %q", seenCT)
	}
}

func TestHookUnknownProvider(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	// The realistic failure mode after PR #354's provider collapse is a
	// caller still POSTing to the pre-PR URLs (/hook/github/, /hook/bitbucket/,
	// /hook/jira/). Each should 400 with a body that names both the
	// invalid provider AND `raw` so the operator sees the migration
	// path. `martian` is a control for arbitrary unknown names.
	for _, providerName := range []string{"github", "bitbucket", "jira", "martian"} {
		t.Run(providerName, func(t *testing.T) {
			resp, err := http.Post(base+"/hook/"+providerName+"/ws/sig",
				"application/json", strings.NewReader(`{}`))
			if err != nil {
				t.Fatalf("post: %v", err)
			}
			defer func() { _ = resp.Body.Close() }()
			if resp.StatusCode != http.StatusBadRequest {
				t.Fatalf("expected 400, got %d", resp.StatusCode)
			}
			body, _ := io.ReadAll(resp.Body)
			s := string(body)
			if !strings.Contains(s, providerName) {
				t.Errorf("response should name the rejected provider %q: %s", providerName, s)
			}
			if !strings.Contains(s, "raw") {
				t.Errorf("response should mention `raw` (the only valid provider): %s", s)
			}
		})
	}
}

func TestHookOversizedRejectedAs413(t *testing.T) {
	base := setupTestServer(t, "http://invalid:0")
	// One byte over the cap.
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
