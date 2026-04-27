package forwarder

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestForwardHappyPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			t.Errorf("method: want POST, got %s", r.Method)
		}
		if r.URL.Path != "/api/workspaces/ws-1/signals/sig-1" {
			t.Errorf("path: %s", r.URL.Path)
		}
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		payload, _ := body["payload"].(map[string]any)
		if payload["foo"] != "bar" {
			t.Errorf("payload missing: %v", payload)
		}
		_, _ = w.Write([]byte(`{"sessionId":"sess-123"}`))
	}))
	defer srv.Close()

	f := New(srv.URL)
	sid, err := f.Forward("ws-1", "sig-1", map[string]any{"foo": "bar"})
	if err != nil {
		t.Fatalf("forward: %v", err)
	}
	if sid != "sess-123" {
		t.Errorf("sessionId: want sess-123, got %q", sid)
	}
}

func TestForwardNon2xx(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`workspace not found`))
	}))
	defer srv.Close()
	f := New(srv.URL)
	_, err := f.Forward("ws", "sig", nil)
	if err == nil {
		t.Fatalf("expected error on 5xx response")
	}
	if !strings.Contains(err.Error(), "atlasd 500") {
		t.Errorf("unexpected error: %v", err)
	}
}

func TestProxyPathRewrite(t *testing.T) {
	var capturedPath string
	var capturedQuery string
	var capturedBody string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		capturedPath = r.URL.Path
		capturedQuery = r.URL.RawQuery
		b, _ := io.ReadAll(r.Body)
		capturedBody = string(b)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	f := New(srv.URL)
	mux := http.NewServeMux()
	mux.Handle("/platform/{provider}", f.ProxyHandler())
	mux.Handle("/platform/{provider}/{suffix...}", f.ProxyHandler())
	clientSrv := httptest.NewServer(mux)
	defer clientSrv.Close()

	// 1. With suffix and query.
	resp, err := http.Post(
		clientSrv.URL+"/platform/telegram/abc-token?hub.challenge=42",
		"application/json", strings.NewReader(`{"ping":1}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	resp.Body.Close()
	if capturedPath != "/signals/telegram/abc-token" {
		t.Errorf("path: want /signals/telegram/abc-token, got %s", capturedPath)
	}
	if capturedQuery != "hub.challenge=42" {
		t.Errorf("query: want hub.challenge=42, got %s", capturedQuery)
	}
	if capturedBody != `{"ping":1}` {
		t.Errorf("body: want {\"ping\":1}, got %s", capturedBody)
	}

	// 2. Without suffix.
	resp, err = http.Post(clientSrv.URL+"/platform/slack", "application/json", strings.NewReader(``))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	resp.Body.Close()
	if capturedPath != "/signals/slack" {
		t.Errorf("path: want /signals/slack, got %s", capturedPath)
	}
}

// TestProxyStripsHopByHop verifies that httputil.ReverseProxy strips
// RFC 7230 hop-by-hop headers — the bug the TS implementation has.
func TestProxyStripsHopByHop(t *testing.T) {
	var got http.Header
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}))
	defer srv.Close()

	f := New(srv.URL)
	mux := http.NewServeMux()
	mux.Handle("/platform/{provider}", f.ProxyHandler())
	clientSrv := httptest.NewServer(mux)
	defer clientSrv.Close()

	req, _ := http.NewRequest(http.MethodPost, clientSrv.URL+"/platform/raw", strings.NewReader(""))
	req.Header.Set("Connection", "keep-alive")
	req.Header.Set("Keep-Alive", "timeout=5")
	req.Header.Set("X-Custom", "preserved")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	resp.Body.Close()

	if got.Get("Connection") != "" {
		t.Errorf("Connection header should be stripped, got %q", got.Get("Connection"))
	}
	if got.Get("Keep-Alive") != "" {
		t.Errorf("Keep-Alive header should be stripped, got %q", got.Get("Keep-Alive"))
	}
	if got.Get("X-Custom") != "preserved" {
		t.Errorf("X-Custom should be preserved, got %q", got.Get("X-Custom"))
	}
}
