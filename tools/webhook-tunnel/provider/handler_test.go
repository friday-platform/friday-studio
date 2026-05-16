package provider

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
	"testing"
)

func TestRawProvider(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("raw")
	if h == nil {
		t.Fatalf("raw provider not registered")
	}
	if err := h.Verify(http.Header{}, []byte(`{}`), nil); err != nil {
		t.Errorf("raw should not require signature: %v", err)
	}
	payload, desc, err := h.Transform(http.Header{}, []byte(`{"foo":"bar","n":42}`))
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload["foo"] != "bar" || payload["n"] != float64(42) {
		t.Errorf("payload mismatch: %v", payload)
	}
	if desc != "Raw webhook forwarded" {
		t.Errorf("desc: %q", desc)
	}
}

func TestGitHubProviderHMAC(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("github")
	if h == nil {
		t.Fatalf("github provider not registered")
	}
	secret := []byte("hello")
	body := []byte(`{"action":"opened","pull_request":{"html_url":"https://github.com/x/y/pull/1"}}`)
	mac := hmac.New(sha256.New, secret)
	mac.Write(body)
	sig := "sha256=" + hex.EncodeToString(mac.Sum(nil))

	headers := http.Header{}
	headers.Set("X-GitHub-Event", "pull_request")
	headers.Set("X-Hub-Signature-256", sig)

	if err := h.Verify(headers, body, secret); err != nil {
		t.Errorf("verify with correct sig should succeed: %v", err)
	}

	// Bad signature
	headers.Set("X-Hub-Signature-256", "sha256=deadbeef")
	if err := h.Verify(headers, body, secret); err == nil {
		t.Errorf("verify with bad sig should fail")
	}

	// Missing header
	headers.Del("X-Hub-Signature-256")
	if err := h.Verify(headers, body, secret); err == nil {
		t.Errorf("verify with missing header should fail")
	}

	// No secret configured = always passes
	headers.Set("X-Hub-Signature-256", "anything")
	if err := h.Verify(headers, body, nil); err != nil {
		t.Errorf("verify without secret should succeed: %v", err)
	}
}

func TestGitHubProviderTransform(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	h := Get("github")

	// Pull request: opened action → mapped, payload extracted.
	body := []byte(`{
		"action": "opened",
		"pull_request": { "html_url": "https://github.com/x/y/pull/1" }
	}`)
	headers := http.Header{}
	headers.Set("X-GitHub-Event", "pull_request")

	payload, desc, err := h.Transform(headers, body)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload["pr_url"] != "https://github.com/x/y/pull/1" {
		t.Errorf("payload: %v", payload)
	}
	if !strings.Contains(desc, "github pull_request opened") {
		t.Errorf("desc: %q", desc)
	}

	// Pull request: closed action → silently skipped (not in actions list).
	bodyClosed := []byte(`{"action":"closed","pull_request":{"html_url":"x"}}`)
	payload, _, err = h.Transform(headers, bodyClosed)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload != nil {
		t.Errorf("expected nil payload for filtered action, got %v", payload)
	}

	// Unknown event header → silently skipped.
	headers.Set("X-GitHub-Event", "deployment")
	payload, _, err = h.Transform(headers, body)
	if err != nil {
		t.Fatalf("transform: %v", err)
	}
	if payload != nil {
		t.Errorf("expected nil payload for unknown event, got %v", payload)
	}
}

// Bitbucket + Jira providers were removed from mappings.yml in 2026-05-15.
// Workspace agents own parsing for those — users register webhooks under
// /hook/raw/{workspaceId}/{signalId} and read the full body via ctx.input.
// If they're ever restored, mirror the TestGitHub* tests above.

func TestList(t *testing.T) {
	if err := Init(); err != nil {
		t.Fatalf("init: %v", err)
	}
	got := List()
	want := []string{"github", "raw"}
	if len(got) != len(want) {
		t.Fatalf("want %v, got %v", want, got)
	}
	for i, w := range want {
		if got[i] != w {
			t.Errorf("List[%d]: want %q, got %q", i, w, got[i])
		}
	}
}
